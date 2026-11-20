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
// Usage limits (for example the 5-hour limit): with auto continue on, the PM resumes the same session after the reset.
export const RESUME_PROMPT = "The usage limit has reset. Continue the work where you stopped. If you were waiting for my answer, ask again.";
const RESUME_MARGIN_MS = 60 * 1000;
const UNKNOWN_RESET_RETRY_MS = 30 * 60 * 1000;
// Tries in a row that hit the limit again. Without a known reset time it retries every 30 minutes, so 12 tries
// cover six hours: longer than a whole 5-hour window, even when the limit was hit right at its start.
const MAX_RESUME_ATTEMPTS = 12;
const MAX_TIMER_MS = 2 ** 31 - 1;
// A turn cut off by a server stop (or a crash, or the computer shutting down) continues in the same session.
export const RESTART_PROMPT = "The office server restarted while you were working, so your last turn was cut off. " +
  "Check the state (git status, .office/tasks.json) and continue the work where you stopped. Do not redo finished tasks.";
const RESTART_RESUME_DELAY_MS = 20 * 1000;
export const INTERRUPTED_ERROR = "The office server stopped during this turn.";
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|limit will reset|rate[ _-]?limit/i;

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

// "...|1763660400" (older CLI) or "resets 3pm" / "resets 3:30pm" / "resets 15:00": the next reset time in ms, or null.
// A time without a date is the next time the server's clock shows it.
export function parseResetTime(text, now = Date.now()) {
  const value = String(text || "");
  const epoch = value.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const clock = value.match(/resets?\s+(?:at\s+)?(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] || 0);
  const half = (clock[3] || "").toLowerCase();
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

// Finds a reset time (epoch seconds or ms) anywhere in a stream-json message.
function findResetsAt(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  for (const [key, inner] of Object.entries(value)) {
    if ((key === "resetsAt" || key === "resets_at") && Number(inner) > 0) {
      const n = Number(inner);
      return n < 1e12 ? n * 1000 : n;
    }
    const found = findResetsAt(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

// A message waiting for the PM: text is what the PM gets, note what the customer sees (null for the office's own).
function queueItem(value) {
  const item = typeof value === "string" ? { text: value, note: value } : value;
  if (!item || typeof item.text !== "string" || !item.text.trim()) return null;
  return {
    id: item.id || randomUUID(), text: item.text, note: typeof item.note === "string" ? item.note : null,
    at: item.at || new Date().toISOString(),
  };
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
  // record(entry) keeps a message in the department history; getSettings() returns the department settings.
  constructor({
    department, scheduler, getModel, agentSignature = () => "", broadcast,
    record = () => null, getSettings = () => ({}),
  }) {
    this.department = department;
    this.record = record;
    this.getSettings = getSettings;
    this.resumeTimer = null;
    this.limitHit = null;
    this.scheduler = scheduler;
    this.getModel = getModel;
    this.agentSignature = agentSignature;
    this.broadcast = broadcast;
    this.stateFile = path.join(department.workspace, ".office", "runner-state.json");
    this.child = null;
    this.queue = [];
    this.reloadRequested = false;
    this.autoReloads = 0;
    this.activeTurn = null;
    this.pendingPrompt = null;
    this.shuttingDown = false;
    const saved = readJson(this.stateFile, {});
    // Messages waiting for the PM survive a restart (older versions saved plain strings).
    this.queue = (Array.isArray(saved.queue) ? saved.queue : []).map((q) => queueItem(q)).filter(Boolean);
    // A turn still marked active was cut off: the server stopped (or crashed) while the PM worked.
    const cutOff = Boolean(saved.activeTurn && saved.sessionId);
    // A process cannot survive a server restart, so the saved state is never busy.
    this.state = {
      sessionId: saved.sessionId || null,
      origin: saved.origin || null,
      busy: false,
      waitingSlot: false,
      lastError: cutOff ? INTERRUPTED_ERROR : saved.lastError || null,
      costUsd: saved.costUsd || 0,
      limit: saved.limit || null,
      resumeAt: saved.resumeAt || null,
      resumeReason: saved.resumeReason || "limit",
      resumeAttempts: saved.resumeAttempts || 0,
      interrupted: cutOff ? { startedAt: saved.activeTurn.startedAt || null } : saved.interrupted || null,
    };
    // A resume planned before the server stopped still happens (soon after the start when its time has passed).
    if (this.state.resumeAt && this.state.sessionId) this.armResume();
    else this.state.resumeAt = null;
    if (cutOff || (this.queue.length && this.state.sessionId && !this.state.resumeAt)) this.afterRestart(cutOff);
  }

  // Work that was going on when the server stopped: continue it (auto continue on) or tell the customer how.
  afterRestart(cutOff) {
    const waiting = this.queue.filter((q) => q.note).length;
    const queued = waiting ? ` ${waiting} queued message(s) follow after that.` : "";
    if (this.state.resumeAt) {
      this.recordSystem(`The office server stopped during the PM's turn. The PM continues at ${new Date(this.state.resumeAt).toLocaleString()} as planned.${queued}`);
    } else if (this.state.origin === "dashboard" && this.getSettings().autoResume) {
      this.state.resumeAt = Date.now() + RESTART_RESUME_DELAY_MS;
      this.state.resumeReason = "restart";
      this.armResume();
      this.recordSystem(`The office server stopped during the PM's turn. Auto continue is on: the PM continues in a moment.${queued}`, false);
    } else {
      this.recordSystem((cutOff ? "The office server stopped during the PM's turn. " : "") +
        "Send a message (for example \"continue\") and the PM continues where it stopped; nothing is started again by itself." +
        queued);
    }
    this.save();
  }

  // queue: the customer's messages waiting for the PM (internal instructions are not listed).
  publicState() {
    const visible = this.queue.filter((q) => q.note).map(({ id, note, at }) => ({ id, text: note, at }));
    return { ...this.state, queued: visible.length, queue: visible, canSupplement: this.canSupplement() };
  }

  // A message sent while the PM works can join the running turn (like typing in Claude Code mid-turn).
  canSupplement() {
    return Boolean(this.child && this.inputOpen && this.state.origin === "dashboard");
  }

  // Removes a message that is still waiting in the queue.
  removeQueued(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.id !== id || !q.note);
    if (this.queue.length === before) return false;
    this.save();
    return true;
  }

  save() {
    const { sessionId, origin, lastError, costUsd, limit, resumeAt, resumeReason, resumeAttempts, interrupted } = this.state;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        sessionId, origin, lastError, costUsd, limit, resumeAt, resumeReason, resumeAttempts, interrupted,
        // The turn running now (cleared when it ends) and the messages waiting for the PM.
        activeTurn: this.activeTurn, queue: this.queue,
      }, null, 2) + "\n");
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

  // note: what the message history shows for this message (the text itself by default, null for nothing).
  start(request, { plain = false, note } = {}) {
    if (this.shuttingDown) throw new Error("The computer is shutting down. Cancel the shutdown first.");
    if (this.state.busy) throw new Error("The PM is busy. Stop the current turn first.");
    const text = String(request || "").trim();
    if (!text) throw new Error("Request is empty.");
    this.cancelResume();
    this.state.sessionId = randomUUID();
    this.state.origin = "dashboard";
    this.state.costUsd = 0;
    this.state.limit = null;
    this.state.resumeAttempts = 0;
    this.queue = [];
    const message = this.recordCustomer(note === undefined ? text : note);
    // A plain prompt is a self-contained instruction (for example a hire request), not an /office project run.
    this.spawnTurn(plain ? text : `/office ${text}`, { newSession: true });
    return { message };
  }

  recordCustomer(text) {
    return text ? this.record({ kind: "msg", from: "customer", to: "pm", text }) : null;
  }

  recordSystem(text, notice = true) {
    return this.record({ kind: "system", notice, text });
  }

  // mode: "supplement" adds the message to the PM's running turn when it can, "queue" (the default, used by the
  // office's own instructions) waits until the turn ends.
  reply(message, { takeover = false, note, mode = "queue" } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Message is empty.");
    if (this.shuttingDown) throw new Error("The computer is shutting down. Cancel the shutdown first.");
    if (!this.state.sessionId) throw new Error("No run to reply to. Send a request first.");
    if (this.state.origin === "chat" && !takeover) {
      const err = new Error("This run belongs to a chat session. Take it over first, or reply in Claude.");
      err.code = "CHAT_OWNED";
      throw err;
    }
    if (takeover) this.state.origin = "dashboard";
    // A message from the customer takes the place of a planned automatic resume.
    if (note !== null) this.cancelResume();
    const shown = note === undefined ? text : note;
    if (this.state.busy && mode === "supplement" && this.canSupplement()) {
      this.writeInput(text, "next");
      const message = shown ? this.record({ kind: "msg", from: "customer", to: "pm", text: shown, supplement: true }) : null;
      return { queued: false, supplemented: true, message };
    }
    if (this.state.busy) {
      // Recorded when it is sent, so a message removed from the queue never shows as sent.
      this.queue.push(queueItem({ text, note: shown || null }));
      this.save();
      return { queued: true };
    }
    const recorded = this.recordCustomer(shown);
    this.spawnTurn(text, { newSession: false });
    return { queued: false, message: recorded };
  }

  // Sends a user message to the running Claude process (stream-json input).
  writeInput(text, priority) {
    const line = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (priority) line.priority = priority;
    this.child.stdin.write(JSON.stringify(line) + "\n");
  }

  // No more input: the process ends after the turn (and any supplements it already took in).
  closeInput() {
    if (!this.inputOpen) return;
    this.inputOpen = false;
    try { this.child?.stdin.end(); } catch { /* the process is gone */ }
    this.broadcast("runner", this.publicState());
  }

  stop() {
    this.queue = [];
    this.cancelResume();
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

  // The server is stopping: keep what is going on so the next start can continue it.
  shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.resumeTimer);
    if (!this.child && this.state.waitingSlot) {
      // A turn waiting for a run slot never started: its prompt goes back to the front of the queue.
      this.scheduler.cancel(this);
      if (this.pendingPrompt) this.queue.unshift(queueItem({ text: this.pendingPrompt, note: null }));
    }
    this.save();
    if (this.child) this.child.kill();
  }

  // A computer shutdown was cancelled: the server keeps running, so pick the work up as after a restart.
  cancelShutdown() {
    if (!this.shuttingDown) return;
    this.shuttingDown = false;
    const cutOff = Boolean(this.activeTurn);
    const hadSlot = this.state.busy && !this.state.waitingSlot;
    this.activeTurn = null;
    this.child = null;
    this.state.busy = false;
    this.state.waitingSlot = false;
    if (hadSlot) this.scheduler.release(this);
    if (cutOff) {
      this.state.lastError = INTERRUPTED_ERROR;
      this.state.interrupted = { startedAt: null };
    }
    if (this.state.resumeAt) this.armResume();
    if (cutOff || (this.queue.length && this.state.sessionId && !this.state.resumeAt)) this.afterRestart(cutOff);
    else this.save();
  }

  spawnTurn(prompt, { newSession }) {
    this.state.busy = true;
    this.state.lastError = null;
    this.state.interrupted = null;
    this.pendingPrompt = prompt;
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
    // Streaming input keeps stdin open during the turn, so the customer can add to it (see reply, "supplement").
    const args = [
      "-p",
      newSession ? "--session-id" : "--resume", this.state.sessionId,
      "--input-format", "stream-json",
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
    this.activeTurn = { startedAt: new Date().toISOString() };
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
    this.inputOpen = true;
    child.stdin.on("error", () => { this.inputOpen = false; });
    this.writeInput(prompt);
    this.broadcast("runner", this.publicState());

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
      lines.forEach((line) => {
        if (!this.handleLine(line)) return;
        gotResult = true;
        // The turn is over unless supplements it took in still wait for their own turn.
        if (!(this.queuedTurns > 0)) this.closeInput();
      });
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
    // Usage limits: the CLI sends a rate_limit_event, and the refused request comes back as an error message.
    if (msg.type === "rate_limit_event" && msg.rate_limit_info && msg.rate_limit_info.status === "rejected") {
      this.noteLimit(findResetsAt(msg.rate_limit_info), msg.rate_limit_info.rateLimitType);
    }
    if (msg.type === "assistant" && (msg.error === "rate_limit" || msg.message?.error === "rate_limit")) {
      const info = msg.api_error_params?.rate_limit_info || msg.apiErrorParams?.rate_limit_info || {};
      this.noteLimit(findResetsAt(msg), info.rateLimitType);
    }
    if (msg.type === "assistant" && msg.message && !msg.parent_tool_use_id) {
      const text = (msg.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n")
        .replace(RELOAD_MARKER, "").trim();
      if (text) this.broadcast("pm-text", { text });
    }
    if (msg.type === "result") {
      if (typeof msg.total_cost_usd === "number") this.state.costUsd += msg.total_cost_usd;
      this.queuedTurns = Number(msg.queued_turn_count) || 0;
      if (msg.is_error) this.resultError = String(msg.result || msg.subtype || "Unknown error");
      const result = String(msg.result || "");
      if (msg.is_error && LIMIT_TEXT.test(result)) this.noteLimit(parseResetTime(result));
      const replyText = result.replace(RELOAD_MARKER, "").trim();
      if (!msg.is_error && replyText) this.record({ kind: "msg", from: "pm", to: "customer", text: replyText });
      if (!msg.is_error && result.includes(RELOAD_MARKER)) this.reloadRequested = true;
      this.broadcast("pm-reply", {
        text: result.replace(RELOAD_MARKER, "").trim(), isError: Boolean(msg.is_error), subtype: msg.subtype,
        costUsd: this.state.costUsd,
      });
      return true;
    }
    return false;
  }

  // The first reset time seen wins: the rate_limit_event comes first and is exact, the text only names a clock time.
  noteLimit(resetsAt, type) {
    this.limitHit = {
      resetsAt: this.limitHit?.resetsAt || resetsAt || null,
      type: this.limitHit?.type || type || null,
    };
  }

  // ---------- automatic resume after a usage limit ----------

  armResume() {
    clearTimeout(this.resumeTimer);
    const delay = Math.min(MAX_TIMER_MS, Math.max(5000, this.state.resumeAt - Date.now()));
    this.resumeTimer = setTimeout(() => this.resumeNow(), delay);
    this.resumeTimer.unref?.();
  }

  // Plans the resume for the current limit when the setting is on. Returns true when a resume is planned.
  planResume() {
    const limit = this.state.limit;
    if (!limit || !this.state.sessionId || this.state.origin !== "dashboard" || !this.getSettings().autoResume) return false;
    if (this.state.resumeAttempts >= MAX_RESUME_ATTEMPTS) return false;
    const now = Date.now();
    // Without a known reset time (or when it has passed but the limit is still there), try again later.
    const base = limit.resetsAt && limit.resetsAt > now ? limit.resetsAt : now + UNKNOWN_RESET_RETRY_MS;
    this.state.resumeAt = base + RESUME_MARGIN_MS;
    this.state.resumeReason = "limit";
    this.armResume();
    return true;
  }

  cancelResume() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.state.resumeAt) {
      this.state.resumeAt = null;
      this.save();
    }
  }

  resumeNow() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.state.resumeAt = null;
    if (this.state.busy || !this.state.sessionId || !this.getSettings().autoResume) {
      this.save();
      return false;
    }
    this.state.resumeAttempts += 1;
    const restart = this.state.resumeReason === "restart";
    this.state.resumeReason = "limit";
    this.recordSystem(restart ? "The PM continues the turn the server stop cut off." : "The usage limit has reset: the PM continues automatically.", false);
    this.spawnTurn(restart ? RESTART_PROMPT : RESUME_PROMPT, { newSession: false });
    return true;
  }

  // The customer turned auto continue on or off in the department settings.
  settingsChanged() {
    if (!this.getSettings().autoResume) return this.cancelResume();
    if (!this.state.busy && !this.state.resumeAt && this.state.limit && this.state.lastError) {
      this.state.resumeAttempts = 0;
      if (this.planResume()) {
        this.save();
        this.recordSystem(`Auto continue is on: the PM continues at ${new Date(this.state.resumeAt).toLocaleString()}.`, false);
      }
    }
  }

  finish(processError) {
    this.inputOpen = false;
    // Stopping the server: the saved state already says this turn was cut off, so leave it as it is.
    if (this.shuttingDown) {
      this.child = null;
      return;
    }
    this.activeTurn = null;
    const error = processError || this.resultError || null;
    const limit = error && this.limitHit ? { ...this.limitHit, at: Date.now() } : null;
    this.limitHit = null;
    this.child = null;
    this.state.busy = false;
    this.state.waitingSlot = false;
    this.state.lastError = error;
    this.state.limit = limit;
    if (!error) this.state.resumeAttempts = 0;
    const resuming = Boolean(limit) && this.planResume();
    this.save();
    this.broadcast("pm-turn", { status: "ended", error, limit, resumeAt: this.state.resumeAt });
    if (limit) {
      const reset = limit.resetsAt ? new Date(limit.resetsAt).toLocaleString() : "an unknown time";
      this.recordSystem(resuming
        ? `Usage limit reached (resets ${reset}). Auto continue is on: the PM continues at ${new Date(this.state.resumeAt).toLocaleString()}.`
        : `Usage limit reached (resets ${reset}). Send a message after the reset, or turn on auto continue in the department settings.`);
    } else if (error) {
      this.recordSystem(`The PM stopped: ${error.slice(0, 300)}`);
    }
    // A turn that created new agents asks for a restart: continue automatically (a few times at most),
    // but only when agent files really changed, so a failed write cannot loop.
    const agentsChanged = this.reloadRequested && this.agentSignature() !== this.agentsAtStart;
    if (!error && agentsChanged && !this.queue.length && this.autoReloads < MAX_AUTO_RELOADS) {
      this.autoReloads += 1;
      this.queue.push(queueItem({ text: "The new agent files are loaded now. Continue.", note: null }));
    } else if (!this.reloadRequested) {
      this.autoReloads = 0;
    } else if (!agentsChanged) {
      this.broadcast("pm-turn", { status: "note", text: "The PM asked to reload the team, but no agent file changed." });
      this.recordSystem("The PM asked to reload the team, but no agent file changed.", false);
    }
    this.reloadRequested = false;
    const next = !error && this.queue.length ? this.queue.shift() : null;
    if (next?.note) this.recordCustomer(next.note);
    // Messages queued before a usage limit wait for the automatic resume.
    if (error && !resuming) this.queue = [];
    this.scheduler.release(this);
    if (next) this.spawnTurn(next.text, { newSession: false });
  }
}
