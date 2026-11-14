// Agent Office company dashboard: a floor plan of departments (one per project), a room view per
// department with its staff, task board, activity feed and the client desk to talk to the PM,
// plus HR editing, team proposals and creating new departments.
// Live mode talks to server/office-server.mjs; ?demo (or no server) shows sample departments.

const STATUS_LABELS = {
  idle: "Idle", thinking: "Thinking", working: "Working", talking: "Talking",
  waiting: "Needs you", error: "Error", done: "Done",
};
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Skill"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BUBBLE_MS = 7000;
const MAX_FEED = 150;
const DONE_PREVIEW = 5;
const PANEL_DONE_PREVIEW = 3;

const state = {
  live: false,
  demo: false,
  depts: new Map(),
  library: [],
  defaults: { workspaceRoot: "", models: MODELS },
  maxParallelRuns: 2,
  view: null, // department id, or null for the company floor
  selectedId: null,
  detailsOpen: false,
  draft: null,
  proposal: null, // editable copy of the current department's pending proposal
  proposalDismissed: new Set(),
  board: { owner: "all", q: "", showAllDone: false },
  feedTab: "messages",
  panelShowDone: false,
};

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (str) => String(str ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (d = new Date()) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function slugify(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

const cur = () => (state.view ? state.depts.get(state.view) : null);

function withRuntime(config) {
  return { ...config, status: "idle", actions: [], files: [], bubble: null };
}

function makeDept(snap) {
  const d = {
    id: snap.info.id, info: snap.info, agents: [], tasks: [], feed: [],
    proposalRaw: null, run: null, runner: {}, liveWaiting: null,
  };
  applySnapshot(d, snap);
  return d;
}

function applySnapshot(d, snap) {
  d.info = snap.info;
  d.feed = [];
  setStaff(d, snap.staff || []);
  d.helpers = snap.helpers || [];
  setTasks(d, snap.tasks);
  d.run = snap.run;
  d.runner = snap.runner || {};
  d.proposalRaw = snap.proposal;
  (snap.events || []).forEach((ev) => applyEvent(d, ev, true));
  // Statuses replayed from an old run should not stay "working".
  if (!d.runner.busy) d.agents.forEach((a) => { a.status = "idle"; a.bubble = null; });
}

function findAgent(d, id) {
  return d && d.agents.find((a) => a.id === id);
}

function agentTasks(d, id) {
  return d.tasks.filter((t) => t.owner === id);
}

function agentProgress(d, id) {
  const tasks = agentTasks(d, id);
  if (!tasks.length) return 0;
  return Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length);
}

function deptProgress(d) {
  if (!d.tasks.length) return 0;
  return Math.round(d.tasks.reduce((sum, t) => sum + t.progress, 0) / d.tasks.length);
}

function addAction(agent, text, time = fmtTime()) {
  if (!agent || !agent.actions || !text) return;
  agent.actions.unshift({ time, text });
  agent.actions.length = Math.min(agent.actions.length, 30);
}

function pushFeed(d, item) {
  d.feed.unshift({ time: fmtTime(), ...item });
  d.feed.length = Math.min(d.feed.length, MAX_FEED);
}

// The PM's real name (random per department).
function pmName(d) {
  const pm = d && findAgent(d, "pm");
  return pm ? pm.name : "The PM";
}

function nameOf(d, id) {
  if (id === "customer") return "You";
  const a = findAgent(d, id);
  return a ? a.name : id;
}

function runActive(d) {
  const r = d.runner || {};
  return Boolean(r.sessionId && (r.busy || (d.run && d.run.status === "running")));
}

function proposalPending(d) {
  const p = d.proposalRaw;
  return Boolean(p && p.status === "pending" && Array.isArray(p.members));
}

// The department needs the customer: a team to approve, or the PM waiting for a reply.
function needsYou(d) {
  if (proposalPending(d)) return "Team proposal waiting for your approval";
  if (d.liveWaiting) return d.liveWaiting;
  const r = d.runner || {};
  if (!r.busy && r.sessionId && d.run && d.run.status === "running") return `${pmName(d)} is waiting for your reply`;
  return null;
}

function displayStatus(d, a) {
  const r = d.runner || {};
  if (a.id === "pm") {
    if (r.busy) return r.waitingSlot ? "idle" : (a.status === "idle" ? "thinking" : a.status);
    if (needsYou(d)) return "waiting";
    if (r.lastError) return "error";
    if (d.run && d.run.status === "done") return "done";
    return a.status === "waiting" ? "waiting" : "idle";
  }
  return a.status || "idle";
}

function deptStatus(d) {
  const r = d.runner || {};
  if (d.info.missing) return { key: "error", label: "Workspace missing" };
  if (needsYou(d)) return { key: "waiting", label: "Needs you" };
  if (r.waitingSlot) return { key: "queued", label: "Queued" };
  if (r.busy) return { key: "working", label: "Working" };
  if (r.lastError) return { key: "error", label: "Error" };
  if (d.run && d.run.status === "done") return { key: "done", label: "Delivered" };
  if (!r.sessionId && !d.tasks.length) return { key: "idle", label: "Waiting for a request" };
  return { key: "idle", label: "Idle" };
}

// ---------- applying live data ----------

function setStaff(d, staff) {
  const old = new Map(d.agents.map((a) => [a.id, a]));
  d.agents = staff.map((cfg) => {
    const prev = old.get(cfg.id);
    return prev
      ? { ...cfg, status: prev.status, actions: prev.actions, files: prev.files, bubble: prev.bubble }
      : withRuntime(cfg);
  });
}

function setTasks(d, data) {
  const list = Array.isArray(data) ? data : (data && data.tasks) || [];
  d.tasks = list.map((t) => ({
    id: String(t.id ?? ""), title: t.title || "", owner: t.owner || "unassigned",
    status: ["todo", "doing", "done"].includes(t.status) ? t.status : "todo",
    progress: Math.max(0, Math.min(100, Number(t.progress) || (t.status === "done" ? 100 : 0))),
  }));
}

function showBubble(d, agent, text, replay) {
  if (!agent || replay || !text) return;
  agent.bubble = text.slice(0, 160);
  const shown = agent.bubble;
  setTimeout(() => {
    if (agent.bubble === shown) { agent.bubble = null; renderDept(d); }
  }, BUBBLE_MS);
}

function setStatus(agent, status) {
  if (agent && agent.actions) agent.status = status;
}

function fromDashboardRunner(d, ev) {
  return d.runner && ev.session === d.runner.sessionId && d.runner.origin === "dashboard";
}

function applyEvent(d, ev, replay = false) {
  const time = ev.ts ? fmtTime(new Date(ev.ts)) : fmtTime();
  const id = ev.agent === "main" ? "pm" : ev.agent;
  const agent = findAgent(d, id);
  const who = agent ? agent.name : ev.agent;

  switch (ev.hook) {
    case "UserPromptSubmit": {
      d.liveWaiting = null;
      // Messages sent from the dashboard are already in the feed (added when sent).
      if (fromDashboardRunner(d, ev)) break;
      setStatus(findAgent(d, "pm"), "thinking");
      pushFeed(d, { kind: "msg", from: "customer", to: "pm", text: ev.text, time });
      break;
    }
    case "PreToolUse": {
      if (ev.tool === "Agent" || ev.tool === "Task") {
        const target = findAgent(d, ev.target);
        setStatus(agent, "talking");
        setStatus(target, "thinking");
        addAction(agent, `Assigned ${target ? target.name : ev.target}: ${ev.text || ""}`, time);
        if (target) addAction(target, `Task from ${who}: ${ev.text || ""}`, time);
        showBubble(d, agent, `@${target ? target.name : ev.target}: ${ev.text || ""}`, replay);
        pushFeed(d, { kind: "msg", from: id, to: target ? target.id : ev.target, text: ev.text || "(new task)", time });
        break;
      }
      setStatus(agent, READ_TOOLS.has(ev.tool) ? "thinking" : "working");
      const what = ev.file || ev.detail || "";
      addAction(agent, `${ev.tool}${what ? " " + what : ""}`, time);
      if (WRITE_TOOLS.has(ev.tool) || ev.tool === "Bash" || ev.tool === "PowerShell") {
        pushFeed(d, { kind: "log", from: id, text: `${ev.tool} ${what}`.trim(), time });
      }
      break;
    }
    case "PostToolUse": {
      if (ev.file && agent && agent.files && !agent.files.includes(ev.file)) agent.files.unshift(ev.file);
      break;
    }
    case "PostToolUseFailure": {
      addAction(agent, `${ev.tool} failed`, time);
      break;
    }
    case "SubagentStart": {
      setStatus(agent, "working");
      addAction(agent, "Started working", time);
      break;
    }
    case "SubagentStop": {
      setStatus(agent, "idle");
      addAction(agent, "Reported back to the PM", time);
      if (ev.text) {
        showBubble(d, agent, ev.text, replay);
        pushFeed(d, { kind: "msg", from: id, to: "pm", text: ev.text, time });
      }
      break;
    }
    case "Stop": {
      if (ev.agent !== "main") break;
      setStatus(findAgent(d, "pm"), "idle");
      // Dashboard-driven turns get the full reply through "pm-reply"; skip the clipped hook copy.
      if (!fromDashboardRunner(d, ev) && ev.text) {
        showBubble(d, findAgent(d, "pm"), ev.text, replay);
        pushFeed(d, { kind: "msg", from: "pm", to: "customer", text: ev.text, time });
      }
      break;
    }
    case "Notification": {
      setStatus(agent || findAgent(d, "pm"), "waiting");
      d.liveWaiting = `${who} needs you in Claude: ${ev.text || ev.detail || "waiting for input"}`;
      pushFeed(d, { kind: "system", notice: true, text: d.liveWaiting, time });
      break;
    }
    default:
      break;
  }
}

// ---------- rendering: rooms ----------

// Builds the room once per staff layout, then only updates classes and overlays,
// so CSS animations keep running smoothly between events.
function syncRoom(el, d, { mini = false } = {}) {
  const sig = `${roomSeed(d)}#` + d.agents.map((a) => `${a.id}:${a.role}:${a.name}:${a.title}:${a.pending}:${JSON.stringify(a.look)}`).join("|");
  if (el.dataset.sig !== sig) {
    const { svg, layout } = roomSvg(d.agents, roomSeed(d));
    const pct = (v, total) => `${(v / total) * 100}%`;
    el.style.aspectRatio = `${layout.width} / ${layout.height}`;
    el.innerHTML = svg + `<div class="room-overlay">${layout.seats.map((s) => `
      <button class="seat" data-id="${esc(s.agent.id)}" tabindex="${mini ? -1 : 0}"
        style="left:${pct(s.x, layout.width)};top:${pct(s.y - 8, layout.height)};width:${pct(s.w, layout.width)};height:${pct(s.h + 8, layout.height)}"
        aria-label="${esc(s.agent.name)}, ${esc(s.agent.title)}"></button>
      <div class="tag" data-tag="${esc(s.agent.id)}" style="left:${pct(s.x + s.w / 2, layout.width)};top:${pct(s.tagY ?? s.y + s.h - 2, layout.height)}">
        <b>${esc(s.agent.name)}</b><span>${esc(s.agent.pending ? `${s.agent.title} · joining` : s.agent.title)}</span></div>
      <div class="say" data-say="${esc(s.agent.id)}" hidden
        style="left:${pct(s.x + s.w / 2, layout.width)};top:${pct(s.sayY ?? s.y - 6, layout.height)}"></div>`).join("")}
      ${d.agents.length ? "" : `<div class="room-empty">No staff yet</div>`}</div>
      ${mini ? "" : `<button class="room-dice" data-room-dice title="New random room look: layout, furniture, decoration" aria-label="Randomize the room look">🎲 Room</button>`}`;
    el.dataset.sig = sig;
  }
  d.agents.forEach((a) => {
    const status = displayStatus(d, a);
    const ws = el.querySelector(`g.ws[data-agent="${CSS.escape(a.id)}"]`);
    if (ws) ws.setAttribute("class", `ws st-${status}${a.pending ? " pending" : ""}`);
    const tag = el.querySelector(`[data-tag="${CSS.escape(a.id)}"]`);
    if (tag) {
      tag.className = `tag tag-${status}${a.pending ? " pending" : ""}${state.selectedId === a.id && !mini ? " selected" : ""}`;
    }
    const say = el.querySelector(`[data-say="${CSS.escape(a.id)}"]`);
    if (say) {
      say.hidden = mini || !a.bubble;
      if (a.bubble && say.textContent !== a.bubble) say.textContent = a.bubble;
    }
  });
}

// The room look comes from a seed; older departments use their theme number.
function roomSeed(d) {
  const info = d.info || {};
  return Number.isInteger(info.roomSeed) ? info.roomSeed : (Number.isInteger(info.theme) ? info.theme : 0);
}

function renderDept(d) {
  if (!d) return;
  const card = document.querySelector(`.room-card[data-dept="${CSS.escape(d.id)}"]`);
  if (card) updateCard(card, d);
  if (state.view === d.id) renderRoomView();
}

function renderAll() {
  renderTopbar();
  $("#floorView").hidden = Boolean(state.view);
  $("#roomView").hidden = !state.view;
  if (state.view && !cur()) state.view = null;
  if (state.view) renderRoomView();
  else renderFloor();
  renderPanel();
}

function renderTopbar() {
  const depts = [...state.depts.values()];
  const active = depts.filter((d) => d.runner.busy).length;
  const waiting = depts.filter((d) => needsYou(d)).length;
  const staff = depts.reduce((n, d) => n + d.agents.length, 0);
  const cost = depts.reduce((n, d) => n + (d.runner.costUsd || 0), 0);
  $("#companyStats").innerHTML = [
    `<span><b>${depts.length}</b> departments</span>`,
    `<span><b>${staff}</b> staff</span>`,
    `<span><b>${active}</b>/${state.maxParallelRuns} running</span>`,
    waiting ? `<span class="stat-alert"><b>${waiting}</b> need you</span>` : "",
    cost ? `<span class="muted">~$${cost.toFixed(2)}</span>` : "",
  ].join("");
}

function renderFloor() {
  const grid = $("#floorGrid");
  const ids = [...state.depts.keys()];
  // Remove cards of departments that are gone.
  grid.querySelectorAll(".room-card[data-dept]").forEach((c) => { if (!state.depts.has(c.dataset.dept)) c.remove(); });
  ids.forEach((id) => {
    let card = grid.querySelector(`.room-card[data-dept="${CSS.escape(id)}"]`);
    if (!card) {
      card = document.createElement("article");
      card.className = "room-card";
      card.dataset.dept = id;
      card.tabIndex = 0;
      card.innerHTML = `<header class="card-head"></header><div class="room mini"></div><footer class="card-foot"></footer>`;
      grid.insertBefore(card, $("#newDeptTile"));
    }
    updateCard(card, state.depts.get(id));
  });
  $("#floorEmpty").hidden = ids.length > 0;
}

function updateCard(card, d) {
  const st = deptStatus(d);
  const p = deptProgress(d);
  const done = d.tasks.filter((t) => t.status === "done").length;
  card.setAttribute("aria-label", `${d.info.name}: ${st.label}. Open department`);
  card.classList.toggle("alert", st.key === "waiting");
  card.querySelector(".card-head").innerHTML = `
    <h3>${esc(d.info.name)}</h3>
    <span class="badge badge-${st.key}">${esc(st.label)}</span>`;
  card.querySelector(".card-foot").innerHTML = `
    <div class="project-progress"><div class="bar"><i style="width:${p}%"></i></div><b>${p}%</b></div>
    <div class="card-meta"><span>${d.agents.length} staff</span><span>${done}/${d.tasks.length} tasks</span>
      ${d.runner.costUsd ? `<span>~$${d.runner.costUsd.toFixed(2)}</span>` : ""}</div>
    ${needsYou(d) ? `<div class="card-alert">✋ ${esc(needsYou(d))}</div>` : ""}`;
  syncRoom(card.querySelector(".room"), d, { mini: true });
}

function renderRoomView() {
  const d = cur();
  if (!d) return;
  const info = d.info;
  const p = deptProgress(d);
  $("#roomName").textContent = info.name;
  $("#roomMeta").innerHTML = [
    `<span title="Workspace">📁 <code>${esc(info.workspace)}</code></span>`,
    info.repo ? `<span title="Repository">🔗 <a href="${esc(info.repo.replace(/\.git$/, ""))}" target="_blank" rel="noopener">${esc(info.repo)}</a></span>` : `<span class="muted">No remote repository</span>`,
    info.missing ? `<span class="err">The workspace folder is missing.</span>` : "",
  ].join("");
  $("#roomBar").style.width = p + "%";
  $("#roomPct").textContent = p + "%";
  const warnings = (info.setup && info.setup.warnings) || [];
  $("#setupWarn").hidden = !warnings.length;
  $("#setupWarn").innerHTML = warnings.map((w) => `⚠ ${esc(w)}`).join("<br>");
  const migration = info.migration;
  $("#migrationBanner").hidden = !(migration && migration.status === "pending");
  if (migration && migration.status === "pending") {
    $("#migrationText").innerHTML = `The office setup is on <code>${esc(migration.branch)}</code>. Check it (team, overview), then confirm to merge it into <code>preview</code>.`;
    $("#confirmMigrationBtn").disabled = Boolean(d.runner.busy);
  }
  const helpers = d.helpers || [];
  $("#helpersStrip").hidden = !helpers.length;
  $("#helpersStrip").innerHTML = helpers.length ? `<span class="muted">Assistants (no tasks):</span>` + helpers.map((h) =>
    `<span class="helper-chip" title="${esc(h.description)}">${esc(h.id)} <span class="muted">${esc(h.model)}</span>
      <button class="btn small" data-make-staff="${esc(h.id)}">Move to staff</button></span>`).join("") : "";
  $("#releaseBtn").hidden = state.demo;
  $("#removeDeptBtn").hidden = state.demo;
  syncRoom($("#roomStage"), d);
  renderBoard(d);
  renderClientDesk(d);
  renderFeed(d);
  maybeOpenProposal(d);
}

// Natural order for task ids: T2 before T10.
function byTaskId(a, b) {
  return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
}

function taskMatches(d, t) {
  const f = state.board;
  if (f.owner !== "all" && t.owner !== f.owner) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return [t.id, t.title, nameOf(d, t.owner)].some((x) => String(x).toLowerCase().includes(q));
}

function taskCard(d, t) {
  return `<div class="card" data-id="${esc(t.owner)}" tabindex="0" title="${esc(t.title)}">
    <div class="card-top"><b>${esc(t.id)}</b><span>${esc(nameOf(d, t.owner))}</span></div>
    <div class="card-title">${esc(t.title)}</div>
    ${t.status === "done" ? "" : `<div class="mini-bar"><i style="width:${t.progress}%"></i></div>`}</div>`;
}

// Task board with search and owner filter. Columns scroll; Done shows the latest few until expanded.
function renderBoard(d) {
  const owners = [...new Set(d.tasks.map((t) => t.owner))];
  const select = $("#taskOwner");
  const options = `<option value="all">Everyone</option>` + owners.map((o) =>
    `<option value="${esc(o)}">${esc(nameOf(d, o))}</option>`).join("");
  if (select.dataset.options !== options) {
    select.innerHTML = options;
    select.dataset.options = options;
  }
  if (state.board.owner !== "all" && !owners.includes(state.board.owner)) state.board.owner = "all";
  select.value = state.board.owner;

  const shown = d.tasks.filter((t) => taskMatches(d, t));
  const filtered = shown.length !== d.tasks.length;
  $("#taskCount").textContent = d.tasks.length ? (filtered ? `${shown.length} of ${d.tasks.length}` : `${d.tasks.length} tasks`) : "";
  const cols = { todo: "To do", doing: "Doing", done: "Done" };
  $("#board").innerHTML = Object.entries(cols).map(([key, label]) => {
    let items = shown.filter((t) => t.status === key).sort(byTaskId);
    // Latest finished work first.
    if (key === "done") items = items.reverse();
    const limit = key === "done" && !state.board.showAllDone ? DONE_PREVIEW : Infinity;
    const hidden = Math.max(0, items.length - limit);
    return `<div class="col col-${key}"><h3>${label} <span>${items.length}</span></h3>
      <div class="col-cards">${items.slice(0, limit).map((t) => taskCard(d, t)).join("") ||
        `<p class="muted col-empty">${filtered ? "No match" : "Nothing here"}</p>`}</div>
      ${hidden ? `<button class="btn small more-btn" data-board-more>Show ${hidden} more</button>` : ""}
      ${key === "done" && state.board.showAllDone && items.length > DONE_PREVIEW
        ? `<button class="btn small more-btn" data-board-less>Show less</button>` : ""}</div>`;
  }).join("");
}

// Messages: what the customer reads or answers (the PM's messages, your own, important notices).
// Activity: everything the team does (tools, delegation, reports, logs).
function isMessage(f) {
  if (f.kind === "msg") return f.from === "customer" || f.to === "customer";
  return f.kind === "system" && Boolean(f.notice);
}

function renderFeed(d) {
  const messages = d.feed.filter(isMessage);
  const activity = d.feed.filter((f) => !isMessage(f));
  const waiting = needsYou(d);
  const lastPm = messages.find((f) => f.kind === "msg" && f.from !== "customer");
  $("#messages").innerHTML = messages.map((f) => {
    if (f.kind === "system") return `<li class="msg-notice"><time>${f.time}</time>${esc(f.text)}</li>`;
    const mine = f.from === "customer";
    const ask = !mine && waiting && f === lastPm;
    return `<li class="chat ${mine ? "mine" : "theirs"}${ask ? " ask" : ""}">
      <div class="chat-head"><b>${esc(mine ? "You" : nameOf(d, f.from))}</b><time>${f.time}</time>
        ${ask ? `<span class="ask-tag">Needs your reply</span>` : ""}</div>
      <p>${esc(f.text)}</p></li>`;
  }).join("") || `<li class="empty">No messages yet. Send a request to ${esc(pmName(d))} at the client desk.</li>`;

  $("#feed").innerHTML = activity.map((f) => {
    if (f.kind === "system") return `<li class="feed-system">${esc(f.text)}</li>`;
    if (f.kind === "log") {
      return `<li class="feed-log"><time>${f.time}</time><b>${esc(nameOf(d, f.from))}</b> ${esc(f.text)}</li>`;
    }
    const head = `<time>${f.time}</time><b>${esc(nameOf(d, f.from))}</b> → <b>${esc(nameOf(d, f.to))}</b>`;
    return `<li class="feed-msg">${head}<p>${esc(f.text)}</p></li>`;
  }).join("") || `<li class="empty">No team activity yet.</li>`;

  // Unread messages while the Activity tab is open.
  if (state.feedTab === "messages") d.seenMessages = messages.length;
  const unread = Math.max(0, messages.length - (d.seenMessages || 0));
  $("#msgBadge").hidden = !unread;
  $("#msgBadge").textContent = unread;
  $("#messages").hidden = state.feedTab !== "messages";
  $("#feed").hidden = state.feedTab !== "activity";
  document.querySelectorAll("[data-feed-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.feedTab === state.feedTab);
    b.setAttribute("aria-selected", String(b.dataset.feedTab === state.feedTab));
  });
}

function runnerMode(d) {
  if (!runActive(d)) return "new";
  return d.runner.origin === "chat" ? "takeover" : "reply";
}

function renderClientDesk(d) {
  const r = d.runner || {};
  const mode = runnerMode(d);
  const parts = [];
  if (r.waitingSlot) parts.push(`<span class="dot-busy queued"></span>Queued: ${state.maxParallelRuns} departments are already running.`);
  else if (r.busy) parts.push(`<span class="dot-busy"></span>${esc(pmName(d))} is working…${r.queued ? ` (${r.queued} message queued)` : ""}`);
  else if (mode === "new") parts.push(d.run && d.run.status === "done" ? "Project delivered. Send a new request any time." : `${esc(pmName(d))} is ready for your request.`);
  else if (mode === "takeover") parts.push("The PM is working with you in a Claude chat.");
  else parts.push(`${esc(pmName(d))} is waiting for your reply.`);
  if (r.costUsd) parts.push(`<span class="cost">~$${r.costUsd.toFixed(2)} so far</span>`);
  if (r.lastError) parts.push(`<span class="err">${esc(r.lastError.slice(0, 300))}</span>`);
  $("#runnerStatus").innerHTML = parts.join(" ");
  const req = (d.run && d.run.request) || (d.proposalRaw && d.proposalRaw.request) || "";
  $("#roomRequest").hidden = !req;
  $("#roomRequest").innerHTML = req ? `Request: <b>${esc(req)}</b>` : "";

  const alert = needsYou(d);
  $("#needBanner").hidden = !alert;
  $("#needText").textContent = alert || "";
  $("#reviewTeamBtn").hidden = !proposalPending(d);

  const input = $("#liveInput");
  input.placeholder = {
    new: "Describe what this department should build…",
    reply: `Reply to ${pmName(d)} (answers, changes, ok)…`,
    takeover: `Reply to ${pmName(d)} here (moves the conversation from chat to here)…`,
  }[mode];
  $("#liveSend").textContent = { new: "Send request", reply: "Send", takeover: "Take over & send" }[mode];
  $("#liveStop").hidden = !r.busy;
  $("#liveForm").classList.toggle("disabled", state.demo);
}

// ---------- navigation ----------

function openDept(id) {
  if (!state.depts.has(id)) return;
  state.view = id;
  state.selectedId = null;
  state.draft = null;
  state.board = { owner: "all", q: "", showAllDone: false };
  $("#taskSearch").value = "";
  $("#panel").classList.remove("open");
  try { history.replaceState(null, "", `#dept=${encodeURIComponent(id)}`); } catch { /* ignore */ }
  $("#roomStage").dataset.sig = "";
  renderAll();
  window.scrollTo({ top: 0 });
  $("#roomView").classList.remove("zoom-in");
  void $("#roomView").offsetWidth;
  $("#roomView").classList.add("zoom-in");
}

function backToFloor() {
  state.view = null;
  state.selectedId = null;
  $("#panel").classList.remove("open");
  closeProposalModal();
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
  renderAll();
}

// ---------- agent panel ----------

function openPanel(id, { details = false } = {}) {
  if (state.selectedId !== id) state.panelShowDone = false;
  state.selectedId = id;
  state.detailsOpen = details;
  state.draft = null;
  if (details) startDraft();
  renderPanel();
  if (cur()) syncRoom($("#roomStage"), cur());
  $("#panel").classList.add("open");
}

function closePanel() {
  state.selectedId = null;
  state.draft = null;
  $("#panel").classList.remove("open");
  if (cur()) syncRoom($("#roomStage"), cur());
}

function startDraft() {
  const a = findAgent(cur(), state.selectedId);
  if (!a) return;
  state.draft = structuredClone({
    name: a.name, title: a.title, role: a.role, model: a.model, description: a.description || "",
    skills: a.skills, tools: a.tools, prompt: a.prompt, look: a.look,
  });
}

function renderPanel() {
  const panel = $("#panel");
  const d = cur();
  const a = d && state.selectedId ? findAgent(d, state.selectedId) : null;
  if (!a) {
    panel.classList.remove("open");
    return;
  }
  const tasks = agentTasks(d, a.id);
  const current = tasks.find((t) => t.status === "doing");
  const progress = agentProgress(d, a.id);
  const status = displayStatus(d, a);

  // Keep focus and caret if the user is typing in the details form.
  const active = document.activeElement;
  if (active && panel.contains(active) && active.matches("input, textarea, select")) return;
  readDraftFields();

  panel.innerHTML = `
    <header class="panel-head">
      <div class="avatar-wrap"><div class="avatar">${portraitSvg(a)}</div>
        <button class="dice" data-dice="${esc(a.id)}" title="New random look and name" aria-label="Give ${esc(a.name)} a new random look and name">🎲</button></div>
      <div>
        <h2>${esc(a.name)}</h2>
        <p>${esc(a.title)} · ${esc(d.info.name)}</p>
        <div class="desk-meta"><span class="pill pill-${status}">${esc(STATUS_LABELS[status] || status)}</span>
          <span class="model model-${esc(a.model)}">${esc(a.model)}</span></div>
      </div>
      <button class="icon-btn" id="closePanel" aria-label="Close panel">×</button>
    </header>

    ${a.pending ? `<p class="pending-note">Approved and joining: ${esc(pmName(d))} is preparing this person's profile.</p>` : ""}
    <section class="panel-sec">
      <h3>Overview</h3>
      <div class="big-progress"><div class="bar"><i style="width:${progress}%"></i></div><b>${progress}%</b></div>
      <p class="current">${current ? `Working on <b>${esc(current.id)}</b>: ${esc(current.title)}` : "No active task right now."}</p>
    </section>

    <section class="panel-sec">
      <h3>Tasks <span class="count">${tasks.length}</span></h3>
      ${panelTasksHtml(tasks)}
    </section>

    <section class="panel-sec">
      <h3>Recent activity</h3>
      ${a.actions.length ? `<ul class="activity">${a.actions.slice(0, 8).map((x) =>
        `<li><time>${x.time}</time>${esc(x.text)}</li>`).join("")}</ul>` : `<p class="muted">Nothing yet.</p>`}
    </section>

    <section class="panel-sec">
      <h3>Files touched</h3>
      ${a.files.length ? `<ul class="files">${a.files.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul>`
        : `<p class="muted">No files yet.</p>`}
    </section>

    <button class="details-toggle" id="detailsToggle" aria-expanded="${state.detailsOpen}">
      ${state.detailsOpen ? "▾" : "▸"} Details <span class="muted">(profile, skills, functions)</span>
    </button>
    ${state.detailsOpen ? detailsHtml(a) : ""}
  `;
}

function panelTaskItem(t) {
  return `<li><span class="dot dot-${t.status}"></span><b>${esc(t.id)}</b> ${esc(t.title)}
    ${t.status === "done" ? "" : `<div class="mini-bar"><i style="width:${t.progress}%"></i></div>`}</li>`;
}

// Open tasks first (doing, then to do); finished tasks are collapsed behind a toggle.
function panelTasksHtml(tasks) {
  if (!tasks.length) return `<p class="muted">No tasks assigned yet.</p>`;
  const open = tasks.filter((t) => t.status !== "done")
    .sort((a, b) => (a.status === b.status ? byTaskId(a, b) : a.status === "doing" ? -1 : 1));
  const done = tasks.filter((t) => t.status === "done").sort(byTaskId).reverse();
  const shownDone = state.panelShowDone ? done : done.slice(0, PANEL_DONE_PREVIEW);
  return `<ul class="task-list scroll-list">${open.map(panelTaskItem).join("") ||
      `<li class="muted">No open tasks.</li>`}</ul>
    ${done.length ? `<div class="done-group"><h4>Done <span class="count">${done.length}</span></h4>
      <ul class="task-list scroll-list">${shownDone.map(panelTaskItem).join("")}</ul>
      ${done.length > PANEL_DONE_PREVIEW ? `<button class="btn small more-btn" data-panel-done>
        ${state.panelShowDone ? "Show less" : `Show all ${done.length}`}</button>` : ""}</div>` : ""}`;
}

function chipList(items, kind, missing = []) {
  return items.map((x) =>
    `<span class="chip${missing.includes(x) ? " missing" : ""}"${missing.includes(x) ? ` title="The PM writes this skill on its next turn"` : ""}>${esc(x)}<button type="button" data-remove-${kind}="${esc(x)}" aria-label="Remove ${esc(x)}">×</button></span>`
  ).join("") || `<span class="muted">None</span>`;
}

function detailsHtml(a) {
  const d = state.draft;
  if (!d) return "";
  const extraTools = d.tools.filter((t) => !ALL_TOOLS.includes(t));
  return `
  <form class="details" id="detailsForm" data-agent="${esc(a.id)}">
    <p class="hint">You are HR here: edit this employee's profile. <b>Save</b> writes <code>.claude/agents/${esc(a.id)}.md</code> in this department's workspace.</p>
    <div class="grid2">
      <label>Name<input name="name" value="${esc(d.name)}" required></label>
      <label>Job title<input name="title" value="${esc(d.title)}"></label>
      <label>Role<select name="role">${Object.entries(ROLES).map(([k, r]) =>
        `<option value="${k}" ${k === d.role ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></label>
      <label>Model<select name="model">${MODELS.map((m) =>
        `<option ${m === d.model ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    <label>Description (when the PM should use this role)<input name="description" value="${esc(d.description)}"
      placeholder="Leave empty to generate from the job title and responsibilities"></label>

    <fieldset>
      <legend>Skills</legend>
      <div class="chips">${chipList(d.skills, "skill", a.missingSkills || [])}</div>
      ${(a.missingSkills || []).length ? `<p class="field-hint">Dashed skills do not exist yet: the PM writes them on its next turn.</p>` : ""}
      <div class="add-row"><input id="newSkill" placeholder="Add a skill, e.g. graphql" aria-label="New skill">
        <button type="button" class="btn small" id="addSkill">Add</button></div>
    </fieldset>

    <fieldset>
      <legend>Functions / tools</legend>
      <div class="tool-grid">${ALL_TOOLS.map((t) => `
        <label class="tool"><input type="checkbox" data-tool="${t}" ${d.tools.includes(t) ? "checked" : ""}> ${t}</label>`).join("")}</div>
      ${extraTools.length ? `<div class="chips">${chipList(extraTools, "tool")}</div>` : ""}
      <div class="add-row"><input id="newTool" placeholder="Custom function or MCP tool" aria-label="New tool">
        <button type="button" class="btn small" id="addTool">Add</button></div>
    </fieldset>

    <label>Responsibilities (system prompt)<textarea name="prompt" rows="5">${esc(d.prompt)}</textarea></label>

    <div class="form-actions">
      <button type="submit" class="btn primary">Save</button>
      <button type="button" class="btn" id="cancelEdit">Cancel</button>
      ${a.id === "pm" ? "" : `<button type="button" class="btn" id="helperBtn" title="Move to assistants: the team can still call on them, but they get no tasks">Make assistant</button>
        <button type="button" class="btn danger" id="fireBtn">Dismiss</button>`}
    </div>
  </form>`;
}

function readDraftFields() {
  const form = $("#detailsForm");
  if (!form || !state.draft || form.dataset.agent !== state.selectedId) return;
  const fd = new FormData(form);
  ["name", "title", "role", "model", "description", "prompt"].forEach((k) => { state.draft[k] = String(fd.get(k) ?? "").trim(); });
}

function rerenderDetails() {
  readDraftFields();
  document.activeElement?.blur();
  renderPanel();
}

async function saveDraft() {
  readDraftFields();
  const d = cur();
  const a = findAgent(d, state.selectedId);
  const draft = state.draft;
  if (!a || !draft || !draft.name) return;
  Object.assign(a, { name: draft.name, title: draft.title, role: draft.role, model: draft.model,
    description: draft.description, skills: [...draft.skills], tools: [...draft.tools], prompt: draft.prompt });
  addAction(a, "Profile updated by HR");
  state.detailsOpen = false;
  state.draft = null;
  document.activeElement?.blur();
  if (state.live) {
    const { id, name, title, role, model, description, look, skills, tools, prompt } = a;
    try {
      await api("PUT", `/api/departments/${encodeURIComponent(d.id)}/staff/${encodeURIComponent(id)}`,
        { name, title, role, model, description, look, skills, tools, prompt });
      pushFeed(d, { kind: "system", text: `HR saved ${name}'s profile.` });
    } catch (err) {
      pushFeed(d, { kind: "system", text: `Could not save ${name}: ${err.message}` });
    }
  } else {
    pushFeed(d, { kind: "system", text: `HR updated ${a.name}'s profile (demo only).` });
  }
  renderAll();
}

// New random name and look for one staff member (the name can still be edited in Details).
async function randomizeAgent(id) {
  const d = cur();
  const a = findAgent(d, id);
  if (!a) return;
  if (state.live) {
    try {
      const saved = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/staff/${encodeURIComponent(id)}/randomize`);
      Object.assign(a, { name: saved.name, look: saved.look });
    } catch (err) {
      pushFeed(d, { kind: "system", text: `Could not change ${a.name}: ${err.message}` });
    }
  } else {
    a.look = demoLook();
    a.name = ["Linh", "Khoa", "Emma", "Kenji", "Mai", "Leo", "Sofia", "Huy"][Math.floor(Math.random() * 8)];
  }
  renderAll();
}

function demoLook() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const gender = pick(["female", "male"]);
  return {
    gender, skin: pick(["#ffe0c7", "#eac09c", "#d9a57c", "#a8704a"]), hair: pick(["#2b2b2b", "#8a5a2b", "#d9a441", "#6b4f9e"]),
    hairStyle: pick(gender === "female" ? ["long", "bob", "bun", "ponytail", "twintails", "braid", "curly", "afro"] : ["short", "spiky", "side", "buzz", "mohawk", "curly", "afro", "bald"]),
    headwear: pick(["none", "none", "cap", "beanie", "headband"]), eyewear: pick(["none", "none", "round", "square", "sunglasses"]),
    eyes: pick(["tall", "dot", "happy", "sleepy", "wide"]), mouth: pick(["small", "smile", "open", "flat"]),
    outfit: pick(["tshirt", "collar", "hoodie", "sweater", "suit", "overalls", "scarf"]),
    detail: pick(gender === "female" ? ["none", "freckles", "earrings", "blush"] : ["none", "beard", "mustache", "freckles", "stubble"]),
  };
}

// New random room look (layout, furniture, decoration, colors).
async function randomizeRoom() {
  const d = cur();
  if (!d) return;
  if (state.live) {
    try {
      const info = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/room/randomize`);
      d.info = { ...d.info, ...info };
    } catch (err) {
      pushFeed(d, { kind: "system", text: `Could not change the room: ${err.message}` });
    }
  } else {
    d.info = { ...d.info, roomSeed: Math.floor(Math.random() * 1e9) };
  }
  renderAll();
}

// ---------- hiring ----------
// Nothing is created until the customer confirms: Manual creates the agent from the form,
// Auto asks the PM to design the role and answers with a hire proposal to approve.

const hireState = { mode: "auto", idEdited: false };

function openHire(mode = "auto") {
  const d = cur();
  if (!d) return;
  $("#hireAuto").reset();
  $("#hireManual").reset();
  hireState.idEdited = false;
  $("#hireRole").innerHTML = Object.entries(ROLES).map(([k, r]) =>
    `<option value="${k}" ${k === "dev" ? "selected" : ""}>${esc(r.label)}</option>`).join("");
  $("#hireTools").innerHTML = ALL_TOOLS.map((t) => `
    <label class="tool"><input type="checkbox" name="tool" value="${t}" ${["Read", "Write", "Edit", "Glob", "Grep"].includes(t) ? "checked" : ""}> ${t}</label>`).join("");
  $("#hireAutoBtn").textContent = `Ask ${pmName(d)}`;
  ["#hireAutoError", "#hireManualError"].forEach((sel) => { $(sel).hidden = true; });
  setHireMode(state.live ? mode : "manual");
  $("#hireModal").hidden = false;
}

function setHireMode(mode) {
  const d = cur();
  hireState.mode = mode;
  document.querySelectorAll("[data-hire-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.hireMode === mode);
    b.setAttribute("aria-selected", String(b.dataset.hireMode === mode));
    if (b.dataset.hireMode === "auto") b.disabled = !state.live;
  });
  $("#hireAuto").hidden = mode !== "auto";
  $("#hireManual").hidden = mode !== "manual";
  $("#hireHelp").textContent = mode === "auto"
    ? `Describe who you need. ${pmName(d)} designs the role (skills, tools, model, responsibilities) and sends you a hire proposal. Nobody is hired until you approve it.`
    : "Fill in the profile yourself. The new staff member joins when you press Hire.";
  (mode === "auto" ? $("#hireAuto").description : $("#hireManual").title).focus();
}

function closeHire() {
  $("#hireModal").hidden = true;
}

function hireError(sel, message) {
  $(sel).textContent = message;
  $(sel).hidden = false;
}

async function submitHireManual() {
  const d = cur();
  const form = $("#hireManual");
  const fd = new FormData(form);
  const value = (k) => String(fd.get(k) || "").trim();
  const id = value("agentId");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(id)) return hireError("#hireManualError", "Staff id must use lowercase letters, digits, _ or -.");
  if (findAgent(d, id) || (d.helpers || []).some((h) => h.id === id)) return hireError("#hireManualError", `Someone with id "${id}" already exists.`);
  const config = {
    id, name: value("name"), title: value("title"), role: value("role"), model: value("model"),
    description: value("description"), prompt: value("prompt"),
    skills: value("skills").split(",").map((x) => x.trim()).filter(Boolean),
    tools: fd.getAll("tool").map(String),
  };
  if (!state.live) {
    d.agents.push(withRuntime({ ...config, name: config.name || "New hire", look: demoLook() }));
    closeHire();
    return renderAll();
  }
  $("#hireManualBtn").disabled = true;
  try {
    const saved = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/staff`, config);
    if (!findAgent(d, saved.id)) d.agents.push(withRuntime(saved));
    pushFeed(d, { kind: "system", text: `HR hired ${saved.name} (${saved.title}).` });
    closeHire();
    renderAll();
    openPanel(saved.id);
  } catch (err) {
    hireError("#hireManualError", err.message);
  } finally {
    $("#hireManualBtn").disabled = false;
  }
}

async function submitHireAuto() {
  const d = cur();
  const fd = new FormData($("#hireAuto"));
  const description = String(fd.get("description") || "").trim();
  if (!description) return hireError("#hireAutoError", "Describe the staff member you need.");
  $("#hireAutoBtn").disabled = true;
  try {
    const res = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/hire`, { description, model: fd.get("model") });
    pushFeed(d, { kind: "msg", from: "customer", to: "pm", text: `Hire request: ${description}` });
    pushFeed(d, { kind: "system", notice: true, text: res.queued
      ? `${pmName(d)} is busy; the hire request is queued. You will get a hire proposal to approve.`
      : `${pmName(d)} is designing the new role. You will get a hire proposal to approve.` });
    closeHire();
    renderAll();
  } catch (err) {
    hireError("#hireAutoError", err.message);
  } finally {
    $("#hireAutoBtn").disabled = false;
  }
}

async function dismissAgent() {
  const d = cur();
  const a = findAgent(d, state.selectedId);
  if (!a || !confirm(`Dismiss ${a.name} from ${d.info.name}? Their profile is kept in .office/dismissed/ in case you rehire them.`)) return;
  if (state.live) {
    try {
      await api("DELETE", `/api/departments/${encodeURIComponent(d.id)}/staff/${encodeURIComponent(a.id)}`);
    } catch (err) {
      pushFeed(d, { kind: "system", text: `Could not dismiss ${a.name}: ${err.message}` });
      return renderAll();
    }
  }
  d.agents = d.agents.filter((x) => x.id !== a.id);
  pushFeed(d, { kind: "system", text: `HR dismissed ${a.name}.` });
  closePanel();
  renderAll();
}

// ---------- team proposal ----------

function maybeOpenProposal(d) {
  if (!proposalPending(d)) {
    if (state.proposal && state.proposal.dept === d.id) closeProposalModal();
    return;
  }
  const key = `${d.id}:${d.proposalRaw.createdAt || ""}`;
  if (state.proposal && state.proposal.dept === d.id) return;
  if (state.proposalDismissed.has(key)) return;
  openProposal(d);
}

function openProposal(d) {
  const p = d.proposalRaw;
  if (!p) return;
  state.proposal = {
    dept: d.id,
    key: `${d.id}:${p.createdAt || ""}`,
    kind: p.kind || "team",
    request: p.request || "",
    complexity: p.complexity || "-",
    members: (p.members || []).map((m) => {
      const lib = state.library.find((x) => x.id === m.id) || {};
      // The PM keeps the model chosen for the department.
      const pmModel = m.id === "pm" ? (findAgent(d, "pm") || {}).model : null;
      return {
        config: {
          id: m.id, name: m.name || "", title: m.title || lib.title || m.id,
          role: m.role || lib.role || "other", model: pmModel || m.model || lib.model || "sonnet",
          look: m.look || (findAgent(d, m.id) || {}).look || lib.look || {},
          skills: m.skills || lib.skills || [], tools: m.tools || lib.tools || [],
          prompt: m.prompt || lib.responsibilities || "", description: m.description || lib.whenToUse || "",
        },
        reason: m.reason || "",
        included: m.included !== false,
        locked: m.id === "pm",
      };
    }),
  };
  renderProposal();
  $("#proposal").hidden = false;
}

function closeProposalModal() {
  state.proposal = null;
  $("#proposal").hidden = true;
}

function modelMix(configs) {
  const counts = {};
  configs.forEach((c) => { counts[c.model] = (counts[c.model] || 0) + 1; });
  return MODELS.filter((m) => counts[m]).map((m) => `${counts[m]} ${m}`).join(" · ");
}

function renderProposal() {
  const p = state.proposal;
  if (!p) return;
  const chosen = p.members.filter((m) => m.included);
  const ids = new Set(p.members.map((m) => m.config.id));
  const options = state.library.filter((r) => !ids.has(r.id));
  $("#proposalBody").innerHTML = `
    <header class="modal-head">
      <div>
        <h2 id="proposalTitle">${p.kind === "hire" ? "Hire proposal" : "Team proposal"} · ${esc((state.depts.get(p.dept) || {}).info?.name || "")}</h2>
        <p class="muted">${p.kind === "hire"
          ? `${esc(pmName(state.depts.get(p.dept)))} designed the staff you asked for. Adjust it, then press Hire: nobody joins before that.`
          : `${esc(pmName(state.depts.get(p.dept)))} reviewed your request and proposes this team. Adjust it, then approve to start.`}</p>
      </div>
      <button class="icon-btn" id="propClose" aria-label="Close">×</button>
    </header>
    <div class="prop-info">
      <div><span class="muted">Request</span><b>${esc(p.request)}</b></div>
      <div><span class="muted">Complexity</span><b>${esc(p.complexity)}</b></div>
      <div><span class="muted">Team</span><b>${chosen.length} members</b></div>
      <div><span class="muted">Models</span><b>${esc(modelMix(chosen.map((m) => m.config))) || "-"}</b></div>
    </div>
    <ul class="prop-list">
      ${p.members.map((m, i) => `
        <li class="prop-card ${m.included ? "" : "off"}">
          <input type="checkbox" class="prop-check" data-prop-include="${i}" ${m.included ? "checked" : ""}
            ${m.locked ? "disabled title=\"The PM always leads the project\"" : ""} aria-label="Include ${esc(m.config.name || "New hire")}">
          <div class="prop-avatar">${portraitSvg(m.config)}</div>
          <div class="prop-body">
            <div class="prop-name"><b>${esc(m.config.name || "New hire")}</b> <span class="muted">${esc(m.config.title)}</span></div>
            <p class="prop-reason">${esc(m.reason)}</p>
            <div class="chips">${m.config.skills.map((s) => `<span class="chip plain">${esc(s)}</span>`).join("")}</div>
            <div class="prop-tools muted">Tools: ${esc(m.config.tools.join(", ") || "-")}</div>
          </div>
          <select class="prop-model" data-prop-model="${i}" aria-label="Model for ${esc(m.config.name || "New hire")}"
            ${m.locked ? "disabled title=\"Change the PM's model in Details\"" : ""}>
            ${MODELS.map((x) => `<option ${x === m.config.model ? "selected" : ""}>${x}</option>`).join("")}
          </select>
        </li>`).join("")}
    </ul>
    ${options.length ? `<div class="prop-add">
      <select id="propAddSel" aria-label="Role to add">${options.map((a) =>
        `<option value="${esc(a.id)}">${esc(a.title)} (${esc(a.model)})</option>`).join("")}</select>
      <button class="btn small" id="propAddBtn">Add to team</button></div>` : ""}
    <p class="muted small-note">New staff get a random name and look. After approval the PM prepares their profiles and skills (Claude Code agent files); fine-tune them later in Details.</p>
    <footer class="modal-foot">
      <button class="btn danger" id="propReject">Reject</button>
      <button class="btn" id="propLater">Later</button>
      <button class="btn primary" id="propApprove">${p.kind === "hire" ? "Hire" : "Approve team"} (${chosen.length})</button>
    </footer>`;
}

function proposalPayload(status) {
  return {
    status,
    members: state.proposal.members.map((m) => ({ ...m.config, reason: m.reason, included: m.included })),
  };
}

async function decideProposal(status) {
  const p = state.proposal;
  if (!p) return;
  const d = state.depts.get(p.dept);
  if (!state.live) {
    if (d) {
      d.proposalRaw = null;
      pushFeed(d, { kind: "system", text: `Team ${status} (demo only).` });
    }
    closeProposalModal();
    return renderAll();
  }
  try {
    await api("PUT", `/api/departments/${encodeURIComponent(p.dept)}/proposal`, proposalPayload(status));
    if (d) {
      d.proposalRaw = { ...d.proposalRaw, status };
      const chatRun = d.runner.origin === "chat";
      if (state.proposal.kind === "hire") {
        pushFeed(d, { kind: "system", notice: true, text: status === "approved"
          ? `Hire approved. ${pmName(d)} is preparing the newcomer's profile.` : "Hire proposal rejected." });
      } else pushFeed(d, { kind: "system", notice: true, text: status === "approved"
        ? (chatRun ? `Team approved. Reply "ok" to ${pmName(d)} in Claude chat to start.` : `Team approved. ${pmName(d)} is creating the team and will continue.`)
        : `Team proposal rejected. Tell ${pmName(d)} what to change.` });
    }
  } catch (err) {
    if (d) pushFeed(d, { kind: "system", notice: true, text: `Could not update the proposal: ${err.message}` });
  }
  closeProposalModal();
  renderAll();
}

function addProposalRole() {
  const id = $("#propAddSel")?.value;
  const p = state.proposal;
  const source = state.library.find((a) => a.id === id);
  if (!p || !source) return;
  p.members.push({
    config: {
      id: source.id, name: "", title: source.title, role: source.role, model: source.model, look: {},
      skills: [...(source.skills || [])], tools: [...(source.tools || [])],
      description: source.whenToUse || "", prompt: source.responsibilities || "",
    },
    reason: "Added by you.", included: true, locked: false,
  });
  renderProposal();
}

// ---------- client desk ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `${method} ${url} failed: ${res.status}`);
  return data;
}

async function sendLiveMessage() {
  const d = cur();
  const input = $("#liveInput");
  const text = input.value.trim();
  if (!d || !text) return;
  if (!state.live) {
    pushFeed(d, { kind: "system", notice: true, text: "Demo mode: start the office server to talk to the PM." });
    return renderAll();
  }
  const mode = runnerMode(d);
  if (mode === "takeover" && !confirm("Continue this conversation from the dashboard? Messages sent here will not show in the chat window.")) return;
  const base = `/api/departments/${encodeURIComponent(d.id)}/run`;
  try {
    if (mode === "new") {
      await api("POST", `${base}/start`, { request: text });
      d.run = { status: "running", request: text };
    } else {
      const res = await api("POST", `${base}/reply`, { text, takeover: mode === "takeover" });
      if (res.queued) pushFeed(d, { kind: "system", notice: true, text: `${pmName(d)} is busy. Your message is queued.` });
    }
    pushFeed(d, { kind: "msg", from: "customer", to: "pm", text });
    input.value = "";
  } catch (err) {
    pushFeed(d, { kind: "system", notice: true, text: `Could not send: ${err.message}` });
  }
  renderAll();
}

async function releaseDept() {
  const d = cur();
  if (!d) return;
  const where = d.info.repo ? ` and push main to ${d.info.repo}` : "";
  if (!confirm(`Release ${d.info.name}: merge preview into main${where}?`)) return;
  try {
    const res = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/release`);
    pushFeed(d, { kind: "system", notice: true, text: `Released to main. ${(res.log || []).join(" ")}` });
  } catch (err) {
    pushFeed(d, { kind: "system", notice: true, text: `Release failed: ${err.message}` });
  }
  renderAll();
}

async function confirmMigration() {
  const d = cur();
  const m = d && d.info.migration;
  if (!m) return;
  if (!confirm(`Merge ${m.branch} (office setup and onboarding) into preview?`)) return;
  try {
    const res = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/migration/confirm`);
    d.info.migration = { ...m, status: "merged" };
    pushFeed(d, { kind: "system", notice: true, text: `Migration confirmed. ${(res.log || []).join(" ")}` });
  } catch (err) {
    pushFeed(d, { kind: "system", notice: true, text: `Could not confirm the migration: ${err.message}` });
  }
  renderAll();
}

async function setHelper(id, helper) {
  const d = cur();
  try {
    const res = await api("POST", `/api/departments/${encodeURIComponent(d.id)}/staff/${encodeURIComponent(id)}/helper`, { helper });
    setStaff(d, res.staff);
    d.helpers = res.helpers;
    pushFeed(d, { kind: "system", text: helper ? `${id} moved to the assistants.` : `${id} joined the staff.` });
  } catch (err) {
    pushFeed(d, { kind: "system", text: `Could not change ${id}: ${err.message}` });
  }
  renderAll();
}

async function removeDept() {
  const d = cur();
  if (!d) return;
  if (!confirm(`Close ${d.info.name}? It leaves the dashboard; its folder and repository stay on disk, so you can open it again.`)) return;
  try {
    await api("DELETE", `/api/departments/${encodeURIComponent(d.id)}`);
    state.depts.delete(d.id);
    backToFloor();
  } catch (err) {
    pushFeed(d, { kind: "system", text: `Could not remove: ${err.message}` });
    renderAll();
  }
}

// ---------- create, open or migrate a department ----------

const MODE_TEXT = {
  new: {
    title: "New department",
    help: "A new project in an empty folder. Agent Office prepares the folder, the git repository (main and preview) and the PM. The PM then proposes the team for your approval.",
    folder: "Workspace folder",
    hint: "Created if it does not exist. Leave empty to use the default folder under Agent Office's workspace/.",
    repoHint: "An empty repository. main and preview are created and pushed with your git credentials.",
    button: "Create",
    busy: "Setting up workspace…",
  },
  open: {
    title: "Open department",
    help: "Bring back a department that was removed from the dashboard. Its team, tasks and history are read from the folder.",
    folder: "Department folder",
    hint: "A folder that already has Agent Office files (.office/department.json).",
    button: "Open",
    busy: "Opening…",
  },
  migrate: {
    title: "Migrate project",
    help: "Turn an existing project into a department. Its current code is treated as the latest: uncommitted work is committed, main and preview are brought up to date, then the PM has the code analysed and proposes a team.",
    folder: "Project folder",
    hint: "The folder of the existing project.",
    repoHint: "Leave empty to keep the project's own remote (origin).",
    button: "Migrate",
    busy: "Migrating the project…",
  },
};

const createState = { mode: "new", workspaceEdited: false, nameEdited: false, inspectSeq: 0 };

function joinPath(root, name) {
  if (!root) return name;
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + name;
}

function openCreate(mode = "new") {
  if (state.demo) {
    alert("This needs the office server: run node server/office-server.mjs and open http://localhost:5178.");
    return;
  }
  const form = $("#createForm");
  form.reset();
  form.pmModel.value = "opus";
  form.docFolders.value = "docs";
  createState.folders = [];
  renderAgentPick([]);
  createState.workspaceEdited = false;
  createState.nameEdited = false;
  setCreateMode(mode);
  $("#createModal").hidden = false;
  (mode === "new" ? form.name : form.workspace).focus();
}

function setCreateMode(mode) {
  createState.mode = mode;
  const t = MODE_TEXT[mode];
  const form = $("#createForm");
  $("#createTitle").textContent = t.title;
  $("#modeHelp").textContent = t.help;
  $("#folderLabel").textContent = t.folder;
  $("#repoHint").textContent = t.repoHint || "";
  $("#createBtn").textContent = t.button;
  $("#createBtn").disabled = false;
  $("#createError").hidden = true;
  document.querySelectorAll(".mode-tabs [data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  });
  form.querySelectorAll("[data-modes]").forEach((el) => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
  form.workspace.placeholder = mode === "new" ? "Absolute path, created if it does not exist" : "Absolute path of the folder";
  inspectWorkspace();
}

function closeCreate() {
  $("#createModal").hidden = true;
}

// Describes the chosen folder and suggests the right mode.
async function inspectWorkspace() {
  const form = $("#createForm");
  const hint = $("#folderHint");
  const value = form.workspace.value.trim();
  const seq = ++createState.inspectSeq;
  if (!value) {
    hint.textContent = MODE_TEXT[createState.mode].hint;
    hint.className = "field-hint";
    return;
  }
  let info;
  try {
    info = await api("GET", `/api/fs/inspect?path=${encodeURIComponent(value)}`);
  } catch (err) {
    if (seq === createState.inspectSeq) { hint.textContent = err.message; hint.className = "field-hint warn"; }
    return;
  }
  if (seq !== createState.inspectSeq) return;
  const mode = createState.mode;
  let text = "";
  let warn = false;
  if (!info.exists) {
    text = mode === "new" ? "New folder: it will be created." : "This folder does not exist.";
    warn = mode !== "new";
  } else if (info.hasOffice) {
    text = `Existing department${info.department ? `: ${info.department.name}` : ""}.`;
    if (mode !== "open") { text += " Use Open department."; warn = true; }
  } else if (info.empty) {
    text = "Empty folder.";
    if (mode === "migrate") { text += " Use New project instead."; warn = true; }
    if (mode === "open") { text += " It has no department to open."; warn = true; }
  } else {
    const gitText = info.isGit
      ? `Git repository on ${info.branch || "a detached HEAD"}${info.dirty ? ", with uncommitted changes that will be committed" : ""}${info.origin ? `, remote ${info.origin}` : ""}.`
      : "No git repository yet: one will be created.";
    text = `Existing project${info.hasReadme ? " with a README" : ""}. ${gitText}`;
    if (mode === "new") { text = "This folder is not empty. Use Migrate project."; warn = true; }
    if (mode === "open") { text = "This project has no Agent Office files. Use Migrate project."; warn = true; }
  }
  // Fill in what the folder tells us.
  if (mode === "migrate" && info.exists && !createState.nameEdited && !form.name.value.trim()) {
    form.name.value = info.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (mode === "migrate" && info.origin && !form.repo.value.trim()) form.repo.placeholder = info.origin;
  renderAgentPick(mode === "migrate" ? info.agents || [] : []);
  createState.folders = info.folders || [];
  updateDocsHint();
  hint.textContent = text;
  hint.className = `field-hint${warn ? " warn" : " ok"}`;
}

// Existing project agents: ticked ones become staff, the rest stay helpers.
function renderAgentPick(agents) {
  $("#agentPick").hidden = !agents.length || createState.mode !== "migrate";
  $("#agentPickList").innerHTML = agents.map((a) => `
    <label class="agent-option"><input type="checkbox" name="staffAgent" value="${esc(a.id)}">
      <span><b>${esc(a.id)}</b> <span class="muted">${esc(a.model)}</span><br><span class="muted">${esc(a.description || "No description")}</span></span></label>`).join("");
}

function updateDocsHint() {
  const form = $("#createForm");
  const wanted = form.docFolders.value.split(",").map((x) => x.trim().replace(/[\\/]+$/, "")).filter(Boolean);
  const top = new Set((createState.folders || []).map((x) => x.toLowerCase()));
  if (!wanted.length || !form.workspace.value.trim()) {
    $("#docsHint").textContent = "Comma-separated folders the team reads first to understand the project. Missing folders are skipped.";
    $("#docsHint").className = "field-hint";
    return;
  }
  // Only top-level folders can be checked here; nested paths are checked by the server.
  const found = wanted.filter((w) => w.includes("/") || top.has(w.toLowerCase()));
  const missing = wanted.filter((w) => !found.includes(w));
  $("#docsHint").textContent = found.length
    ? `Read first: ${found.join(", ")}.${missing.length ? ` Not found (skipped): ${missing.join(", ")}.` : ""}`
    : `Not found: ${missing.join(", ")}. The analyst will read the code instead.`;
  $("#docsHint").className = `field-hint${found.length ? " ok" : " warn"}`;
}

async function submitCreate() {
  const form = $("#createForm");
  const mode = createState.mode;
  const body = { ...Object.fromEntries(new FormData(form).entries()), mode };
  body.staffAgents = [...form.querySelectorAll("input[name=staffAgent]:checked")].map((x) => x.value);
  delete body.staffAgent;
  if (mode !== "new" && !String(body.workspace || "").trim()) {
    $("#createError").textContent = "Choose the folder first.";
    $("#createError").hidden = false;
    return;
  }
  $("#createError").hidden = true;
  $("#createBtn").disabled = true;
  $("#createBtn").textContent = MODE_TEXT[mode].busy;
  try {
    const snap = await api("POST", "/api/departments", body);
    if (!state.depts.has(snap.info.id)) state.depts.set(snap.info.id, makeDept(snap));
    const d = state.depts.get(snap.info.id);
    (snap.info.setup?.log || []).forEach((line) => pushFeed(d, { kind: "system", text: line }));
    const request = String(body.request || "").trim();
    if (request && mode !== "open") pushFeed(d, { kind: "msg", from: "customer", to: "pm", text: request });
    if (mode === "migrate") pushFeed(d, { kind: "system", notice: true, text: `${pmName(d)} is onboarding the project: reading the code before proposing a team.` });
    closeCreate();
    openDept(snap.info.id);
  } catch (err) {
    $("#createError").textContent = err.message;
    $("#createError").hidden = false;
    $("#createBtn").disabled = false;
    $("#createBtn").textContent = MODE_TEXT[mode].button;
  }
}

// ---------- folder picker ----------

const picker = { path: "", parent: null, home: "" };

function openPicker() {
  const current = $("#createForm").workspace.value.trim();
  $("#newFolderRow").hidden = createState.mode !== "new";
  $("#newFolderName").value = createState.mode === "new" ? slugify($("#createForm").name.value) : "";
  $("#folderModal").hidden = false;
  loadFolder(current || state.defaults.workspaceRoot || "");
}

function closePicker() {
  $("#folderModal").hidden = true;
}

async function loadFolder(dir) {
  $("#folderError").hidden = true;
  let data;
  try {
    data = await api("GET", `/api/fs/list?path=${encodeURIComponent(dir)}`);
  } catch (err) {
    // A path that does not exist yet: show its nearest parent instead.
    const parent = dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
    if (parent && parent !== dir) return loadFolder(parent);
    $("#folderError").textContent = err.message;
    $("#folderError").hidden = false;
    return;
  }
  Object.assign(picker, data);
  $("#folderPath").value = data.path;
  $("#folderUp").disabled = data.parent === null;
  $("#useFolder").disabled = !data.path;
  $("#useNewFolder").disabled = !data.path;
  $("#folderCurrent").textContent = data.path ? "" : "Pick a drive";
  $("#folderList").innerHTML = data.folders.length
    ? data.folders.map((f) => `<li><button type="button" class="folder-item" data-path="${esc(f.path)}">📁 ${esc(f.name)}</button></li>`).join("")
    : `<li class="muted folder-empty">No sub-folders.</li>`;
}

function useFolder(dir) {
  if (!dir) return;
  const form = $("#createForm");
  form.workspace.value = dir;
  createState.workspaceEdited = true;
  closePicker();
  inspectWorkspace();
}

// ---------- events ----------

function bindEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target;

    if (t.closest("#propApprove")) return decideProposal("approved");
    if (t.closest("#propReject")) return decideProposal("rejected");
    if (t.closest("#propLater") || t.closest("#propClose")) {
      if (state.proposal) state.proposalDismissed.add(state.proposal.key);
      return closeProposalModal();
    }
    if (t.closest("#propAddBtn")) return addProposalRole();
    if (t.closest("#reviewTeamBtn")) {
      const d = cur();
      if (d) { state.proposalDismissed.delete(`${d.id}:${d.proposalRaw?.createdAt || ""}`); openProposal(d); }
      return;
    }

    // Folder picker.
    if (t.closest("#browseBtn")) return openPicker();
    if (t.closest("#folderClose") || t.closest("#folderCancel")) return closePicker();
    const folder = t.closest(".folder-item[data-path]");
    if (folder) return loadFolder(folder.dataset.path);
    if (t.closest("#folderUp")) return loadFolder(picker.parent ?? "");
    const jump = t.closest("[data-jump]");
    if (jump) {
      const to = { home: picker.home, workspace: state.defaults.workspaceRoot }[jump.dataset.jump] ?? "";
      return loadFolder(to);
    }
    if (t.closest("#useFolder")) return useFolder(picker.path);
    if (t.closest("#useNewFolder")) {
      const name = slugify($("#newFolderName").value);
      if (!name) return $("#newFolderName").focus();
      return useFolder(joinPath(picker.path, name));
    }

    // Department modal.
    const modeTab = t.closest(".mode-tabs [data-mode]");
    if (modeTab) return setCreateMode(modeTab.dataset.mode);
    if (t.closest("#newDeptBtn") || t.closest("#newDeptTile")) return openCreate("new");
    if (t.closest("#createCancel") || t.closest("#createClose")) return closeCreate();
    if (t.closest("#backBtn")) return backToFloor();
    if (t.closest("#hireBtn")) return openHire();
    const hireMode = t.closest("[data-hire-mode]");
    if (hireMode) return setHireMode(hireMode.dataset.hireMode);
    if (t.closest("#hireClose") || t.closest("[data-hire-cancel]")) return closeHire();
    if (t.closest("#releaseBtn")) return releaseDept();
    if (t.closest("#confirmMigrationBtn")) return confirmMigration();
    const makeStaff = t.closest("[data-make-staff]");
    if (makeStaff) return setHelper(makeStaff.dataset.makeStaff, false);
    if (t.closest("#removeDeptBtn")) return removeDept();
    if (t.closest("#liveStop")) {
      const d = cur();
      if (d) api("POST", `/api/departments/${encodeURIComponent(d.id)}/run/stop`)
        .catch((err) => { pushFeed(d, { kind: "system", text: `Could not stop: ${err.message}` }); renderAll(); });
      return;
    }

    const feedTab = t.closest("[data-feed-tab]");
    if (feedTab) { state.feedTab = feedTab.dataset.feedTab; return renderFeed(cur()); }
    if (t.closest("[data-board-more]")) { state.board.showAllDone = true; return renderBoard(cur()); }
    if (t.closest("[data-board-less]")) { state.board.showAllDone = false; return renderBoard(cur()); }
    if (t.closest("[data-panel-done]")) { state.panelShowDone = !state.panelShowDone; return renderPanel(); }

    const card = t.closest(".room-card[data-dept]");
    if (card) return openDept(card.dataset.dept);

    const dice = t.closest("[data-dice]");
    if (dice) return randomizeAgent(dice.dataset.dice);
    if (t.closest("[data-room-dice]")) return randomizeRoom();

    const seat = t.closest("#roomStage .seat[data-id]");
    if (seat) return openPanel(seat.dataset.id);
    const task = t.closest("#board .card[data-id]");
    if (task && findAgent(cur(), task.dataset.id)) return openPanel(task.dataset.id);

    if (t.closest("#closePanel")) return closePanel();
    if (t.closest("#detailsToggle")) {
      state.detailsOpen = !state.detailsOpen;
      if (state.detailsOpen) startDraft(); else state.draft = null;
      return renderPanel();
    }
    if (!state.draft) return;
    if (t.dataset.removeSkill !== undefined) {
      state.draft.skills = state.draft.skills.filter((s) => s !== t.dataset.removeSkill);
      return rerenderDetails();
    }
    if (t.dataset.removeTool !== undefined) {
      state.draft.tools = state.draft.tools.filter((s) => s !== t.dataset.removeTool);
      return rerenderDetails();
    }
    if (t.id === "addSkill" || t.id === "addTool") {
      const input = $(t.id === "addSkill" ? "#newSkill" : "#newTool");
      const val = input.value.trim();
      const list = t.id === "addSkill" ? state.draft.skills : state.draft.tools;
      if (val && !list.includes(val)) list.push(val);
      return rerenderDetails();
    }
    if (t.id === "cancelEdit") {
      state.detailsOpen = false;
      state.draft = null;
      return renderPanel();
    }
    if (t.id === "fireBtn") return dismissAgent();
    if (t.id === "helperBtn") {
      const id = state.selectedId;
      closePanel();
      return setHelper(id, true);
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "taskOwner") {
      state.board.owner = e.target.value;
      return renderBoard(cur());
    }
    const p = state.proposal;
    if (p && e.target.dataset.propInclude !== undefined) {
      p.members[Number(e.target.dataset.propInclude)].included = e.target.checked;
      return renderProposal();
    }
    if (p && e.target.dataset.propModel !== undefined) {
      p.members[Number(e.target.dataset.propModel)].config.model = e.target.value;
      return renderProposal();
    }
    if (e.target.dataset.tool && state.draft) {
      const tool = e.target.dataset.tool;
      state.draft.tools = e.target.checked
        ? [...new Set([...state.draft.tools, tool])]
        : state.draft.tools.filter((x) => x !== tool);
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.name === "docFolders") return updateDocsHint();
    const hireForm = e.target.closest && e.target.closest("#hireManual");
    if (hireForm) {
      if (e.target.name === "agentId") hireState.idEdited = Boolean(e.target.value.trim());
      if (e.target.name === "title" && !hireState.idEdited) {
        hireForm.elements.agentId.value = slugify(e.target.value).replace(/-/g, "_").slice(0, 40);
      }
      return;
    }
    if (e.target.id === "taskSearch") {
      state.board.q = e.target.value.trim();
      return renderBoard(cur());
    }
    const form = $("#createForm");
    if (e.target === form.workspace) {
      createState.workspaceEdited = Boolean(e.target.value.trim());
      clearTimeout(createState.inspectTimer);
      createState.inspectTimer = setTimeout(inspectWorkspace, 400);
    }
    if (e.target === form.name) {
      createState.nameEdited = true;
      // A new project gets a default folder named after the department until the folder is edited.
      if (createState.mode === "new" && !createState.workspaceEdited) {
        form.workspace.value = form.name.value.trim() ? joinPath(state.defaults.workspaceRoot, slugify(form.name.value)) : "";
        clearTimeout(createState.inspectTimer);
        createState.inspectTimer = setTimeout(inspectWorkspace, 400);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target.id === "newSkill" || e.target.id === "newTool")) {
      e.preventDefault();
      $(e.target.id === "newSkill" ? "#addSkill" : "#addTool").click();
    }
    if (e.key === "Enter" && e.target.matches(".room-card[data-dept]")) return openDept(e.target.dataset.dept);
    if (e.key === "Enter" && e.target.matches("#board .card[data-id]")) return e.target.click();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "liveInput") {
      e.preventDefault();
      return sendLiveMessage();
    }
    if (e.key === "Escape") {
      if (!$("#folderModal").hidden) return closePicker();
      if (!$("#hireModal").hidden) return closeHire();
      if (!$("#createModal").hidden) return closeCreate();
      if (state.proposal) { state.proposalDismissed.add(state.proposal.key); return closeProposalModal(); }
      if (state.selectedId) return closePanel();
    }
  });

  document.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "detailsForm") return saveDraft();
    if (e.target.id === "liveForm") return sendLiveMessage();
    if (e.target.id === "createForm") return submitCreate();
    if (e.target.id === "hireManual") return submitHireManual();
    if (e.target.id === "hireAuto") return submitHireAuto();
    if (e.target.id === "folderGo") return loadFolder($("#folderPath").value.trim());
  });
}

// ---------- live connection ----------

function deptFromMessage(msg) {
  return state.depts.get(msg.dept);
}

function connectLive() {
  if (typeof EventSource === "undefined") return startDemo();
  const source = new EventSource("/api/stream");
  let opened = false;

  source.addEventListener("snapshot", (e) => {
    opened = true;
    const data = JSON.parse(e.data);
    state.live = true;
    state.demo = false;
    document.body.classList.add("live");
    document.body.classList.remove("demo");
    state.library = data.library || [];
    state.defaults = data.defaults || state.defaults;
    state.maxParallelRuns = data.maxParallelRuns || 2;
    state.depts = new Map((data.departments || []).map((snap) => [snap.info.id, makeDept(snap)]));
    const hash = new URLSearchParams(location.hash.slice(1)).get("dept");
    if (hash && state.depts.has(hash) && !state.view) state.view = hash;
    renderAll();
  });

  const on = (type, handler) => source.addEventListener(type, (e) => {
    const msg = JSON.parse(e.data);
    const d = deptFromMessage(msg);
    if (!d && type !== "department") return;
    handler(d, msg.data, msg);
    renderTopbar();
    if (d) renderDept(d);
    if (state.view && d && state.view === d.id) renderPanel();
  });

  on("department", (_d, snap) => {
    if (!state.depts.has(snap.info.id)) state.depts.set(snap.info.id, makeDept(snap));
    if (!state.view) renderFloor();
  });
  on("department-info", (d, info) => { d.info = { ...d.info, ...info }; });
  on("office-event", (d, ev) => applyEvent(d, ev));
  on("tasks", (d, data) => setTasks(d, data));
  on("staff", (d, staff) => setStaff(d, staff));
  on("helpers", (d, helpers) => { d.helpers = helpers || []; });
  on("proposal", (d, p) => {
    d.proposalRaw = p;
    if (p && p.status === "pending") pushFeed(d, { kind: "system", notice: true, text: `${pmName(d)} proposed a team. Review it and approve to start.` });
  });
  on("run", (d, run) => { d.run = run; });
  on("runner", (d, runner) => { d.runner = runner || {}; });
  on("pm-turn", (d, data) => {
    const pm = findAgent(d, "pm");
    if (data.status === "started") setStatus(pm, "thinking");
    if (data.status === "note") pushFeed(d, { kind: "system", text: data.text });
    if (data.status === "waiting") pushFeed(d, { kind: "system", text: `Queued: ${pmName(d)} starts as soon as another department finishes.` });
    if (data.status === "ended") {
      // The PM's turn is over, so nobody in this department is still working.
      d.agents.forEach((a) => { if (a.status !== "waiting") a.status = "idle"; });
      if (data.error) pushFeed(d, { kind: "system", notice: true, text: `${pmName(d)} stopped: ${data.error.slice(0, 300)}` });
    }
  });
  on("pm-text", (d, data) => showBubble(d, findAgent(d, "pm"), data.text, false));
  on("pm-reply", (d, data) => {
    if (data.text && !data.isError) pushFeed(d, { kind: "msg", from: "pm", to: "customer", text: data.text });
  });
  source.addEventListener("department-removed", (e) => {
    const msg = JSON.parse(e.data);
    state.depts.delete(msg.dept);
    if (state.view === msg.dept) backToFloor();
    else renderAll();
  });

  source.onerror = () => {
    // Without the office server the stream fails right away: fall back to demo mode.
    if (!opened) {
      source.close();
      startDemo();
    }
  };
}

// ---------- demo mode ----------

function startDemo() {
  if (state.demo) return;
  state.demo = true;
  state.live = false;
  document.body.classList.add("demo");
  state.library = DEFAULT_AGENTS.map((a) => ({ ...a }));
  const pick = (ids) => DEFAULT_AGENTS.filter((a) => ids.includes(a.id)).map((a) => ({ ...a }));
  const samples = [
    { id: "coffee-shop", name: "Coffee Shop Landing", team: ["pm", "ba", "dev_fe", "test"], progress: [100, 100, 70, 20] },
    { id: "todo-app", name: "Shared TODO App", team: ["pm", "ba", "sa", "leader", "dev_be", "dev_fe", "test", "devops"], progress: [100, 60, 40, 30, 10, 0, 0] },
    { id: "booking-api", name: "Booking API", team: ["pm", "sa", "dev_be", "test"], progress: [100, 50, 0] },
  ];
  samples.forEach((s) => {
    const agents = pick(s.team);
    const workers = agents.filter((a) => a.id !== "pm");
    const tasks = workers.map((a, i) => {
      const progress = s.progress[i] ?? 0;
      return { id: `T${i + 1}`, title: `${a.title} work for ${s.name}`, owner: a.id,
        status: progress >= 100 ? "done" : progress > 0 ? "doing" : "todo", progress };
    });
    const d = makeDept({
      info: { id: s.id, name: s.name, workspace: `D:\\Projects\\${s.id}`, repo: "", pmModel: "opus" },
      staff: agents, tasks: { tasks }, proposal: null, run: { status: "running", request: `Build the ${s.name}` },
      runner: { sessionId: "demo", busy: true, origin: "dashboard", costUsd: 0 }, events: [],
    });
    state.depts.set(s.id, d);
  });
  // One department waits for the customer.
  const waiting = state.depts.get("booking-api");
  waiting.runner = { sessionId: "demo", busy: false, origin: "dashboard" };
  pushFeed(waiting, { kind: "msg", from: "pm", to: "customer", text: "Should bookings be cancellable by the customer, or only by staff?" });

  const lines = ["Reading the requirements…", "Writing the API contract", "Fixing a failing test", "Reviewing the layout", "Updating docs/plan.md"];
  setInterval(() => {
    state.depts.forEach((d) => {
      if (!d.runner.busy) return;
      d.agents.forEach((a) => {
        if (Math.random() < 0.35) {
          a.status = ["working", "working", "thinking", "talking", "idle"][Math.floor(Math.random() * 5)];
          if (a.status === "talking" && Math.random() < 0.5) showBubble(d, a, lines[Math.floor(Math.random() * lines.length)], false);
        }
      });
    });
    renderTopbar();
    state.depts.forEach(renderDept);
  }, 2500);
  renderAll();
}

// ---------- boot ----------

bindEvents();
if (new URLSearchParams(location.search).has("demo")) startDemo();
else connectLive();
