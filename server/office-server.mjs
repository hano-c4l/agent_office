// Agent Office local server: serves the dashboard, the staff API (HR) and a live event stream.
// Usage: node server/office-server.mjs [port]   (binds to 127.0.0.1 only)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, OFFICE_DIR, AGENTS_DIR, META_FILE,
  listStaff, saveStaff, dismissStaff, ensureAllSkills, isValidId,
} from "./staff-store.mjs";
import { RunController } from "./run-controller.mjs";

const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const EVENTS_FILE = path.join(OFFICE_DIR, "events.jsonl");
const TASKS_FILE = path.join(OFFICE_DIR, "tasks.json");
const PROPOSAL_FILE = path.join(OFFICE_DIR, "proposal.json");
const RUN_FILE = path.join(OFFICE_DIR, "active-run.json");
const REPLAY_EVENTS = 300;
const MAX_BODY = 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon",
};

// ---------- helpers ----------

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function readRecentEvents(limit) {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function snapshot() {
  return {
    staff: listStaff(),
    tasks: readJson(TASKS_FILE, { tasks: [] }),
    proposal: readJson(PROPOSAL_FILE, null),
    run: readJson(RUN_FILE, null),
    runner: runner.publicState(),
  };
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

// ---------- live stream (SSE) ----------

const clients = new Set();
const runner = new RunController((type, data) => broadcast(type, data));

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(payload));
}

function openStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot(), events: readRecentEvents(REPLAY_EVENTS) })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

// Poll files instead of fs.watch: polling behaves the same on Windows, macOS and Linux.
let eventsOffset = fs.existsSync(EVENTS_FILE) ? fs.statSync(EVENTS_FILE).size : 0;
let partialLine = "";
const mtimes = {};

function changed(file) {
  let m = 0;
  try { m = fs.statSync(file).mtimeMs; } catch { /* missing file */ }
  if (mtimes[file] === m) return false;
  const first = mtimes[file] === undefined;
  mtimes[file] = m;
  return !first;
}

function agentsChanged() {
  let sig = "";
  try {
    sig = fs.readdirSync(AGENTS_DIR).map((f) => f + fs.statSync(path.join(AGENTS_DIR, f)).mtimeMs).join("|");
  } catch { /* no agents dir */ }
  try { sig += "|" + fs.statSync(META_FILE).mtimeMs; } catch { /* no meta */ }
  if (mtimes.agents === sig) return false;
  const first = mtimes.agents === undefined;
  mtimes.agents = sig;
  return !first;
}

function pollFiles() {
  try {
    const size = fs.existsSync(EVENTS_FILE) ? fs.statSync(EVENTS_FILE).size : 0;
    if (size < eventsOffset) eventsOffset = 0; // log was rotated
    if (size > eventsOffset) {
      const fd = fs.openSync(EVENTS_FILE, "r");
      const buf = Buffer.alloc(size - eventsOffset);
      fs.readSync(fd, buf, 0, buf.length, eventsOffset);
      fs.closeSync(fd);
      eventsOffset = size;
      const text = partialLine + buf.toString("utf8");
      const lines = text.split("\n");
      partialLine = lines.pop();
      lines.filter(Boolean).forEach((line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        // An /office run started in a chat session: remember it so the dashboard can take it over.
        if (ev.hook === "UserPromptSubmit" && /^\/office/.test(ev.text || "")) runner.noteChatSession(ev.session);
        broadcast("office-event", ev);
      });
    }
  } catch (err) {
    console.warn("Event poll failed:", err.message);
  }
  if (changed(TASKS_FILE)) broadcast("tasks", readJson(TASKS_FILE, { tasks: [] }));
  if (changed(PROPOSAL_FILE)) broadcast("proposal", readJson(PROPOSAL_FILE, null));
  if (changed(RUN_FILE)) broadcast("run", readJson(RUN_FILE, null));
  if (agentsChanged()) broadcast("staff", listStaff());
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const [, , resource, id] = url.pathname.split("/");

  if (resource === "stream" && req.method === "GET") return openStream(req, res);
  if (resource === "state" && req.method === "GET") return send(res, 200, snapshot());

  if (resource === "staff") {
    if (req.method === "GET" && !id) return send(res, 200, listStaff());
    if (!isValidId(id)) return send(res, 400, { error: "Invalid agent id" });
    if (req.method === "PUT") {
      const body = await readBody(req);
      return send(res, 200, saveStaff({ ...body, id }));
    }
    if (req.method === "DELETE") {
      return dismissStaff(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
    }
  }

  if (resource === "proposal") {
    if (req.method === "GET") return send(res, 200, readJson(PROPOSAL_FILE, null));
    if (req.method === "PUT") {
      const current = readJson(PROPOSAL_FILE, null);
      if (!current) return send(res, 404, { error: "No proposal" });
      const body = await readBody(req);
      const next = { ...current, members: body.members || current.members, status: body.status || current.status };
      if (next.status === "approved") {
        next.approvedAt = new Date().toISOString();
        // Hire roles that do not have an agent file yet.
        const existing = new Set(listStaff().map((a) => a.id));
        next.members.filter((m) => m.included !== false && !existing.has(m.id) && isValidId(m.id))
          .forEach((m) => saveStaff(m));
      }
      writeJson(PROPOSAL_FILE, next);
      // For a run driven by the dashboard, tell the PM right away.
      if (next.status === "approved" && body.status === "approved" && runner.state.origin === "dashboard") {
        runner.reply("I approved the team on the dashboard (office/proposal.json). Please continue with the plan.");
      }
      return send(res, 200, next);
    }
  }

  if (resource === "run" && req.method === "POST") {
    const body = await readBody(req);
    try {
      if (id === "start") { runner.start(body.request); return send(res, 200, runner.publicState()); }
      if (id === "reply") return send(res, 200, { ...runner.reply(body.text, { takeover: Boolean(body.takeover) }), ...runner.publicState() });
      if (id === "stop") { runner.stop(); return send(res, 200, runner.publicState()); }
    } catch (err) {
      return send(res, 409, { error: err.message, code: err.code });
    }
  }

  return send(res, 404, { error: "Unknown API route" });
}

function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.resolve(DASHBOARD_DIR, "." + rel);
  if (!file.startsWith(DASHBOARD_DIR + path.sep)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

ensureAllSkills();
pollFiles();
setInterval(pollFiles, 500);
setInterval(() => clients.forEach((res) => res.write(": ping\n\n")), 20000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Office dashboard: http://localhost:${PORT}`);
});
