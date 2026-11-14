// Runs a department's PM through the Claude CLI in print mode so the dashboard can start a project,
// reply to the PM and approve the team. One Claude process per department; messages sent while the
// PM is busy are queued. A shared Scheduler caps how many departments run at the same time.
//
// Settings live in office/runner.json (CLI path, permission mode, allowed and denied tools, parallel runs).
// Anything not in allowedTools is denied automatically, because nobody can answer a permission
// prompt in print mode.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFFICE_DIR, TEMPLATES_DIR } from "./paths.mjs";

const CONFIG_FILE = path.join(OFFICE_DIR, "runner.json");
const MAX_STDERR = 4000;
// The PM ends a turn with this marker after writing new agent files; the next turn loads them.
const RELOAD_MARKER = "[[office:reload]]";
const MAX_AUTO_RELOADS = 3;

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

export function runnerConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  return {
    claudePath: resolveClaudePath(cfg.claudePath),
    permissionMode: cfg.permissionMode || "acceptEdits",
    allowedTools: Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [],
    disallowedTools: Array.isArray(cfg.disallowedTools) ? cfg.disallowedTools : [],
    maxTurns: cfg.maxTurns || 200,
    maxParallelRuns: Math.max(1, Number(cfg.maxParallelRuns) || 2),
  };
}

// Limits the number of Claude processes running at once across all departments.
export class Scheduler {
  constructor() {
    this.running = new Set();
    this.waiting = [];
  }

  acquire(owner, start) {
    if (this.running.size < runnerConfig().maxParallelRuns) {
      this.running.add(owner);
      start();
      return true;
    }
    this.waiting.push({ owner, start });
    return false;
  }

  release(owner) {
    this.running.delete(owner);
    while (this.waiting.length && this.running.size < runnerConfig().maxParallelRuns) {
      const next = this.waiting.shift();
      this.running.add(next.owner);
      next.start();
    }
  }

  cancel(owner) {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.owner !== owner);
    return before !== this.waiting.length;
  }
}

export class RunController {
  // department: { id, workspace }, getModel(): the PM model, broadcast(type, data)
  constructor({ department, scheduler, getModel, agentSignature = () => "", broadcast }) {
    this.department = department;
    this.scheduler = scheduler;
    this.getModel = getModel;
    this.agentSignature = agentSignature;
    this.broadcast = broadcast;
    this.stateFile = path.join(department.workspace, ".office", "runner-state.json");
    this.child = null;
    this.queue = [];
    this.reloadRequested = false;
    this.autoReloads = 0;
    const saved = readJson(this.stateFile, {});
    // A process cannot survive a server restart, so the saved state is never busy.
    this.state = {
      sessionId: saved.sessionId || null,
      origin: saved.origin || null,
      busy: false,
      waitingSlot: false,
      lastError: saved.lastError || null,
      costUsd: saved.costUsd || 0,
    };
  }

  publicState() {
    return { ...this.state, queued: this.queue.length };
  }

  save() {
    const { sessionId, origin, lastError, costUsd } = this.state;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ sessionId, origin, lastError, costUsd }, null, 2) + "\n");
    } catch (err) {
      console.warn(`Could not save runner state for ${this.department.id}: ${err.message}`);
    }
    this.broadcast("runner", this.publicState());
  }

  // A run started from a chat session: the dashboard may take it over later.
  noteChatSession(sessionId) {
    if (!sessionId || sessionId === this.state.sessionId || this.state.busy) return;
    this.state.sessionId = sessionId;
    this.state.origin = "chat";
    this.save();
  }

  start(request, { plain = false } = {}) {
    if (this.state.busy) throw new Error("The PM is busy. Stop the current turn first.");
    const text = String(request || "").trim();
    if (!text) throw new Error("Request is empty.");
    this.state.sessionId = randomUUID();
    this.state.origin = "dashboard";
    this.state.costUsd = 0;
    this.queue = [];
    // A plain prompt is a self-contained instruction (for example a hire request), not an /office project run.
    this.spawnTurn(plain ? text : `/office ${text}`, { newSession: true });
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
    if (this.child) {
      this.child.kill();
    } else if (this.state.waitingSlot && this.scheduler.cancel(this)) {
      this.state.busy = false;
      this.state.waitingSlot = false;
      this.state.lastError = "Stopped from the dashboard.";
      this.save();
      this.broadcast("pm-turn", { status: "ended", error: this.state.lastError });
    }
  }

  spawnTurn(prompt, { newSession }) {
    this.state.busy = true;
    this.state.lastError = null;
    this.resultError = null;
    const started = this.scheduler.acquire(this, () => {
      this.state.waitingSlot = false;
      this.launch(prompt, { newSession });
    });
    if (!started) {
      this.state.waitingSlot = true;
      this.save();
      this.broadcast("pm-turn", { status: "waiting", prompt });
    }
  }

  launch(prompt, { newSession }) {
    const cfg = runnerConfig();
    const args = [
      "-p", prompt,
      newSession ? "--session-id" : "--resume", this.state.sessionId,
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", cfg.permissionMode,
      "--permission-prompts", "none",
      "--max-turns", String(cfg.maxTurns),
    ];
    const model = this.getModel();
    if (model && model !== "inherit") args.push("--model", model);
    // The company role catalog is read in place, not copied into the workspace.
    args.push("--add-dir", TEMPLATES_DIR);
    if (cfg.allowedTools.length) args.push("--allowedTools", ...cfg.allowedTools);
    if (cfg.disallowedTools.length) args.push("--disallowedTools", ...cfg.disallowedTools);

    this.agentsAtStart = this.agentSignature();
    this.save();
    this.broadcast("pm-turn", { status: "started", prompt });

    let child;
    try {
      child = spawn(cfg.claudePath, args, { cwd: this.department.workspace, windowsHide: true, env: process.env });
    } catch (err) {
      this.finish(`Could not start Claude CLI: ${err.message}`);
      return;
    }
    this.child = child;
    child.stdin.end();

    let buffer = "";
    let stderr = "";
    let gotResult = false;
    let finished = false;
    const done = (error) => {
      if (finished) return;
      finished = true;
      this.finish(error);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach((line) => { if (this.handleLine(line)) gotResult = true; });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_STDERR); });
    child.on("error", (err) => done(`Claude CLI error: ${err.message}`));
    child.on("close", (code, signal) => {
      if (buffer && this.handleLine(buffer)) gotResult = true;
      if (signal) return done("Stopped from the dashboard.");
      if (code !== 0 && !gotResult) return done(stderr.trim() || `Claude CLI exited with code ${code}`);
      done(null);
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
      const text = (msg.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n")
        .replace(RELOAD_MARKER, "").trim();
      if (text) this.broadcast("pm-text", { text });
    }
    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") this.state.costUsd += msg.total_cost_usd;
      if (msg.is_error) this.resultError = String(msg.result || msg.subtype || "Unknown error");
      const result = String(msg.result || "");
      if (!msg.is_error && result.includes(RELOAD_MARKER)) this.reloadRequested = true;
      this.broadcast("pm-reply", {
        text: result.replace(RELOAD_MARKER, "").trim(), isError: Boolean(msg.is_error), subtype: msg.subtype,
        costUsd: this.state.costUsd,
      });
      return true;
    }
    return false;
  }

  finish(processError) {
    const error = processError || this.resultError || null;
    this.child = null;
    this.state.busy = false;
    this.state.waitingSlot = false;
    this.state.lastError = error;
    this.save();
    this.broadcast("pm-turn", { status: "ended", error });
    // A turn that created new agents asks for a restart: continue automatically (a few times at most),
    // but only when agent files really changed, so a failed write cannot loop.
    const agentsChanged = this.reloadRequested && this.agentSignature() !== this.agentsAtStart;
    if (!error && agentsChanged && !this.queue.length && this.autoReloads < MAX_AUTO_RELOADS) {
      this.autoReloads += 1;
      this.queue.push("The new agent files are loaded now. Continue.");
    } else if (!this.reloadRequested) {
      this.autoReloads = 0;
    } else if (!agentsChanged) {
      this.broadcast("pm-turn", { status: "note", text: "The PM asked to reload the team, but no agent file changed." });
    }
    this.reloadRequested = false;
    const next = !error && this.queue.length ? this.queue.shift() : null;
    if (error) this.queue = [];
    this.scheduler.release(this);
    if (next) this.spawnTurn(next, { newSession: false });
  }
}
