// Reads and writes the staff of one department workspace.
// - Agent files (.claude/agents/*.md) are written by the PM (or by HR edits on the dashboard).
// - Display data (.office/staff.json: name, title, role, look) is written by the dashboard; new staff get a
//   random identity. A member that is approved but has no agent file yet is listed as "pending".
// - The company role catalog (templates/roles.json) is a reference only; nothing is copied from it.

import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_DIR } from "./paths.mjs";
import { randomPerson, guessRole, titleFromId } from "./people.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LIST_KEYS = new Set(["tools", "skills", "disallowedTools"]);
export const ROLE_CATALOG_FILE = path.join(TEMPLATES_DIR, "roles.json");

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

// ---------- frontmatter ----------

export function parseAgentFile(text) {
  const match = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { front: {}, order: [], body: text };
  const front = {};
  const order = [];
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) {
      front[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    order.push(key);
    if (value === "") {
      front[key] = [];
      listKey = key;
    } else {
      listKey = null;
      front[key] = LIST_KEYS.has(key) ? splitList(value) : unquote(value);
    }
  }
  return { front, order, body: match[2].trim() };
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function splitList(value) {
  return value.replace(/^\[|\]$/g, "").split(",").map((x) => unquote(x)).filter(Boolean);
}

function yamlScalar(value) {
  const v = String(value ?? "").replace(/\r?\n/g, " ").trim();
  return /[:#\[\]{}&*!|>'"%@`]/.test(v) || v === "" ? JSON.stringify(v) : v;
}

export function serializeAgentFile(front, order, body) {
  const keys = [...new Set([...order, ...Object.keys(front)])].filter((k) => front[k] !== undefined);
  const lines = ["---"];
  for (const key of keys) {
    const value = front[key];
    if (Array.isArray(value)) {
      if (key === "tools" || key === "disallowedTools") {
        if (value.length) lines.push(`${key}: ${value.join(", ")}`);
      } else if (value.length) {
        lines.push(`${key}:`);
        value.forEach((v) => lines.push(`  - ${yamlScalar(v)}`));
      }
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n" + String(body || "").trim() + "\n";
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------- company role catalog (reference only) ----------

export function roleCatalog() {
  const cat = readJson(ROLE_CATALOG_FILE, { roles: [] });
  return Array.isArray(cat.roles) ? cat.roles : [];
}

// ---------- department staff ----------

export class StaffStore {
  constructor(root) {
    this.root = root;
    this.agentsDir = path.join(root, ".claude", "agents");
    this.skillsDir = path.join(root, ".claude", "skills");
    this.metaFile = path.join(root, ".office", "staff.json");
    this.dismissedDir = path.join(root, ".office", "dismissed");
  }

  readMeta() {
    return readJson(this.metaFile, {});
  }

  writeMeta(meta) {
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true });
    fs.writeFileSync(this.metaFile, JSON.stringify(meta, null, 2) + "\n");
  }

  agentFiles() {
    if (!fs.existsSync(this.agentsDir)) return [];
    return fs.readdirSync(this.agentsDir).filter((f) => f.endsWith(".md"));
  }

  hasSkill(name) {
    return fs.existsSync(path.join(this.skillsDir, name, "SKILL.md"));
  }

  list() {
    const meta = this.readMeta();
    const staff = new Map();
    for (const file of this.agentFiles()) {
      const { front, body } = parseAgentFile(fs.readFileSync(path.join(this.agentsDir, file), "utf8"));
      const id = front.name || path.basename(file, ".md");
      const m = meta[id] || {};
      // Helper agents (utilities such as search or grep) are not staff and get no tasks.
      if (m.helper) continue;
      const skills = Array.isArray(front.skills) ? front.skills : [];
      staff.set(id, {
        id,
        name: m.name || id,
        title: m.title || titleFromId(id),
        role: m.role || guessRole(id),
        look: m.look || {},
        model: front.model || m.model || "inherit",
        description: front.description || "",
        tools: Array.isArray(front.tools) ? front.tools : [],
        skills,
        missingSkills: skills.filter((s) => !this.hasSkill(s)),
        prompt: body,
        pending: false,
      });
    }
    // Approved members whose agent file the PM has not written yet.
    for (const [id, m] of Object.entries(meta)) {
      if (staff.has(id) || m.helper) continue;
      staff.set(id, {
        id, name: m.name || id, title: m.title || titleFromId(id), role: m.role || guessRole(id), look: m.look || {},
        model: m.model || "inherit", description: m.description || "", tools: m.tools || [], skills: m.skills || [],
        missingSkills: [], prompt: "", pending: true,
      });
    }
    const order = Object.keys(meta);
    return [...staff.values()].sort((a, b) => {
      if (a.id === "pm") return -1;
      if (b.id === "pm") return 1;
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  get(id) {
    return this.list().find((a) => a.id === id) || null;
  }

  has(id) {
    return isValidId(id) && fs.existsSync(path.join(this.agentsDir, `${id}.md`));
  }

  takenNames(meta = this.readMeta()) {
    return Object.values(meta).map((m) => m.name).filter(Boolean);
  }

  // Gives a staff member a random name and look unless they already have one.
  ensureIdentity(id, extra = {}) {
    const meta = this.readMeta();
    const prev = meta[id] || {};
    const next = { ...prev, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== "")) };
    if (!next.name || !next.look || !Object.keys(next.look).length) {
      const others = { ...meta };
      delete others[id];
      const person = randomPerson(this.takenNames(others));
      next.name = next.name || person.name;
      if (!next.look || !Object.keys(next.look).length) next.look = person.look;
    }
    next.title = next.title || titleFromId(id);
    next.role = next.role || guessRole(`${id} ${next.title}`);
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      meta[id] = next;
      this.writeMeta(meta);
    }
    return next;
  }

  // Agents the PM created on its own (for example the onboarding analyst) get an identity too.
  ensureAllIdentities() {
    const meta = this.readMeta();
    let changed = false;
    for (const file of this.agentFiles()) {
      const id = path.basename(file, ".md");
      if (meta[id] && (meta[id].helper || (meta[id].name && meta[id].look))) continue;
      const person = randomPerson(this.takenNames(meta));
      meta[id] = { title: titleFromId(id), role: guessRole(id), ...meta[id], name: person.name, look: person.look };
      changed = true;
    }
    if (changed) this.writeMeta(meta);
    return changed;
  }

  // Helper agents: existing project agents the customer did not take on as staff.
  helpers() {
    const meta = this.readMeta();
    return this.agentFiles().map((file) => {
      const { front } = parseAgentFile(fs.readFileSync(path.join(this.agentsDir, file), "utf8"));
      const id = front.name || path.basename(file, ".md");
      return { id, description: front.description || "", model: front.model || "inherit", helper: Boolean(meta[id]?.helper) };
    }).filter((a) => a.helper);
  }

  setHelper(id, helper) {
    if (!isValidId(id)) throw new Error(`Invalid agent id: ${id}`);
    const meta = this.readMeta();
    if (helper) {
      meta[id] = { helper: true };
      this.writeMeta(meta);
    } else {
      delete meta[id];
      this.writeMeta(meta);
      this.ensureIdentity(id);
    }
  }

  // Gives a staff member a new random name and look (title and role stay).
  randomize(id) {
    const meta = this.readMeta();
    if (!meta[id] && !this.has(id)) return null;
    const others = { ...meta };
    delete others[id];
    const person = randomPerson(this.takenNames(others));
    meta[id] = { ...(meta[id] || {}), name: person.name, look: person.look };
    this.writeMeta(meta);
    return this.get(id);
  }

  // Creates or updates an agent file from the dashboard (HR). Unknown frontmatter keys are kept.
  save(config) {
    if (!isValidId(config.id)) throw new Error(`Invalid agent id: ${config.id}`);
    fs.mkdirSync(this.agentsDir, { recursive: true });
    const file = path.join(this.agentsDir, `${config.id}.md`);
    let parsed = { front: {}, order: ["name", "description", "model", "tools", "skills"], body: "" };
    if (fs.existsSync(file)) parsed = parseAgentFile(fs.readFileSync(file, "utf8"));

    const front = { ...parsed.front, name: config.id };
    front.description = (config.description || "").trim() || front.description ||
      `${config.title || titleFromId(config.id)}. ${firstSentence(config.prompt)}`;
    if (config.model) front.model = config.model;
    if (Array.isArray(config.tools)) front.tools = config.tools.filter(Boolean);
    if (Array.isArray(config.skills)) front.skills = config.skills.filter(Boolean);
    const body = config.prompt || parsed.body;
    fs.writeFileSync(file, serializeAgentFile(front, parsed.order, body));

    const meta = this.readMeta();
    const prev = meta[config.id] || {};
    meta[config.id] = {
      ...prev,
      name: config.name || prev.name,
      title: config.title || prev.title || titleFromId(config.id),
      role: config.role || prev.role || guessRole(config.id),
      look: config.look && Object.keys(config.look).length ? config.look : prev.look,
    };
    delete meta[config.id].model;
    this.writeMeta(meta);
    this.ensureIdentity(config.id);
    return this.get(config.id);
  }

  // Updates only the model in an agent file.
  setModel(id, model) {
    if (!this.has(id) || !model) return;
    const file = path.join(this.agentsDir, `${id}.md`);
    const parsed = parseAgentFile(fs.readFileSync(file, "utf8"));
    if (parsed.front.model === model) return;
    parsed.front.model = model;
    fs.writeFileSync(file, serializeAgentFile(parsed.front, parsed.order, parsed.body));
  }

  // Moves the agent file aside instead of deleting it, so a dismissal can be undone.
  dismiss(id) {
    if (!isValidId(id)) throw new Error(`Invalid agent id: ${id}`);
    const file = path.join(this.agentsDir, `${id}.md`);
    const meta = this.readMeta();
    const hadMeta = Boolean(meta[id]);
    if (hadMeta) {
      delete meta[id];
      this.writeMeta(meta);
    }
    if (!fs.existsSync(file)) return hadMeta;
    fs.mkdirSync(this.dismissedDir, { recursive: true });
    fs.renameSync(file, path.join(this.dismissedDir, `${id}-${Date.now()}.md`));
    return true;
  }

  // Claude Code protects .claude/ from writes in headless runs, so the PM writes agents and skills to
  // .office/team/ and the dashboard installs them here. Returns the installed names.
  installStaged() {
    const staging = path.join(this.root, ".office", "team");
    const installed = [];
    const agentsIn = path.join(staging, "agents");
    if (fs.existsSync(agentsIn)) {
      for (const file of fs.readdirSync(agentsIn)) {
        const id = path.basename(file, ".md");
        const from = path.join(agentsIn, file);
        if (!file.endsWith(".md") || !isValidId(id) || !fs.statSync(from).isFile()) continue;
        fs.mkdirSync(this.agentsDir, { recursive: true });
        fs.copyFileSync(from, path.join(this.agentsDir, file));
        fs.rmSync(from);
        installed.push(`agent ${id}`);
      }
    }
    const skillsIn = path.join(staging, "skills");
    if (fs.existsSync(skillsIn)) {
      for (const name of fs.readdirSync(skillsIn)) {
        const from = path.join(skillsIn, name);
        if (!isValidId(name) || !fs.statSync(from).isDirectory() || !fs.existsSync(path.join(from, "SKILL.md"))) continue;
        fs.cpSync(from, path.join(this.skillsDir, name), { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
        installed.push(`skill ${name}`);
      }
    }
    return installed;
  }

  // Signature that changes whenever an agent file, a skill folder or the display metadata changes.
  signature() {
    const parts = [];
    try {
      parts.push(this.agentFiles().map((f) => f + fs.statSync(path.join(this.agentsDir, f)).mtimeMs).join("|"));
    } catch { /* no agents dir */ }
    try { parts.push(fs.readdirSync(this.skillsDir).join(",")); } catch { /* no skills dir */ }
    try { parts.push(String(fs.statSync(this.metaFile).mtimeMs)); } catch { /* no meta */ }
    return parts.join("#");
  }
}

function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const end = s.indexOf(". ");
  return end > 0 ? s.slice(0, end + 1) : s.slice(0, 160);
}
