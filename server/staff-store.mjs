// Reads and writes office staff: Claude Code agent files (.claude/agents/*.md),
// display metadata (office/staff.json) and role skills (.claude/skills/<name>/SKILL.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillMarkdown } from "./skill-guides.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENTS_DIR = path.join(ROOT, ".claude", "agents");
export const SKILLS_DIR = path.join(ROOT, ".claude", "skills");
export const OFFICE_DIR = path.join(ROOT, "office");
export const META_FILE = path.join(OFFICE_DIR, "staff.json");
const DISMISSED_DIR = path.join(OFFICE_DIR, "dismissed");

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LIST_KEYS = new Set(["tools", "skills", "disallowedTools"]);

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

// ---------- metadata ----------

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  fs.mkdirSync(OFFICE_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
}

// ---------- staff ----------

export function listStaff() {
  const meta = readMeta();
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  const order = Object.keys(meta);
  return files
    .map((file) => {
      const { front, body } = parseAgentFile(fs.readFileSync(path.join(AGENTS_DIR, file), "utf8"));
      const id = front.name || path.basename(file, ".md");
      const m = meta[id] || {};
      return {
        id,
        name: m.name || id,
        title: m.title || id,
        role: m.role || "other",
        look: m.look || {},
        model: front.model || "inherit",
        description: front.description || "",
        tools: Array.isArray(front.tools) ? front.tools : [],
        skills: Array.isArray(front.skills) ? front.skills : [],
        prompt: body,
      };
    })
    .sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
}

export function saveStaff(config) {
  if (!isValidId(config.id)) throw new Error(`Invalid agent id: ${config.id}`);
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const file = path.join(AGENTS_DIR, `${config.id}.md`);
  let parsed = { front: {}, order: ["name", "description", "model", "tools", "skills"], body: "" };
  if (fs.existsSync(file)) parsed = parseAgentFile(fs.readFileSync(file, "utf8"));

  const front = { ...parsed.front, name: config.id };
  const description = (config.description || "").trim() ||
    `Agent Office ${config.title || config.id} (${config.name || config.id}). ${firstSentence(config.prompt)}`;
  front.description = description;
  if (config.model) front.model = config.model;
  front.tools = (config.tools || []).filter(Boolean);
  front.skills = (config.skills || []).filter(Boolean);
  const body = config.prompt ?? parsed.body;
  fs.writeFileSync(file, serializeAgentFile(front, parsed.order, body));

  const meta = readMeta();
  meta[config.id] = {
    name: config.name || config.id,
    title: config.title || config.id,
    role: config.role || "other",
    look: hasLook(config.look) ? config.look : (meta[config.id]?.look || randomLook()),
  };
  writeMeta(meta);
  front.skills.forEach(ensureSkill);
  return listStaff().find((a) => a.id === config.id);
}

// Moves the agent file aside instead of deleting it, so a dismissal can be undone.
export function dismissStaff(id) {
  if (!isValidId(id)) throw new Error(`Invalid agent id: ${id}`);
  const file = path.join(AGENTS_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return false;
  fs.mkdirSync(DISMISSED_DIR, { recursive: true });
  fs.renameSync(file, path.join(DISMISSED_DIR, `${id}-${Date.now()}.md`));
  return true;
}

export function ensureSkill(name) {
  if (!isValidId(name)) return;
  const file = path.join(SKILLS_DIR, name, "SKILL.md");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, skillMarkdown(name));
}

export function ensureAllSkills() {
  listStaff().forEach((a) => a.skills.forEach(ensureSkill));
}

function hasLook(look) {
  return Boolean(look && typeof look === "object" && Object.keys(look).length);
}

// Gives new hires a distinct chibi look.
function randomLook() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return {
    skin: pick(["#ffe0c7", "#f8d5b5", "#eac09c", "#f6cfa8", "#ffe7d1"]),
    hair: pick(["#2b2b2b", "#5b3a29", "#b5651d", "#6b4f9e", "#e07a5f", "#1f2a44"]),
    hairStyle: pick(["short", "spiky", "long", "bob", "bun"]),
  };
}

function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const end = s.indexOf(". ");
  return end > 0 ? s.slice(0, end + 1) : s.slice(0, 160);
}
