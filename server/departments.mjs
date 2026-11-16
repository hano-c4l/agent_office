// Departments: each one is a project with its own workspace folder, staff, PM run and live state.
// The list of departments is kept in office/departments.json (local to this machine, ignored by git);
// each workspace also keeps its own .office/department.json so a removed department can be opened again.

import fs from "node:fs";
import path from "node:path";
import { OFFICE_DIR, ROOT, DEFAULT_WORKSPACE_ROOT } from "./paths.mjs";
import { StaffStore, isValidId } from "./staff-store.mjs";
import { RunController } from "./run-controller.mjs";
import { randomPerson } from "./people.mjs";
import {
  isValidRepoUrl, setupNewWorkspace, migrateWorkspace, releaseToMain, inspectFolder, confirmMigration,
  readDepartmentFile, writeDepartmentFile, listAgentFiles,
} from "./workspace-setup.mjs";

const THEME_COUNT = 6;

// Hire requests are self-contained, so they also work in departments installed with an older /office skill.
function hirePrompt(description, model) {
  return [
    "[hire] You are the PM of this Agent Office department (see CLAUDE.md and .office/department.json).",
    `The customer wants to hire new staff: "${description}".`,
    model && model !== "auto" ? `Preferred model: ${model}.` : "Choose the model that fits the role.",
    "Design the role(s): id (lowercase letters, digits, _ or -, not used by any file in .claude/agents), title,",
    "role (pm, ba, sa, leader, dev, test, devops or other), model, skills, tools, description (when to use it) and",
    "prompt (responsibilities plus the 'How you work in Agent Office' rules). Use the role catalog at",
    "roleCatalog in .office/department.json as a read-only reference.",
    "Write .office/proposal.json: { \"kind\": \"hire\", \"request\": <the description>, \"complexity\": \"-\",",
    "\"status\": \"pending\", \"createdAt\": <ISO time>, \"members\": [ the new role(s) only, each with \"reason\" and",
    "\"included\": true, without a name ] }.",
    "Do not write agent files yet, and do not change .office/tasks.json or .office/active-run.json.",
    "Then tell the customer in Vietnamese, in two or three lines, who you propose and why, and end your turn.",
  ].join(" ");
}

const HIRE_APPROVED = [
  "I approved the hire proposal on the dashboard (.office/proposal.json).",
  "Add a setup task to .office/tasks.json (id S<next number>, owner pm, status doing), write each approved new member's agent file",
  "to .office/team/agents/<id>.md and missing skills to .office/team/skills/<name>/SKILL.md in the current Claude Code",
  "format (the dashboard installs them into .claude/), then mark the setup task done.",
  "Tell me in one line when the new staff is ready and end your turn. Do not start any other work.",
].join(" ");

const REGISTRY_FILE = path.join(OFFICE_DIR, "departments.json");
const REPLAY_EVENTS = 200;
const MODELS = new Set(["opus", "sonnet", "haiku"]);

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

export function slugify(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "department";
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

class Department {
  constructor(info, { scheduler, broadcast }) {
    this.info = info;
    this.id = info.id;
    this.root = info.workspace;
    this.office = path.join(this.root, ".office");
    this.files = {
      events: path.join(this.office, "events.jsonl"),
      tasks: path.join(this.office, "tasks.json"),
      proposal: path.join(this.office, "proposal.json"),
      run: path.join(this.office, "active-run.json"),
    };
    this.store = new StaffStore(this.root);
    this.broadcast = (type, data) => broadcast(type, { dept: this.id, data });
    this.runner = new RunController({
      department: info,
      scheduler,
      getModel: () => {
        const pm = this.store.get("pm");
        return pm && !pm.pending ? pm.model : info.pmModel;
      },
      // Agents the PM wrote this turn must be installed and counted before deciding to reload.
      agentSignature: () => {
        this.installStaged();
        return this.store.agentFiles().map((f) => {
          try { return f + fs.statSync(path.join(this.store.agentsDir, f)).mtimeMs; } catch { return f; }
        }).join("|");
      },
      broadcast: this.broadcast,
    });
    this.eventsOffset = fs.existsSync(this.files.events) ? fs.statSync(this.files.events).size : 0;
    this.partialLine = "";
    this.mtimes = {};
    ["tasks", "proposal", "run"].forEach((k) => this.changed(k));
    this.staffSig = this.store.signature();
  }

  exists() {
    return fs.existsSync(this.root);
  }

  recentEvents(limit = REPLAY_EVENTS) {
    try {
      const lines = fs.readFileSync(this.files.events, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }

  snapshot({ withEvents = true } = {}) {
    return {
      info: { ...this.info, missing: !this.exists() },
      staff: this.store.list(),
      helpers: this.store.helpers(),
      tasks: readJson(this.files.tasks, { tasks: [] }),
      proposal: readJson(this.files.proposal, null),
      run: readJson(this.files.run, null),
      runner: this.runner.publicState(),
      events: withEvents ? this.recentEvents() : [],
    };
  }

  changed(key) {
    let m = 0;
    try { m = fs.statSync(this.files[key]).mtimeMs; } catch { /* missing file */ }
    if (this.mtimes[key] === m) return false;
    const first = this.mtimes[key] === undefined;
    this.mtimes[key] = m;
    return !first;
  }

  // New proposal members get a random name and look, written back into the proposal so the
  // customer and the PM see the same names. Existing staff keep theirs.
  nameProposal() {
    const p = readJson(this.files.proposal, null);
    if (!p || p.status !== "pending" || !Array.isArray(p.members)) return;
    const staff = new Map(this.store.list().map((a) => [a.id, a]));
    const taken = [...staff.values()].map((a) => a.name);
    let changed = false;
    for (const m of p.members) {
      if (!isValidId(m.id)) continue;
      const known = staff.get(m.id);
      if (known) {
        if (m.name !== known.name || JSON.stringify(m.look) !== JSON.stringify(known.look)) {
          Object.assign(m, { name: known.name, look: known.look });
          changed = true;
        }
      } else if (!m.look || !m.look.gender || !m.name || taken.includes(m.name)) {
        const person = randomPerson(taken);
        Object.assign(m, { name: person.name, look: person.look });
        changed = true;
      }
      if (m.name) taken.push(m.name);
    }
    if (changed) {
      writeJson(this.files.proposal, p);
      this.changed("proposal");
    }
  }

  installStaged() {
    try {
      const installed = this.store.installStaged();
      if (installed.length) console.log(`[${this.id}] installed ${installed.join(", ")}`);
    } catch (err) {
      console.warn(`[${this.id}] could not install staged team files: ${err.message}`);
    }
  }

  // Poll files instead of fs.watch: polling behaves the same on Windows, macOS and Linux.
  poll() {
    this.installStaged();
    try {
      const size = fs.existsSync(this.files.events) ? fs.statSync(this.files.events).size : 0;
      if (size < this.eventsOffset) this.eventsOffset = 0; // log was rotated
      if (size > this.eventsOffset) {
        const fd = fs.openSync(this.files.events, "r");
        const buf = Buffer.alloc(size - this.eventsOffset);
        fs.readSync(fd, buf, 0, buf.length, this.eventsOffset);
        fs.closeSync(fd);
        this.eventsOffset = size;
        const lines = (this.partialLine + buf.toString("utf8")).split("\n");
        this.partialLine = lines.pop();
        lines.filter(Boolean).forEach((line) => {
          let ev;
          try { ev = JSON.parse(line); } catch { return; }
          // An /office run started in a chat session: remember it so the dashboard can take it over.
          if (ev.hook === "UserPromptSubmit" && /^\/office/.test(ev.text || "")) this.runner.noteChatSession(ev.session);
          this.broadcast("office-event", ev);
        });
      }
    } catch (err) {
      console.warn(`[${this.id}] event poll failed: ${err.message}`);
    }
    if (this.changed("tasks")) this.broadcast("tasks", readJson(this.files.tasks, { tasks: [] }));
    if (this.changed("proposal")) {
      this.nameProposal();
      this.broadcast("proposal", readJson(this.files.proposal, null));
    }
    if (this.changed("run")) this.broadcast("run", readJson(this.files.run, null));
    const sig = this.store.signature();
    if (sig !== this.staffSig) {
      // Agents the PM wrote on its own get a name and look.
      this.store.ensureAllIdentities();
      this.staffSig = this.store.signature();
      this.broadcast("staff", this.store.list());
      this.broadcast("helpers", this.store.helpers());
    }
  }

  updateProposal(body) {
    const current = readJson(this.files.proposal, null);
    if (!current) {
      const err = new Error("No proposal");
      err.status = 404;
      throw err;
    }
    const next = { ...current, members: body.members || current.members, status: body.status || current.status };
    if (next.status === "approved") {
      next.approvedAt = next.approvedAt || new Date().toISOString();
      // The dashboard records who joins (name, look, title, model). The PM writes the agent files.
      // The PM's model is chosen by the customer (department setup or HR), never by the proposal.
      next.members.filter((m) => m.included !== false && isValidId(m.id) && m.id !== "pm").forEach((m) => {
        if (this.store.has(m.id)) {
          this.store.setModel(m.id, m.model);
        } else {
          this.store.ensureIdentity(m.id, {
            name: m.name, look: m.look, title: m.title, role: m.role, model: m.model,
            skills: m.skills, tools: m.tools, description: m.description,
          });
        }
      });
    }
    writeJson(this.files.proposal, next);
    this.changed("proposal");
    // For a run driven by the dashboard, tell the PM right away.
    if (next.status === "approved" && body.status === "approved" && this.runner.state.origin === "dashboard") {
      if (next.kind === "hire") this.runner.reply(HIRE_APPROVED);
      else {
        this.runner.reply("I approved the team on the dashboard (.office/proposal.json). Create the team. " +
          "Then continue with my request; if I have not given you a request yet, ask me what to build first and wait.");
      }
    }
    return next;
  }

  // The customer checked the office setup of a migrated project: merge its branch into preview.
  async confirmMigration() {
    const m = this.info.migration;
    if (!m || m.status !== "pending") throw new Error("There is no migration waiting for confirmation.");
    if (this.runner.state.busy) throw new Error("The PM is working. Confirm when the team is idle.");
    const result = await confirmMigration(this.root, m.branch);
    this.info.migration = { ...m, status: "merged", mergedAt: new Date().toISOString() };
    writeDepartmentFile(this.root, this.info);
    return result;
  }

  // Asks the PM to design new staff from a short description. The PM answers with a hire proposal
  // (.office/proposal.json, kind "hire") that the customer approves before anything is created.
  requestHire(description, model) {
    const text = String(description || "").trim();
    if (!text) throw new Error("Describe the staff member you need.");
    const pending = readJson(this.files.proposal, null);
    if (pending && pending.status === "pending") throw new Error("A proposal is already waiting for your approval. Approve or reject it first.");
    const prompt = hirePrompt(text, model);
    const r = this.runner.state;
    if (r.sessionId && r.origin === "dashboard") return this.runner.reply(prompt);
    if (r.sessionId && r.origin === "chat" && this.run()?.status === "running") {
      throw new Error("A run is active in a Claude chat session. Ask the PM there, or take the run over first.");
    }
    this.runner.start(prompt, { plain: true });
    return { queued: false };
  }

  run() {
    return readJson(this.files.run, null);
  }

  // A new random room look; the dashboard derives layout, furniture and colors from the seed.
  randomizeRoom() {
    this.info.roomSeed = Math.floor(Math.random() * 1e9);
    try { writeDepartmentFile(this.root, this.info); } catch { /* the workspace may be missing */ }
    return this.info;
  }

  async release() {
    if (this.runner.state.busy) throw new Error("The PM is working. Release when the team is idle.");
    const result = await releaseToMain(this.root);
    this.info.lastReleaseAt = new Date().toISOString();
    return result;
  }
}

export class Company {
  constructor({ scheduler, broadcast }) {
    this.scheduler = scheduler;
    this.broadcastRaw = broadcast;
    this.departments = new Map();
    const registry = readJson(REGISTRY_FILE, { departments: [] });
    for (const info of registry.departments || []) this.attach(info);
  }

  attach(info) {
    // Older departments get a stable style from their id.
    if (!Number.isInteger(info.theme)) {
      info.theme = [...info.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % THEME_COUNT;
    }
    const dept = new Department(info, { scheduler: this.scheduler, broadcast: this.broadcastRaw });
    this.departments.set(info.id, dept);
    if (dept.exists()) {
      try {
        // Older departments get a department file, and every staff member an identity.
        if (!readDepartmentFile(dept.root)) writeDepartmentFile(dept.root, info);
        dept.store.ensureAllIdentities();
      } catch (err) {
        console.warn(`[${info.id}] could not refresh the department files: ${err.message}`);
      }
    }
    return dept;
  }

  save() {
    writeJson(REGISTRY_FILE, { departments: [...this.departments.values()].map((d) => d.info) });
  }

  get(id) {
    return this.departments.get(id) || null;
  }

  list() {
    return [...this.departments.values()];
  }

  defaults() {
    return { workspaceRoot: DEFAULT_WORKSPACE_ROOT, models: [...MODELS] };
  }

  pickTheme() {
    const used = new Set(this.list().map((d) => d.info.theme));
    const free = [...Array(THEME_COUNT).keys()].filter((t) => !used.has(t));
    const pool = free.length ? free : [...Array(THEME_COUNT).keys()];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  uniqueId(name) {
    let id = slugify(name);
    for (let i = 2; this.departments.has(id); i++) id = `${slugify(name)}-${i}`;
    return id;
  }

  checkWorkspace(raw) {
    let workspace = String(raw || "").trim();
    if (!path.isAbsolute(workspace)) throw badRequest("Workspace path must be absolute, for example D:\\Projects\\shop.");
    workspace = path.resolve(workspace);
    if (samePath(workspace, ROOT) || (isInside(workspace, ROOT) && !isInside(workspace, DEFAULT_WORKSPACE_ROOT)) ||
        isInside(ROOT, workspace)) {
      throw badRequest(`The workspace cannot be the Agent Office folder itself. Use a folder under ${DEFAULT_WORKSPACE_ROOT} or anywhere else.`);
    }
    if (this.list().some((d) => samePath(d.root, workspace))) throw badRequest("A department already uses this workspace.");
    return workspace;
  }

  async create(input) {
    const mode = ["new", "open", "migrate"].includes(input.mode) ? input.mode : "new";
    const name = String(input.name || "").trim();
    if (mode !== "open" && !name) throw badRequest("Department name is required.");
    if (name.length > 60) throw badRequest("Department name is too long (max 60 characters).");
    const pmModel = MODELS.has(input.pmModel) ? input.pmModel : "opus";
    const repo = String(input.repo || "").trim();
    if (!isValidRepoUrl(repo)) throw badRequest("Repository must be an https://, ssh:// or git@ URL.");
    const raw = String(input.workspace || "").trim() || (mode === "new" ? path.join(DEFAULT_WORKSPACE_ROOT, slugify(name)) : "");
    if (!raw) throw badRequest("Choose the project folder.");
    const workspace = this.checkWorkspace(raw);
    const folder = await inspectFolder(workspace);

    let info;
    let setup;
    if (mode === "open") {
      if (!folder.hasOffice) throw badRequest("This folder has no Agent Office department. Use Migrate for an existing project.");
      const saved = folder.department || {};
      const openName = saved.name || folder.name;
      info = {
        id: this.uniqueId(openName), name: openName, pmModel: saved.pmModel || pmModel, workspace,
        repo: saved.repo || folder.origin || "", mode: saved.mode || "new", createdAt: saved.createdAt || new Date().toISOString(),
        theme: Number.isInteger(saved.theme) ? saved.theme : this.pickTheme(), roomSeed: saved.roomSeed,
        migration: saved.migration, docFolders: saved.docFolders || [],
      };
      writeDepartmentFile(workspace, info);
      setup = { log: ["Opened the existing department."], warnings: [] };
    } else if (mode === "migrate") {
      if (!folder.exists || folder.empty) throw badRequest("Migrate needs a folder with an existing project. Use New for an empty folder.");
      if (folder.hasOffice) throw badRequest("This folder already has an Agent Office department. Use Open.");
      // Documentation folders the team reads first (only the ones that exist).
      const requested = String(input.docFolders ?? "docs").split(",").map((x) => x.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
        .filter((x) => x && !x.split("/").includes(".."));
      const docFolders = requested.filter((x) => fs.existsSync(path.join(workspace, x)) && fs.statSync(path.join(workspace, x)).isDirectory());
      // Existing project agents: the ones the customer ticked become staff, the others are helpers.
      const existingAgents = listAgentFiles(workspace).map((a) => a.id);
      const staffAgents = new Set((Array.isArray(input.staffAgents) ? input.staffAgents : []).filter((id) => existingAgents.includes(id)));
      info = {
        id: this.uniqueId(name), name, pmModel, workspace, repo: repo || folder.origin || "", mode,
        createdAt: new Date().toISOString(), theme: this.pickTheme(), docFolders,
      };
      setup = await migrateWorkspace(info);
      const store = new StaffStore(workspace);
      existingAgents.forEach((id) => {
        if (id === "pm") return;
        if (staffAgents.has(id)) store.ensureIdentity(id);
        else store.setHelper(id, true);
      });
      if (requested.length && !docFolders.length) setup.warnings.push(`No documentation folder found (${requested.join(", ")}): the analyst reads the code.`);
      else if (docFolders.length) setup.log.push(`Documentation folders read first: ${docFolders.join(", ")}.`);
      if (existingAgents.length) {
        const helpers = existingAgents.filter((id) => !staffAgents.has(id));
        setup.log.push(`Existing agents: ${[...staffAgents].join(", ") || "none"} as staff, ${helpers.join(", ") || "none"} as helpers.`);
      }
    } else {
      if (folder.exists && !folder.empty) {
        throw badRequest(folder.hasOffice ? "This folder already has an Agent Office department. Use Open."
          : "This folder is not empty. Use Migrate for an existing project, or choose an empty folder.");
      }
      info = { id: this.uniqueId(name), name, pmModel, workspace, repo, mode, createdAt: new Date().toISOString(), theme: this.pickTheme() };
      setup = await setupNewWorkspace(info);
    }
    info.setup = setup;
    const dept = this.attach(info);
    this.save();
    this.broadcastRaw("department", { dept: dept.id, data: dept.snapshot() });
    return dept;
  }

  // The first PM turn after creating a department.
  firstPrompt(dept, request) {
    const text = String(request || "").trim();
    if (dept.info.mode === "migrate") return `[onboard] ${text}`.trim();
    return text;
  }

  // Removes the department from the dashboard. The workspace folder and repository are kept, so it can be opened again.
  remove(id) {
    const dept = this.get(id);
    if (!dept) return false;
    if (dept.runner.state.busy) throw badRequest("Stop the PM before closing the department.");
    this.departments.delete(id);
    this.save();
    this.broadcastRaw("department-removed", { dept: id });
    return true;
  }

  pollAll() {
    this.list().forEach((d) => d.poll());
  }
}
