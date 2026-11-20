// Agent Office local server: serves the company dashboard, the department API (create, HR, team proposal,
// PM runs, release) and a live event stream for all departments.
// Usage: node server/office-server.mjs [port]   (binds to 127.0.0.1 only)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_DIR, OFFICE_DIR } from "./paths.mjs";
import { isValidId, roleCatalog } from "./staff-store.mjs";
import { listFolders, inspectFolder } from "./workspace-setup.mjs";
import { Scheduler, runnerConfig } from "./run-controller.mjs";
import { Company } from "./departments.mjs";
import { checkRequest, normalizeHosts } from "./http-guard.mjs";
import { runShutdownCommand, SHUTDOWN_DELAY_S } from "./system-control.mjs";

const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const MAX_BODY = 1024 * 1024;

// Host names allowed besides localhost: "allowedHosts" in office/server.json plus the ALLOWED_HOSTS variable (comma separated).
function loadAllowedHosts() {
  let fromFile = [];
  try {
    fromFile = JSON.parse(fs.readFileSync(path.join(OFFICE_DIR, "server.json"), "utf8")).allowedHosts;
  } catch { /* no file or unreadable: only localhost */ }
  return normalizeHosts([...(Array.isArray(fromFile) ? fromFile : []), ...String(process.env.ALLOWED_HOSTS || "").split(",")]);
}
const ALLOWED_HOSTS = loadAllowedHosts();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon",
};

// ---------- helpers ----------

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

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(payload));
}

const company = new Company({ scheduler: new Scheduler(), broadcast });

// A computer shutdown requested from the dashboard: { at, dryRun } until it happens or is cancelled.
let shutdownState = null;

function snapshot() {
  const cfg = runnerConfig();
  return {
    system: { shutdown: shutdownState, platform: process.platform },
    defaults: company.defaults(),
    maxParallelRuns: cfg.maxParallelRuns,
    library: roleCatalog(),
    departments: company.list().map((d) => d.snapshot()),
  };
}

// Behind a proxy or tunnel (Cloudflare Tunnel), the stream must not be compressed or buffered, or events
// only arrive in large batches or never: no-transform stops compression, X-Accel-Buffering stops buffering,
// and a padding comment pushes the first bytes through proxies that wait for a minimum size.
const STREAM_PADDING = `: ${" ".repeat(2048)}\n\n`;
const STREAM_PING_MS = 15000;

function openStream(req, res) {
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // The browser reconnects after this many milliseconds when the stream drops.
  res.write(`retry: 3000\n${STREAM_PADDING}`);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

// ---------- routes ----------

async function handleDepartment(req, res, dept, parts) {
  const [section, sub] = parts;

  if (!section && req.method === "DELETE") return send(res, 200, { ok: company.remove(dept.id) });
  if (!section && req.method === "GET") return send(res, 200, dept.snapshot());

  // Hire by hand: creates the agent only now, when the customer confirms the form.
  if (section === "staff" && !sub && req.method === "POST") {
    const body = await readBody(req);
    if (!isValidId(body.id)) return send(res, 400, { error: "Agent id must use lowercase letters, digits, _ or -." });
    if (dept.store.has(body.id) || dept.store.get(body.id)) return send(res, 409, { error: `An agent with id "${body.id}" already exists.` });
    return send(res, 200, dept.store.save(body));
  }

  // Hire with the PM: the PM designs the role and answers with a hire proposal.
  if (section === "hire" && req.method === "POST") {
    const body = await readBody(req);
    return send(res, 200, { ...dept.requestHire(body.description, body.model), ...dept.runner.publicState() });
  }

  if (section === "staff") {
    if (!isValidId(sub)) return send(res, 400, { error: "Invalid agent id" });
    const action = parts[2];
    if (req.method === "POST" && action === "randomize") {
      const agent = dept.store.randomize(sub);
      return agent ? send(res, 200, agent) : send(res, 404, { error: "Not found" });
    }
    if (req.method === "POST" && action === "desk") {
      const body = await readBody(req);
      const agent = dept.store.randomizeDesk(sub, body.deskSeed);
      return agent ? send(res, 200, agent) : send(res, 404, { error: "Not found" });
    }
    if (req.method === "POST" && action === "helper") {
      const body = await readBody(req);
      dept.store.setHelper(sub, Boolean(body.helper));
      return send(res, 200, { staff: dept.store.list(), helpers: dept.store.helpers() });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      return send(res, 200, dept.store.save({ ...body, id: sub }));
    }
    if (req.method === "DELETE") {
      if (sub === "pm") return send(res, 400, { error: "The PM leads the department and cannot be dismissed." });
      return dept.store.dismiss(sub) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Not found" });
    }
  }

  if (section === "proposal" && req.method === "PUT") {
    return send(res, 200, dept.updateProposal(await readBody(req)));
  }

  if (section === "run" && req.method === "POST") {
    const body = await readBody(req);
    const runner = dept.runner;
    if (sub === "start") { const started = runner.start(body.request); return send(res, 200, { ...runner.publicState(), ...started }); }
    if (sub === "reply") {
      const mode = body.mode === "queue" ? "queue" : "supplement";
      return send(res, 200, { ...runner.reply(body.text, { takeover: Boolean(body.takeover), mode }), ...runner.publicState() });
    }
    if (sub === "stop") { runner.stop(); return send(res, 200, runner.publicState()); }
  }

  // Removes a message that still waits in the PM's queue.
  if (section === "run" && sub === "queue" && parts[2] && req.method === "DELETE") {
    if (!dept.runner.removeQueued(parts[2])) return send(res, 404, { error: "That message is no longer in the queue." });
    return send(res, 200, dept.runner.publicState());
  }

  if (section === "settings" && !sub && req.method === "GET") return send(res, 200, dept.settings());
  if (section === "settings" && !sub && req.method === "PUT") {
    const settings = dept.updateSettings(await readBody(req));
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.publicInfo() });
    return send(res, 200, { settings, runner: dept.runner.publicState() });
  }

  if (section === "room" && sub === "randomize" && req.method === "POST") {
    dept.randomizeRoom((await readBody(req)).seed);
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.publicInfo() });
    return send(res, 200, dept.publicInfo());
  }

  if (section === "room" && sub === "items" && req.method === "PUT") {
    const body = await readBody(req);
    dept.setRoomItem(body.slot, body.kind, body.v);
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.publicInfo() });
    return send(res, 200, dept.publicInfo());
  }

  if (section === "migration" && sub === "confirm" && req.method === "POST") {
    const result = await dept.confirmMigration();
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.publicInfo() });
    return send(res, 200, result);
  }

  if (section === "release" && req.method === "POST") {
    const result = await dept.release();
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.publicInfo() });
    return send(res, 200, result);
  }

  if (section === "office" && sub === "update" && req.method === "POST") {
    const result = await dept.updateOffice();
    const info = dept.publicInfo();
    broadcast("department-info", { dept: dept.id, data: info });
    return send(res, 200, { ...result, info });
  }

  return send(res, 404, { error: "Unknown API route" });
}

async function handleApi(req, res, url) {
  const denied = checkRequest(req, ALLOWED_HOSTS);
  if (denied) return send(res, denied.status, { error: denied.error });
  try {
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    const [resource, id, ...rest] = parts;
    if (resource === "stream" && req.method === "GET") return openStream(req, res);
    if (resource === "state" && req.method === "GET") return send(res, 200, snapshot());

    // Folder picker: lists sub-folders and describes a folder (local machine only, the server binds to 127.0.0.1).
    if (resource === "fs" && req.method === "GET") {
      const target = url.searchParams.get("path") || "";
      if (id === "list") return send(res, 200, listFolders(target));
      if (id === "inspect") return send(res, 200, await inspectFolder(target));
    }

    // Shuts down this computer after a short delay: PM turns are stopped first and saved as cut off,
    // so the next start continues them. { action: "shutdown" | "cancel" }
    if (resource === "system" && id === "shutdown" && req.method === "POST") {
      const body = await readBody(req);
      if (body.action === "cancel") {
        if (!shutdownState) return send(res, 409, { error: "No shutdown is planned." });
        await runShutdownCommand("cancel");
        shutdownState = null;
        company.list().forEach((d) => d.runner.cancelShutdown());
      } else if (body.action === "shutdown") {
        if (body.confirm !== true) return send(res, 400, { error: "Confirm the shutdown." });
        company.list().forEach((d) => d.runner.shutdown());
        try {
          const result = await runShutdownCommand("shutdown");
          shutdownState = { at: Date.now() + SHUTDOWN_DELAY_S * 1000, dryRun: result.dryRun };
        } catch (err) {
          company.list().forEach((d) => d.runner.cancelShutdown());
          return send(res, 500, { error: `Could not shut down: ${err.message}` });
        }
      } else {
        return send(res, 400, { error: "Unknown action." });
      }
      broadcast("system", { shutdown: shutdownState });
      return send(res, 200, { shutdown: shutdownState });
    }

    if (resource === "departments") {
      if (!id) {
        if (req.method === "GET") return send(res, 200, snapshot().departments);
        if (req.method === "POST") {
          const body = await readBody(req);
          const dept = await company.create(body);
          // A migrated project starts with onboarding even without a request; a new one waits for a request.
          const prompt = company.firstPrompt(dept, body.request);
          if (prompt) dept.runner.start(prompt, { note: String(body.request || "").trim() || null });
          return send(res, 200, { ...dept.snapshot({ withEvents: false }), messages: dept.recentMessages() });
        }
      }
      const dept = company.get(id);
      if (!dept) return send(res, 404, { error: "Department not found" });
      return await handleDepartment(req, res, dept, rest);
    }
    return send(res, 404, { error: "Unknown API route" });
  } catch (err) {
    return send(res, err.status || (err.code === "CHAT_OWNED" ? 409 : 400), { error: err.message, code: err.code });
  }
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    return send(res, 400, "Bad request", "text/plain");
  }
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

setInterval(() => company.pollAll(), 500);
// A named event (not a comment) so the dashboard can tell a live stream from one a proxy holds back.
setInterval(() => clients.forEach((res) => res.write(`event: ping\ndata: ${Date.now()}\n\n`)), STREAM_PING_MS);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Office dashboard: http://localhost:${PORT} (${company.list().length} departments)`);
  if (ALLOWED_HOSTS.length) console.log(`Also answering on: ${ALLOWED_HOSTS.join(", ")}`);
});

// Stop the PM processes with the server, so no Claude run keeps working (and spending) unseen. A turn that is cut
// off is saved as such, and the next start continues it (see RunController.afterRestart).
function shutdown() {
  company.list().forEach((d) => d.runner.shutdown());
  clients.forEach((res) => res.end());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
