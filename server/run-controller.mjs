// Runs the PM through the Claude CLI in print mode so the dashboard can start a project,
// reply to the PM and approve the team. One Claude process at a time; messages sent while the
// PM is busy are queued and delivered when the current turn ends.
//
// Settings live in office/runner.json (CLI path, permission mode, allowed tools).
// Anything not in allowedTools is denied automatically, because nobody can answer a permission
// prompt in print mode.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, OFFICE_DIR } from "./staff-store.mjs";

const CONFIG_FILE = path.join(OFFICE_DIR, "runner.json");
const STATE_FILE = path.join(OFFICE_DIR, "runner-state.json");
const MAX_STDERR = 4000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function resolveClaudePath(configured) {
  if (configured) return configured;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const local = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(local) ? local : "claude";
}

export class RunController {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.child = null;
    this.queue = [];
    const saved = readJson(STATE_FILE, {});
    // A process cannot survive a server restart, so the saved state is never busy.
    this.state = {
      sessionId: saved.sessionId || null,
      origin: saved.origin || null,
      busy: false,
      lastError: saved.lastError || null,
      costUsd: saved.costUsd || 0,
    };
  }

  config() {
    const cfg = readJson(CONFIG_FILE, {});
    return {
      claudePath: resolveClaudePath(cfg.claudePath),
      permissionMode: cfg.permissionMode || "acceptEdits",
      allowedTools: Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [],
      maxTurns: cfg.maxTurns || 200,
    };
  }

  publicState() {
    return { ...this.state, queued: this.queue.length };
  }

  save() {
    const { sessionId, origin, lastError, costUsd } = this.state;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionId, origin, lastError, costUsd }, null, 2) + "\n");
    this.broadcast("runner", this.publicState());
  }

  // A run started from a chat session: the dashboard may take it over later.
  noteChatSession(sessionId) {
    if (!sessionId || sessionId === this.state.sessionId || this.state.busy) return;
    this.state.sessionId = sessionId;
    this.state.origin = "chat";
    this.save();
  }

  start(request) {
    if (this.state.busy) throw new Error("The PM is busy. Stop the current turn first.");
    const text = String(request || "").trim();
    if (!text) throw new Error("Request is empty.");
    this.state.sessionId = randomUUID();
    this.state.origin = "dashboard";
    this.state.costUsd = 0;
    this.queue = [];
    this.spawnTurn(`/office ${text}`, { newSession: true });
  }

  reply(message, { takeover = false } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Message is empty.");
    if (!this.state.sessionId) throw new Error("No run to reply to. Send a request first.");
    if (this.state.origin === "chat" && !takeover) {
      const err = new Error("This run belongs to a chat session. Take it over first, or reply in Claude.");
      err.code = "CHAT_OWNED";
      throw err;
    }
    if (takeover) this.state.origin = "dashboard";
    if (this.state.busy) {
      this.queue.push(text);
      this.save();
      return { queued: true };
    }
    this.spawnTurn(text, { newSession: false });
    return { queued: false };
  }

  stop() {
    this.queue = [];
    if (this.child) this.child.kill();
  }

  spawnTurn(prompt, { newSession }) {
    const cfg = this.config();
    const args = [
      "-p", prompt,
      newSession ? "--session-id" : "--resume", this.state.sessionId,
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", cfg.permissionMode,
      "--permission-prompts", "none",
      "--max-turns", String(cfg.maxTurns),
    ];
    if (cfg.allowedTools.length) args.push("--allowedTools", ...cfg.allowedTools);

    this.state.busy = true;
    this.state.lastError = null;
    this.resultError = null;
    this.save();
    this.broadcast("pm-turn", { status: "started", prompt });

    let child;
    try {
      child = spawn(cfg.claudePath, args, { cwd: ROOT, windowsHide: true, env: process.env });
    } catch (err) {
      this.finish(`Could not start Claude CLI: ${err.message}`);
      return;
    }
    this.child = child;
    child.stdin.end();

    let buffer = "";
    let stderr = "";
    let gotResult = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach((line) => { if (this.handleLine(line)) gotResult = true; });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_STDERR); });
    child.on("error", (err) => this.finish(`Claude CLI error: ${err.message}`));
    child.on("close", (code, signal) => {
      if (buffer && this.handleLine(buffer)) gotResult = true;
      if (signal) return this.finish("Stopped from the dashboard.");
      if (code !== 0 && !gotResult) return this.finish(stderr.trim() || `Claude CLI exited with code ${code}`);
      this.finish(null);
    });
  }

  // Returns true when the line is the final result of the turn.
  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    if (msg.type === "assistant" && msg.message && !msg.parent_tool_use_id) {
      const text = (msg.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) this.broadcast("pm-text", { text });
    }
    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") this.state.costUsd += msg.total_cost_usd;
      if (msg.is_error) this.resultError = String(msg.result || msg.subtype || "Unknown error");
      this.broadcast("pm-reply", {
        text: msg.result || "", isError: Boolean(msg.is_error), subtype: msg.subtype, costUsd: this.state.costUsd,
      });
      return true;
    }
    return false;
  }

  finish(processError) {
    const error = processError || this.resultError || null;
    this.child = null;
    this.state.busy = false;
    this.state.lastError = error;
    this.save();
    this.broadcast("pm-turn", { status: "ended", error });
    if (!error && this.queue.length) {
      this.spawnTurn(this.queue.shift(), { newSession: false });
    } else if (error) {
      this.queue = [];
    }
  }
}
