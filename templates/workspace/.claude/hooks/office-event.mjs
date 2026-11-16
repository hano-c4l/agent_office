// Claude Code hook (installed by Agent Office): turns hook input into a small office event and appends it
// to .office/events.jsonl in this workspace. The Agent Office server streams this file to the dashboard.
// This script must never block or fail a session.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CLAUDE_PROJECT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVENTS_FILE = path.join(ROOT, ".office", "events.jsonl");
const MAX_TEXT = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const clip = (value, max = MAX_TEXT) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

const relative = (file) => {
  if (!file) return undefined;
  const rel = path.relative(ROOT, String(file));
  return (rel && !rel.startsWith("..") ? rel : String(file)).replace(/\\/g, "/");
};

function describeTool(name, input = {}) {
  switch (name) {
    case "Agent":
    case "Task":
      return { target: input.subagent_type || "general-purpose", text: clip(input.description || input.prompt, 200) };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { file: relative(input.file_path || input.notebook_path) };
    case "Read":
      return { detail: relative(input.file_path) };
    case "Bash":
    case "PowerShell":
      return { detail: clip(input.description || input.command, 120) };
    case "Grep":
    case "Glob":
      return { detail: clip(input.pattern, 80) };
    case "WebSearch":
      return { detail: clip(input.query, 80) };
    case "WebFetch":
      return { detail: clip(input.url, 120) };
    case "Skill":
      return { detail: clip(input.skill || input.name, 80) };
    default:
      return {};
  }
}

function toEvent(input) {
  const hook = input.hook_event_name;
  const event = {
    ts: new Date().toISOString(),
    hook,
    session: input.session_id,
    agent: input.agent_type || "main",
    agentId: input.agent_id,
  };
  switch (hook) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return { ...event, tool: input.tool_name, ...describeTool(input.tool_name, input.tool_input) };
    case "SubagentStart":
      return event;
    case "SubagentStop":
      return { ...event, text: clip(input.last_assistant_message) };
    case "UserPromptSubmit":
      return { ...event, text: clip(input.prompt) };
    case "Stop":
      return { ...event, text: clip(input.last_assistant_message) };
    case "Notification":
      return { ...event, detail: input.notification_type, text: clip(input.message) };
    default:
      return event;
  }
}

function main(raw) {
  try {
    const input = JSON.parse(raw || "{}");
    if (!input.hook_event_name) return;
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    // Start a fresh log when it grows too large.
    if (fs.existsSync(EVENTS_FILE) && fs.statSync(EVENTS_FILE).size > MAX_FILE_BYTES) {
      fs.renameSync(EVENTS_FILE, EVENTS_FILE + ".old");
    }
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(toEvent(input)) + "\n");
  } catch (err) {
    process.stderr.write(`office-event hook skipped: ${err.message}\n`);
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => { main(raw); process.exit(0); });
