// Sets up department workspaces: the office config (hooks, /office skill, settings, CLAUDE.md section),
// the department file and the git repository (main and preview branches, remote).
// Three ways in: a new project, an existing department folder (open), or an existing project (migrate).
// Also lists folders for the dashboard's folder picker and releases preview to main.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMPLATE_WORKSPACE_DIR } from "./paths.mjs";
import { StaffStore, ROLE_CATALOG_FILE } from "./staff-store.mjs";

const OFFICE_START = "<!-- agent-office:start -->";
const OFFICE_END = "<!-- agent-office:end -->";
const GIT_TIMEOUT_MS = 90_000;
const SKIP_DIRS = new Set(["$recycle.bin", "system volume information", "node_modules", "$windows.~ws", "windows.old"]);

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const msg = (stderr || stdout || err.message).toString().trim();
          reject(new Error(`git ${args[0]} failed: ${msg.split("\n").slice(-3).join(" ")}`));
          return;
        }
        resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || "").trim() });
      });
  });
}

const lastLines = (r) => (r.err || r.out).split("\n").slice(-2).join(" ");

export function isValidRepoUrl(url) {
  if (!url) return true;
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url) && !url.startsWith("-");
}

// ---------- department file ----------

export function departmentFile(root) {
  return path.join(root, ".office", "department.json");
}

export function readDepartmentFile(root) {
  try {
    return JSON.parse(fs.readFileSync(departmentFile(root), "utf8"));
  } catch {
    return null;
  }
}

export function writeDepartmentFile(root, info) {
  const { id, name, pmModel, repo, mode, createdAt, migration, docFolders, theme, roomSeed } = info;
  const data = {
    id, name, pmModel, repo, mode: mode || "new", createdAt, theme, roomSeed, migration, docFolders: docFolders || [],
    roleCatalog: ROLE_CATALOG_FILE,
  };
  fs.mkdirSync(path.dirname(departmentFile(root)), { recursive: true });
  fs.writeFileSync(departmentFile(root), JSON.stringify(data, null, 2) + "\n");
}

// ---------- office files ----------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

// Adds the office hooks to .claude/settings.json without dropping the project's own settings.
function mergeSettings(file, templateFile) {
  const template = JSON.parse(fs.readFileSync(templateFile, "utf8"));
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or remove it, then try again.`);
    }
  }
  const hooks = current.hooks || {};
  for (const [event, entries] of Object.entries(template.hooks)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const hasOffice = list.some((e) => JSON.stringify(e).includes("office-event.mjs"));
    hooks[event] = hasOffice ? list : [...list, ...entries];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, hooks }, null, 2) + "\n");
}

// Writes the office section of CLAUDE.md, keeping anything the project already has.
function writeClaudeMd(root, department) {
  const file = path.join(root, "CLAUDE.md");
  const section = fs.readFileSync(path.join(TEMPLATE_WORKSPACE_DIR, "CLAUDE.md"), "utf8")
    .replace(/\{\{DEPARTMENT\}\}/g, department.name)
    .replace(/\{\{REMOTE_NOTE\}\}/g, department.repo ? ` (remote: ${department.repo})` : "")
    .trim();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, section + "\n");
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(OFFICE_START);
  const end = text.indexOf(OFFICE_END);
  const next = start >= 0 && end > start
    ? text.slice(0, start) + section + text.slice(end + OFFICE_END.length)
    : text.trimEnd() + "\n\n" + section + "\n";
  fs.writeFileSync(file, next);
}

function ensureGitignore(root) {
  const file = path.join(root, ".gitignore");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^\/?\.office\/?\s*$/m.test(text)) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${text}${prefix}# Agent Office live state\n.office/\n`);
}

// Installs the office infrastructure. Agents and skills are written later by the PM.
export function installOfficeFiles(root, department) {
  fs.mkdirSync(root, { recursive: true });
  copyDir(path.join(TEMPLATE_WORKSPACE_DIR, ".claude", "hooks"), path.join(root, ".claude", "hooks"));
  copyDir(path.join(TEMPLATE_WORKSPACE_DIR, ".claude", "skills"), path.join(root, ".claude", "skills"));
  mergeSettings(path.join(root, ".claude", "settings.json"), path.join(TEMPLATE_WORKSPACE_DIR, ".claude", "settings.json"));
  writeClaudeMd(root, department);
  ensureGitignore(root);
  writeDepartmentFile(root, department);
  // The PM joins with a random name and the model the customer chose; the PM writes its own agent file.
  const store = new StaffStore(root);
  store.ensureIdentity("pm", { title: "Project Manager", role: "pm", model: store.has("pm") ? undefined : department.pmModel });
  store.setModel("pm", department.pmModel);
}

// ---------- git ----------

async function currentBranch(root) {
  const r = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  return r.ok ? r.out : null;
}

async function branchExists(root, name) {
  return (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFail: true })).ok;
}

async function hasCommits(root) {
  return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true })).ok;
}

async function isDirty(root) {
  return Boolean((await git(root, ["status", "--porcelain"])).out);
}

async function commitOfficeFiles(root, message, log) {
  await git(root, ["add", "CLAUDE.md", ".gitignore", ".claude"]);
  const staged = !(await git(root, ["diff", "--cached", "--quiet"], { allowFail: true })).ok;
  if (staged) {
    await git(root, ["commit", "-m", message]);
    log.push(`Committed the office config on ${await currentBranch(root)}.`);
  }
}

// Makes `target` contain everything in `source`; on conflicts the source wins (it is the latest code).
async function bringUpToDate(root, target, source, log) {
  await git(root, ["checkout", "-q", target]);
  const merge = await git(root, ["merge", "--no-ff", "-X", "theirs", source, "-m", `Bring ${source} into ${target}`], { allowFail: true });
  if (!merge.ok) {
    await git(root, ["merge", "--abort"], { allowFail: true });
    throw new Error(`Could not merge ${source} into ${target}: ${lastLines(merge)}`);
  }
  if (!/Already up to date/i.test(merge.out)) log.push(`Merged ${source} into ${target}.`);
}

async function connectRemote(root, repo, log, warnings) {
  const origin = await git(root, ["remote", "get-url", "origin"], { allowFail: true });
  if (repo && !origin.ok) {
    await git(root, ["remote", "add", "origin", repo]);
    log.push("Added the remote origin.");
  } else if (repo && origin.out !== repo) {
    warnings.push(`The remote origin is already ${origin.out}; it was not changed.`);
  }
  if (!repo && !origin.ok) return;
  const branches = ["main", "preview"];
  const current = await currentBranch(root);
  if (current && !branches.includes(current)) branches.push(current);
  for (const name of branches) {
    const push = await git(root, ["push", "-u", "origin", name], { allowFail: true });
    if (push.ok) log.push(`Pushed ${name}.`);
    else warnings.push(`Could not push ${name}: ${lastLines(push)}`);
  }
}

// A new project: an empty (or new) folder becomes a repository with main and preview.
export async function setupNewWorkspace(department) {
  const root = department.workspace;
  const log = [];
  const warnings = [];
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, ".git"))) {
    await git(root, ["init", "-q"]);
    log.push("Initialized a git repository.");
  }
  if (!(await hasCommits(root))) await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  installOfficeFiles(root, department);
  log.push("Installed the office config (hooks, /office skill, CLAUDE.md) and named the PM.");
  await commitOfficeFiles(root, `Set up Agent Office department: ${department.name}`, log);
  if (!(await hasCommits(root))) await git(root, ["commit", "--allow-empty", "-q", "-m", "Initial commit"]);
  if (!(await branchExists(root, "main"))) await git(root, ["branch", "main"]);
  if (!(await branchExists(root, "preview"))) {
    await git(root, ["branch", "preview", "main"]);
    log.push("Created the preview branch from main.");
  }
  await git(root, ["checkout", "-q", "preview"]);
  await connectRemote(root, department.repo, log, warnings);
  return { log, warnings };
}

// The branch that holds the office config of a migrated project until the customer confirms it.
export const MIGRATION_BRANCH = "feature_office_migration";

// An existing project: its current state is the latest code. Uncommitted work is committed on the current
// branch, then main and preview are brought up to date with that code. The office config goes to a separate
// branch (feature_office_migration) that reaches preview only when the customer confirms the migration.
export async function migrateWorkspace(department) {
  const root = department.workspace;
  const log = [];
  const warnings = [];
  if (!fs.existsSync(path.join(root, ".git"))) {
    await git(root, ["init", "-q"]);
    await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    log.push("Initialized a git repository.");
  }
  const branch = await currentBranch(root);
  if (!branch) throw new Error("The repository is in detached HEAD state. Check out a branch first.");
  if (await isDirty(root)) {
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", (await hasCommits(root))
      ? "Save uncommitted work before Agent Office migration" : "Import existing project"]);
    log.push(`Committed the uncommitted work on ${branch}.`);
  }
  if (!(await hasCommits(root))) await git(root, ["commit", "--allow-empty", "-q", "-m", "Initial commit"]);

  if (branch !== "main") {
    if (await branchExists(root, "main")) await bringUpToDate(root, "main", branch, log);
    else {
      await git(root, ["branch", "main", branch]);
      log.push(`Created main from ${branch}.`);
    }
  }
  if (await branchExists(root, "preview")) await bringUpToDate(root, "preview", "main", log);
  else {
    await git(root, ["branch", "preview", "main"]);
    log.push("Created the preview branch from main.");
  }

  let migrationBranch = MIGRATION_BRANCH;
  for (let i = 2; await branchExists(root, migrationBranch); i++) migrationBranch = `${MIGRATION_BRANCH}_${i}`;
  await git(root, ["checkout", "-q", "-b", migrationBranch, "preview"]);
  department.migration = { branch: migrationBranch, status: "pending" };
  installOfficeFiles(root, department);
  log.push("Installed the office config (hooks, /office skill, CLAUDE.md) and named the PM.");
  await commitOfficeFiles(root, `Set up Agent Office department: ${department.name}`, log);
  log.push(`The office config is on ${migrationBranch}. Confirm the migration to merge it into preview.`);
  await connectRemote(root, department.repo, log, warnings);
  return { log, warnings };
}

// Merges the migration branch into preview once the customer has checked the office setup.
export async function confirmMigration(root, branch) {
  if (await isDirty(root)) throw new Error("The workspace has uncommitted changes. Ask the PM to commit them first.");
  const log = [];
  await git(root, ["checkout", "-q", "preview"]);
  const merge = await git(root, ["merge", "--no-ff", branch, "-m", `Merge ${branch} into preview`], { allowFail: true });
  if (!merge.ok) {
    await git(root, ["merge", "--abort"], { allowFail: true });
    await git(root, ["checkout", "-q", branch], { allowFail: true });
    throw new Error(`Merge failed: ${lastLines(merge)}`);
  }
  log.push(`Merged ${branch} into preview.`);
  const origin = await git(root, ["remote", "get-url", "origin"], { allowFail: true });
  if (origin.ok) {
    const push = await git(root, ["push", "origin", "preview"], { allowFail: true });
    log.push(push.ok ? "Pushed preview." : `Could not push preview: ${lastLines(push)}`);
  }
  return { log };
}

// Existing Claude Code agents in a project, so the customer can choose which ones become staff.
export function listAgentFiles(root) {
  const dir = path.join(root, ".claude", "agents");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((file) => {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const pick = (key) => (text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m")) || [])[1] || "";
    return {
      id: path.basename(file, ".md"),
      description: pick("description").replace(/^["']|["']$/g, "").slice(0, 200),
      model: pick("model") || "inherit",
    };
  });
}

// Merges preview into main and pushes main. Only called when the customer releases from the dashboard.
export async function releaseToMain(root) {
  if (await isDirty(root)) throw new Error("The workspace has uncommitted changes. Ask the PM to commit them first.");
  const back = await currentBranch(root);
  const log = [];
  await git(root, ["checkout", "-q", "main"]);
  try {
    const merge = await git(root, ["merge", "--no-ff", "preview", "-m", "Release preview to main"], { allowFail: true });
    if (!merge.ok) {
      await git(root, ["merge", "--abort"], { allowFail: true });
      throw new Error(`Merge failed: ${lastLines(merge)}`);
    }
    log.push(/Already up to date/i.test(merge.out) ? "main is already up to date with preview." : "Merged preview into main.");
    const origin = await git(root, ["remote", "get-url", "origin"], { allowFail: true });
    if (origin.ok) {
      await git(root, ["push", "origin", "main"]);
      log.push("Pushed main.");
    }
  } finally {
    await git(root, ["checkout", "-q", back || "preview"], { allowFail: true });
  }
  return { log };
}

// ---------- folder picker ----------

function windowsDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(d)) drives.push(d); } catch { /* not ready */ }
  }
  return drives;
}

// Lists sub-folders of `dir` (drives on Windows when `dir` is empty).
export function listFolders(dir) {
  if (!dir) {
    if (process.platform === "win32") {
      return { path: "", parent: null, home: os.homedir(), folders: windowsDrives().map((d) => ({ name: d, path: d })) };
    }
    dir = "/";
  }
  const abs = path.resolve(dir);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name.toLowerCase()))
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? (process.platform === "win32" ? "" : null) : parent,
    home: os.homedir(),
    folders,
  };
}

// Describes a folder so the dashboard can suggest New, Open or Migrate.
export async function inspectFolder(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { path: abs, exists: false, suggest: "new" };
  if (!fs.statSync(abs).isDirectory()) throw new Error("This path is a file, not a folder.");
  const names = fs.readdirSync(abs);
  const visible = names.filter((n) => n !== ".git");
  const department = readDepartmentFile(abs);
  const hasOffice = Boolean(department) || fs.existsSync(path.join(abs, ".claude", "skills", "office", "SKILL.md"));
  const isGit = names.includes(".git");
  let origin = null;
  let branch = null;
  let dirty = false;
  if (isGit) {
    origin = (await git(abs, ["remote", "get-url", "origin"], { allowFail: true })).out || null;
    branch = await currentBranch(abs);
    dirty = Boolean((await git(abs, ["status", "--porcelain"], { allowFail: true })).out);
  }
  const suggest = hasOffice ? "open" : visible.length ? "migrate" : "new";
  return {
    path: abs, exists: true, empty: visible.length === 0, hasOffice, department, isGit, origin, branch, dirty,
    agents: hasOffice ? [] : listAgentFiles(abs),
    folders: names.filter((n) => !n.startsWith(".") && fs.statSync(path.join(abs, n)).isDirectory()).slice(0, 200),
    hasReadme: names.some((n) => /^readme/i.test(n)), suggest, name: path.basename(abs),
  };
}
