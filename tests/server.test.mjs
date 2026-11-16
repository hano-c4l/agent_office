// Server tests: run with `npm test` (node --test, no dependencies). Git must be installed.
// Every test works in its own temporary folder; nothing touches real departments.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkRequest, hostName } from "../server/http-guard.mjs";
import { parseAgentFile, serializeAgentFile, StaffStore, isValidId } from "../server/staff-store.mjs";
import { Scheduler } from "../server/run-controller.mjs";
import { slugify } from "../server/departments.mjs";
import { guessRole, titleFromId, randomPerson } from "../server/people.mjs";
import {
  git, isValidRepoUrl, setupNewWorkspace, migrateWorkspace, confirmMigration, releaseToMain,
  officeFilesOutdated, updateOfficeFiles, inspectFolder, MIGRATION_BRANCH,
} from "../server/workspace-setup.mjs";

// Commits made by the tests do not depend on the machine's git identity.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Agent Office Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Agent Office Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-office-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const department = (workspace, extra = {}) => ({
  id: "shop", name: "Shop", pmModel: "sonnet", workspace, repo: "", mode: "new", createdAt: "2026-01-01T00:00:00.000Z", ...extra,
});

// ---------- request guard ----------

const request = (method, headers) => ({ method, headers });

test("guard: the dashboard's own requests pass", () => {
  assert.equal(checkRequest(request("GET", { host: "localhost:5178" })), null);
  assert.equal(checkRequest(request("POST", {
    host: "127.0.0.1:5178", origin: "http://127.0.0.1:5178", "content-type": "application/json", "sec-fetch-site": "same-origin",
  })), null);
  assert.equal(checkRequest(request("DELETE", { host: "[::1]:5178", "content-type": "application/json; charset=utf-8" })), null);
});

test("guard: other sites and rebound host names are refused", () => {
  assert.equal(checkRequest(request("GET", { host: "evil.example:5178" })).status, 403);
  assert.equal(checkRequest(request("POST", {
    host: "localhost:5178", origin: "https://evil.example", "content-type": "application/json",
  })).status, 403);
  assert.equal(checkRequest(request("GET", { host: "localhost:5178", "sec-fetch-site": "cross-site" })).status, 403);
});

test("guard: writes need a JSON content type and a known method", () => {
  assert.equal(checkRequest(request("POST", { host: "localhost:5178", "content-type": "text/plain" })).status, 415);
  assert.equal(checkRequest(request("POST", { host: "localhost:5178" })).status, 415);
  assert.equal(checkRequest(request("OPTIONS", { host: "localhost:5178" })).status, 405);
  assert.equal(hostName("[::1]:5178"), "[::1]");
});

// ---------- small helpers ----------

test("slugify handles Vietnamese names and empty input", () => {
  assert.equal(slugify("Cửa hàng Đồ Gỗ!"), "cua-hang-do-go");
  assert.equal(slugify("   "), "department");
});

test("ids, roles and titles", () => {
  assert.ok(isValidId("dev_be-2"));
  assert.ok(!isValidId("../pm"));
  assert.ok(!isValidId("Dev"));
  assert.equal(guessRole("qa_tester"), "test");
  assert.equal(guessRole("code_analyst"), "other");
  assert.equal(guessRole("frontend dev"), "dev");
  assert.equal(titleFromId("dev_be"), "Dev BE");
});

test("randomPerson avoids taken names", () => {
  for (let i = 0; i < 50; i++) {
    const person = randomPerson(["Linh", "khoa"]);
    assert.ok(!["linh", "khoa"].includes(person.name.toLowerCase()));
    assert.ok(person.look.gender && person.look.hairStyle && person.look.outfit);
  }
});

test("repository URLs", () => {
  assert.ok(isValidRepoUrl(""));
  assert.ok(isValidRepoUrl("https://github.com/you/repo.git"));
  assert.ok(isValidRepoUrl("git@github.com:you/repo.git"));
  assert.ok(!isValidRepoUrl("--upload-pack=evil"));
  assert.ok(!isValidRepoUrl("file:///etc"));
});

// ---------- agent files ----------

test("agent frontmatter survives a round trip, unknown keys included", () => {
  const text = [
    "---", "name: dev_be", 'description: "Backend: APIs and data"', "model: sonnet", "tools: Read, Write, Bash",
    "skills:", "  - nodejs", "  - rest-api", "color: blue", "---", "You build the backend.", "",
  ].join("\n");
  const parsed = parseAgentFile(text);
  assert.deepEqual(parsed.front.tools, ["Read", "Write", "Bash"]);
  assert.deepEqual(parsed.front.skills, ["nodejs", "rest-api"]);
  assert.equal(parsed.front.description, "Backend: APIs and data");
  assert.equal(parsed.front.color, "blue");
  const again = parseAgentFile(serializeAgentFile(parsed.front, parsed.order, parsed.body));
  assert.deepEqual(again.front, parsed.front);
  assert.equal(again.body, "You build the backend.");
});

test("a file without frontmatter is all body", () => {
  assert.deepEqual(parseAgentFile("Just text").front, {});
});

// ---------- staff store ----------

test("staff: hire, edit, assistant round trip keeps the identity, dismiss", (t) => {
  const root = tempDir(t);
  const store = new StaffStore(root);
  const hired = store.save({ id: "dev_fe", title: "Frontend Developer", role: "dev", model: "sonnet", prompt: "Build the UI.", skills: ["react"], tools: ["Read"] });
  assert.equal(hired.id, "dev_fe");
  assert.ok(hired.name && hired.look.gender, "new staff get a random name and look");
  assert.deepEqual(hired.missingSkills, ["react"]);

  store.setHelper("dev_fe", true);
  assert.equal(store.list().length, 0);
  assert.deepEqual(store.helpers().map((h) => h.id), ["dev_fe"]);

  store.setHelper("dev_fe", false);
  const back = store.get("dev_fe");
  assert.equal(back.name, hired.name, "the same person comes back");
  assert.deepEqual(back.look, hired.look);

  const renamed = store.randomize("dev_fe");
  assert.equal(renamed.title, "Frontend Developer");

  assert.equal(store.dismiss("dev_fe"), true);
  assert.equal(store.get("dev_fe"), null);
  assert.equal(fs.readdirSync(store.dismissedDir).length, 1);
});

test("staff: staged agents and skills are installed, bad names are ignored", (t) => {
  const root = tempDir(t);
  const store = new StaffStore(root);
  const staging = path.join(root, ".office", "team");
  fs.mkdirSync(path.join(staging, "agents"), { recursive: true });
  fs.mkdirSync(path.join(staging, "skills", "graphql"), { recursive: true });
  fs.writeFileSync(path.join(staging, "agents", "qa.md"), "---\nname: qa\ndescription: Tests\nmodel: haiku\n---\nTest things.\n");
  fs.writeFileSync(path.join(staging, "agents", "Not Valid.md"), "nope");
  fs.writeFileSync(path.join(staging, "skills", "graphql", "SKILL.md"), "---\nname: graphql\ndescription: GraphQL\n---\n");
  assert.deepEqual(store.installStaged().sort(), ["agent qa", "skill graphql"]);
  assert.ok(store.has("qa"));
  assert.ok(store.hasSkill("graphql"));
  assert.ok(!fs.existsSync(path.join(store.agentsDir, "Not Valid.md")));
  store.ensureAllIdentities();
  assert.equal(store.get("qa").role, "test");
});

// ---------- scheduler ----------

test("scheduler runs at most maxParallelRuns and hands the slot on", () => {
  const scheduler = new Scheduler();
  const started = [];
  const owners = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
  owners.forEach((owner) => scheduler.acquire(owner, () => started.push(owner.name)));
  const limit = started.length;
  assert.ok(limit >= 1 && limit < owners.length, "some runs wait");
  assert.equal(scheduler.cancel(owners[owners.length - 1]), true, "a waiting run can be cancelled");
  scheduler.release(owners[0]);
  assert.equal(started.length, limit + 1);
  assert.equal(scheduler.running.size, limit);
});

// ---------- workspace setup (git) ----------

test("new workspace: main and preview, office files, then an update of old office files", async (t) => {
  const root = tempDir(t);
  const dept = department(root);
  const setup = await setupNewWorkspace(dept);
  assert.deepEqual(setup.warnings, []);
  assert.equal((await git(root, ["symbolic-ref", "--short", "HEAD"])).out, "preview");
  assert.ok((await git(root, ["rev-parse", "--verify", "refs/heads/main"])).ok);
  assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "office", "SKILL.md")));
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /# Shop \(Agent Office department\)/);
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.office\/$/m);
  assert.equal((await git(root, ["status", "--porcelain"])).out, "", "the setup is committed");
  assert.equal(officeFilesOutdated(root, dept), false);

  const folder = await inspectFolder(root);
  assert.equal(folder.suggest, "open");
  assert.equal(folder.department.name, "Shop");

  // An older skill and a project hook of its own: the update replaces the first and keeps the second.
  fs.writeFileSync(path.join(root, ".claude", "skills", "office", "SKILL.md"), "old skill\n");
  const settingsFile = path.join(root, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  settings.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo mine" }] });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  await git(root, ["commit", "-q", "-am", "Old office files"]);
  assert.equal(officeFilesOutdated(root, dept), true);

  const update = await updateOfficeFiles(root, dept);
  assert.deepEqual(update.warnings, []);
  assert.equal(officeFilesOutdated(root, dept), false);
  assert.equal((await git(root, ["status", "--porcelain"])).out, "");
  assert.equal((await git(root, ["log", "-1", "--format=%s"])).out, "Update Agent Office files");
  const merged = JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks.Stop;
  assert.equal(merged.length, 2);
  assert.equal(merged[0].hooks[0].command, "echo mine");

  // Release: preview reaches main and the workspace returns to preview.
  const release = await releaseToMain(root);
  assert.match(release.log.join(" "), /Merged preview into main/);
  assert.equal((await git(root, ["symbolic-ref", "--short", "HEAD"])).out, "preview");
  assert.equal((await git(root, ["log", "-1", "--format=%s", "main"])).out, "Release preview to main");
});

test("migration: the office setup waits on its own branch until it is confirmed", async (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, "app.js"), "console.log('hi');\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# My project\n\nOwn rules.\n");
  await git(root, ["init", "-q"]);
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
  const dept = department(root, { mode: "migrate" });
  const setup = await migrateWorkspace(dept);
  assert.equal(dept.migration.branch, MIGRATION_BRANCH);
  assert.equal(dept.migration.status, "pending");
  assert.match(setup.log.join(" "), /Committed the uncommitted work on develop/);
  assert.equal((await git(root, ["symbolic-ref", "--short", "HEAD"])).out, MIGRATION_BRANCH);

  // preview has the code but not the office files yet.
  assert.ok((await git(root, ["cat-file", "-e", "preview:app.js"], { allowFail: true })).ok);
  assert.ok(!(await git(root, ["cat-file", "-e", "preview:.claude/settings.json"], { allowFail: true })).ok);
  const claudeMd = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.match(claudeMd, /^# My project/);
  assert.match(claudeMd, /agent-office:start/);

  await confirmMigration(root, dept.migration.branch);
  assert.equal((await git(root, ["symbolic-ref", "--short", "HEAD"])).out, "preview");
  assert.ok((await git(root, ["cat-file", "-e", "preview:.claude/settings.json"], { allowFail: true })).ok);
  assert.ok(!(await git(root, ["cat-file", "-e", "main:.claude/settings.json"], { allowFail: true })).ok, "main only changes on release");
});
