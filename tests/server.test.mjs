// Server tests: run with `npm test` (node --test, no dependencies). Git must be installed.
// Every test works in its own temporary folder; nothing touches real departments.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkRequest, hostName, normalizeHosts } from "../server/http-guard.mjs";
import { parseAgentFile, serializeAgentFile, StaffStore, isValidId } from "../server/staff-store.mjs";
import { Scheduler, parseResetTime, RESUME_PROMPT } from "../server/run-controller.mjs";
import { slugify, Department } from "../server/departments.mjs";
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

test("guard: a configured tunnel host name passes, others still do not", () => {
  const hosts = normalizeHosts(["https://Office.Example.com/", "office.example.com:443", ""]);
  assert.deepEqual(hosts, ["office.example.com", "office.example.com"]);
  assert.equal(checkRequest(request("GET", { host: "office.example.com" }), hosts), null);
  assert.equal(checkRequest(request("POST", {
    host: "office.example.com", origin: "https://office.example.com", "content-type": "application/json", "sec-fetch-site": "same-origin",
  }), hosts), null);
  assert.equal(checkRequest(request("GET", { host: "office.example.com" })).status, 403);
  assert.equal(checkRequest(request("GET", { host: "evil.example" }), hosts).status, 403);
  assert.equal(checkRequest(request("POST", {
    host: "office.example.com", origin: "https://evil.example", "content-type": "application/json",
  }), hosts).status, 403);
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
    assert.ok(person.look.accessory && ["short", "normal", "tall"].includes(person.look.build));
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

  assert.equal(renamed.deskSeed, 0);
  const moved = store.randomizeDesk("dev_fe");
  assert.ok(moved.deskSeed > 0, "a new desk is a new number");
  assert.equal(moved.name, renamed.name, "a new desk does not change the person");
  assert.equal(store.randomizeDesk("nobody"), null);

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

// ---------- room items ----------

test("room: swapped items are kept, checked and cleared by a new room", (t) => {
  const root = tempDir(t);
  const dept = new Department(department(root), { scheduler: new Scheduler(), broadcast() {} });
  dept.setRoomItem("wall.1", "artSea", 1234);
  dept.setRoomItem("lounge", "band", 7);
  assert.deepEqual(dept.info.roomItems, { "wall.1": { kind: "artSea", v: 234 }, lounge: { kind: "band", v: 7 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".office", "department.json"), "utf8")).roomItems.lounge, { kind: "band", v: 7 });
  assert.throws(() => dept.setRoomItem("../x", "artSea", 1), /Unknown room item/);
  assert.throws(() => dept.setRoomItem("wall.1", "<script>", 1), /Unknown room item/);
  dept.randomizeRoom();
  assert.equal(dept.info.roomItems, undefined);
  assert.ok(Number.isInteger(dept.info.roomSeed));
});

// ---------- message history and settings ----------

test("messages: the history is saved in the workspace and comes back after a restart", (t) => {
  const root = tempDir(t);
  const sent = [];
  const dept = new Department(department(root), { scheduler: new Scheduler(), broadcast: (type, data) => sent.push(type) });
  const m1 = dept.addMessage({ kind: "msg", from: "customer", to: "pm", text: "Build a shop" });
  dept.addMessage({ kind: "msg", from: "pm", to: "customer", text: "Which payment provider?" });
  dept.addMessage({ kind: "system", notice: true, text: "" });
  assert.ok(m1.id && m1.ts);
  assert.equal(sent.filter((type) => type === "message").length, 2, "an empty message is not kept");
  const again = new Department(department(root), { scheduler: new Scheduler(), broadcast() {} });
  const history = again.snapshot().messages;
  assert.deepEqual(history.map((m) => [m.from, m.text]), [["customer", "Build a shop"], ["pm", "Which payment provider?"]]);
});

test("settings: auto continue is off by default, saved with the department and checked", (t) => {
  const root = tempDir(t);
  const dept = new Department(department(root), { scheduler: new Scheduler(), broadcast() {} });
  assert.equal(dept.settings().autoResume, false);
  assert.equal(dept.publicInfo().settings.autoResume, false);
  assert.throws(() => dept.updateSettings({ autoResume: "yes" }), /true or false/);
  dept.updateSettings({ autoResume: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".office", "department.json"), "utf8")).settings.autoResume, true);
});

// ---------- usage limits ----------

test("usage limit: reset times are read from the CLI text", () => {
  const now = new Date(2026, 10, 20, 10, 0, 0).getTime();
  assert.equal(parseResetTime("Claude AI usage limit reached|1795161600", now), 1795161600 * 1000);
  assert.equal(parseResetTime("You've hit your limit · resets 3pm (Asia/Saigon)", now), new Date(2026, 10, 20, 15, 0).getTime());
  assert.equal(parseResetTime("5-hour limit reached ∙ resets 9:30am", now), new Date(2026, 10, 21, 9, 30).getTime(), "a passed time is tomorrow");
  assert.equal(parseResetTime("Something else went wrong", now), null);
});

test("usage limit: with auto continue on, the PM resumes the same session after the reset", (t) => {
  const root = tempDir(t);
  const dept = new Department(department(root), { scheduler: new Scheduler(), broadcast() {} });
  const runner = dept.runner;
  t.after(() => runner.cancelResume());
  const prompts = [];
  runner.spawnTurn = (prompt) => { prompts.push(prompt); runner.state.busy = true; };
  Object.assign(runner.state, { sessionId: "s-1", origin: "dashboard", busy: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;

  // Turned off: the limit is reported, nothing is planned.
  runner.handleLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } }));
  runner.handleLine(JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 3pm" }));
  runner.finish(null);
  assert.equal(runner.state.limit.resetsAt, resetsAt * 1000);
  assert.equal(runner.state.limit.type, "five_hour");
  assert.equal(runner.state.resumeAt, null);
  assert.match(dept.recentMessages().at(-1).text, /Usage limit reached/);

  // Turning it on afterwards plans the resume for the reset (plus a margin), and it survives a restart.
  dept.updateSettings({ autoResume: true });
  assert.ok(runner.state.resumeAt >= resetsAt * 1000 && runner.state.resumeAt <= resetsAt * 1000 + 120000);
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".office", "runner-state.json"), "utf8"));
  assert.equal(saved.resumeAt, runner.state.resumeAt);

  // At the reset, the PM gets the continue prompt in the same session.
  assert.equal(runner.resumeNow(), true);
  assert.equal(prompts.at(-1), RESUME_PROMPT);
  assert.equal(runner.state.sessionId, "s-1");

  // A turn that works again clears the limit; turning the setting off cancels a planned resume.
  runner.finish(null);
  assert.equal(runner.state.limit, null);
  Object.assign(runner.state, { busy: true });
  runner.handleLine(JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [] } }));
  runner.finish("Claude CLI exited with code 1");
  assert.ok(runner.state.resumeAt, "an unknown reset time is retried later");
  dept.updateSettings({ autoResume: false });
  assert.equal(runner.state.resumeAt, null);
});

test("usage limit: an ordinary error does not count as a limit", (t) => {
  const root = tempDir(t);
  const dept = new Department(department(root), { scheduler: new Scheduler(), broadcast() {} });
  dept.updateSettings({ autoResume: true });
  Object.assign(dept.runner.state, { sessionId: "s-2", origin: "dashboard", busy: true });
  dept.runner.handleLine(JSON.stringify({ type: "result", is_error: true, result: "Tool failed" }));
  dept.runner.finish(null);
  assert.equal(dept.runner.state.limit, null);
  assert.equal(dept.runner.state.resumeAt, null);
  assert.match(dept.recentMessages().at(-1).text, /The PM stopped: Tool failed/);
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
