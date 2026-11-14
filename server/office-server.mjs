// Agent Office local server: serves the company dashboard, the department API (create, HR, team proposal,
// PM runs, release) and a live event stream for all departments.
// Usage: node server/office-server.mjs [port]   (binds to 127.0.0.1 only)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_DIR } from "./paths.mjs";
import { isValidId, roleCatalog } from "./staff-store.mjs";
import { listFolders, inspectFolder } from "./workspace-setup.mjs";
import { Scheduler, runnerConfig } from "./run-controller.mjs";
import { Company } from "./departments.mjs";

const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const MAX_BODY = 1024 * 1024;

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

function snapshot() {
  const cfg = runnerConfig();
  return {
    defaults: company.defaults(),
    maxParallelRuns: cfg.maxParallelRuns,
    library: roleCatalog(),
    departments: company.list().map((d) => d.snapshot()),
  };
}

function openStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
  });
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
    if (sub === "start") { runner.start(body.request); return send(res, 200, runner.publicState()); }
    if (sub === "reply") return send(res, 200, { ...runner.reply(body.text, { takeover: Boolean(body.takeover) }), ...runner.publicState() });
    if (sub === "stop") { runner.stop(); return send(res, 200, runner.publicState()); }
  }

  if (section === "room" && sub === "randomize" && req.method === "POST") {
    const info = dept.randomizeRoom();
    company.save();
    broadcast("department-info", { dept: dept.id, data: info });
    return send(res, 200, info);
  }

  if (section === "migration" && sub === "confirm" && req.method === "POST") {
    const result = await dept.confirmMigration();
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.info });
    return send(res, 200, result);
  }

  if (section === "release" && req.method === "POST") {
    const result = await dept.release();
    company.save();
    broadcast("department-info", { dept: dept.id, data: dept.info });
    return send(res, 200, result);
  }

  return send(res, 404, { error: "Unknown API route" });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
  const [resource, id, ...rest] = parts;
  try {
    if (resource === "stream" && req.method === "GET") return openStream(req, res);
    if (resource === "state" && req.method === "GET") return send(res, 200, snapshot());

    // Folder picker: lists sub-folders and describes a folder (local machine only, the server binds to 127.0.0.1).
    if (resource === "fs" && req.method === "GET") {
      const target = url.searchParams.get("path") || "";
      if (id === "list") return send(res, 200, listFolders(target));
      if (id === "inspect") return send(res, 200, await inspectFolder(target));
    }

    if (resource === "departments") {
      if (!id) {
        if (req.method === "GET") return send(res, 200, snapshot().departments);
        if (req.method === "POST") {
          const body = await readBody(req);
          const dept = await company.create(body);
          // A migrated project starts with onboarding even without a request; a new one waits for a request.
          const prompt = company.firstPrompt(dept, body.request);
          if (prompt) dept.runner.start(prompt);
          return send(res, 200, dept.snapshot({ withEvents: false }));
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

setInterval(() => company.pollAll(), 500);
setInterval(() => clients.forEach((res) => res.write(": ping\n\n")), 20000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Office dashboard: http://localhost:${PORT} (${company.list().length} departments)`);
});
