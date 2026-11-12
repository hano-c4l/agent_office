// Agent Office dashboard mockup: office view, simulation, agent panel and HR editing.

const STORAGE_KEY = "agentOffice.staff.v1";
const STATUS_LABELS = {
  idle: "Idle", thinking: "Thinking", working: "Working", talking: "Talking", waiting: "Waiting for you",
};

const CUSTOMER = {
  id: "customer", name: "You", title: "Customer", role: "other",
  look: { skin: "#ffe0c7", hair: "#3b3b3b", hairStyle: "short", shirt: "#ffffff" },
};

const state = {
  agents: [],
  tasks: [],
  feed: [],
  request: DEFAULT_REQUEST,
  scenario: [],
  stepIndex: 0,
  running: false,
  speed: 1,
  waitingAsk: null,
  finished: false,
  selectedId: null,
  detailsOpen: false,
  draft: null,
  timer: null,
  approved: false,
  proposal: null,
};

// ---------- persistence ----------

function loadStaff() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (err) {
    console.warn("Could not read saved staff", err);
  }
  return structuredClone(DEFAULT_AGENTS);
}

function saveStaff() {
  const configs = state.agents.map(({ id, name, role, title, model, look, skills, tools, prompt }) =>
    ({ id, name, role, title, model, look, skills, tools, prompt }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch (err) {
    console.warn("Could not save staff", err);
  }
}

// Persistence hooks. Demo mode keeps staff in localStorage; live.js replaces these with server calls.
function persistAgent(agent) {
  saveStaff();
}

function removeAgent(id) {
  saveStaff();
}

function withRuntime(config) {
  return { ...config, status: "idle", actions: [], files: [], bubble: null };
}

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (str) => String(str ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nowTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function findAgent(id) {
  if (id === "customer") return CUSTOMER;
  return state.agents.find((a) => a.id === id);
}

function agentTasks(id) {
  return state.tasks.filter((t) => t.owner === id);
}

function agentProgress(id) {
  const tasks = agentTasks(id);
  if (!tasks.length) return 0;
  return Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length);
}

function projectProgress() {
  if (!state.tasks.length) return 0;
  return Math.round(state.tasks.reduce((sum, t) => sum + t.progress, 0) / state.tasks.length);
}

function addAction(agent, text) {
  if (!agent || !agent.actions || !text) return;
  agent.actions.unshift({ time: nowTime(), text });
  agent.actions.length = Math.min(agent.actions.length, 30);
}

function pushFeed(item) {
  state.feed.unshift({ time: nowTime(), ...item });
  state.feed.length = Math.min(state.feed.length, 80);
}

// ---------- simulation ----------

function resetSimulation() {
  stopTimer();
  state.agents.forEach((a) => Object.assign(a, { status: "idle", actions: [], files: [], bubble: null }));
  state.tasks = [];
  state.feed = [];
  state.stepIndex = 0;
  state.waitingAsk = null;
  state.finished = false;
  state.approved = false;
  state.scenario = buildScenario(state.agents);
  renderAll();
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(tick, 1700 / state.speed);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function setRunning(running) {
  state.running = running;
  if (running && !state.finished) startTimer();
  else stopTimer();
  renderControls();
}

function tick() {
  if (state.waitingAsk || state.finished) return;
  // Skip steps whose actor or target is not on the team.
  while (state.stepIndex < state.scenario.length) {
    const step = state.scenario[state.stepIndex++];
    if (findAgent(step.who) && (!step.to || findAgent(step.to))) {
      runStep(step);
      break;
    }
  }
  if (state.stepIndex >= state.scenario.length && !state.waitingAsk) {
    state.finished = true;
    setRunning(false);
  }
  renderAll();
}

function runStep(step) {
  const actor = findAgent(step.who);

  // Clear old speech bubbles except the ones waiting for an answer.
  state.agents.forEach((a) => { if (a.status !== "waiting") a.bubble = null; });
  CUSTOMER.bubble = null;

  if (step.createTasks) {
    step.createTasks.forEach((t) => {
      if (!state.tasks.some((x) => x.id === t.id)) {
        state.tasks.push({ ...t, status: "todo", progress: 0 });
      }
    });
    pushFeed({ kind: "system", text: `${actor.name} created the plan with ${step.createTasks.length} tasks.` });
    addAction(actor, `Created plan: ${step.createTasks.map((t) => t.id).join(", ")}`);
  }

  if (step.start) {
    const task = state.tasks.find((t) => t.id === step.start);
    if (task) {
      task.status = "doing";
      const owner = findAgent(task.owner);
      if (owner && owner.actions) {
        owner.status = "thinking";
        addAction(owner, `Received task ${task.id}: ${task.title}`);
      }
    }
  }

  if (step.progress) {
    const task = state.tasks.find((t) => t.id === step.progress.task);
    if (task) {
      task.progress = step.progress.value;
      task.status = task.progress >= 100 ? "done" : "doing";
    }
  }

  if (step.status && actor.actions) actor.status = step.status;
  if (step.setStatus) {
    Object.entries(step.setStatus).forEach(([id, status]) => {
      const a = findAgent(id);
      if (a && a.actions) a.status = status;
    });
  }

  if (step.file && actor.files && !actor.files.includes(step.file)) actor.files.unshift(step.file);

  if (step.log) {
    addAction(actor, step.log);
    pushFeed({ kind: "log", from: actor.id, text: step.log });
  }

  if (step.text) {
    const text = step.text.replace("{request}", state.request);
    actor.bubble = text;
    const target = findAgent(step.to);
    addAction(actor, `Told ${target ? target.name : step.to}: ${text}`);
    if (target && target.actions && target !== actor) addAction(target, `Message from ${actor.name}: ${text}`);
    pushFeed({ kind: "msg", from: actor.id, to: step.to, text });
    if (target) flashDesk(step.to);
  }

  if (step.ask) {
    state.waitingAsk = { from: actor.id, ...step.ask };
    actor.bubble = step.ask.question;
    addAction(actor, `Asked the customer: ${step.ask.question}`);
    pushFeed({ kind: "ask", from: actor.id, to: "customer", text: step.ask.question, options: step.ask.options });
  }

  if (step.done) pushFeed({ kind: "system", text: "Project delivered. 🎉" });
}

function answerAsk(answer) {
  const ask = state.waitingAsk;
  if (!ask) return;
  const asker = findAgent(ask.from);
  state.waitingAsk = null;
  pushFeed({ kind: "msg", from: "customer", to: ask.from, text: answer });
  CUSTOMER.bubble = answer;
  if (asker) {
    asker.status = "thinking";
    asker.bubble = null;
    addAction(asker, `Customer answered: ${answer}`);
  }
  state.feed.forEach((f) => { if (f.kind === "ask" && !f.answered) f.answered = answer; });
  renderAll();
}

// ---------- rendering: office ----------

function renderAll() {
  renderOffice();
  renderFeed();
  renderBoard();
  renderControls();
  renderPanel();
}

function deskHtml(agent) {
  const status = agent.status || "idle";
  const progress = agent.id === "customer" ? null : agentProgress(agent.id);
  return `
    <button class="desk status-${status} ${state.selectedId === agent.id ? "selected" : ""}" data-id="${esc(agent.id)}"
      aria-label="${esc(agent.name)}, ${esc(agent.title)}, ${esc(STATUS_LABELS[status] || status)}">
      <div class="bubble-slot">${agent.bubble ? `<div class="bubble">${esc(agent.bubble)}</div>` : ""}
        ${status === "thinking" ? `<div class="thought"><span></span><span></span><span></span></div>` : ""}
        ${status === "waiting" ? `<div class="raise">?</div>` : ""}</div>
      ${chibiSvg(agent)}
      <div class="nameplate">
        <strong>${esc(agent.name)}</strong>
        <span>${esc(agent.title)}</span>
      </div>
      ${progress === null ? "" : `
      <div class="desk-meta">
        <span class="pill pill-${status}">${esc(STATUS_LABELS[status] || status)}</span>
        <span class="model model-${esc(agent.model)}">${esc(agent.model)}</span>
      </div>
      <div class="mini-bar"><i style="width:${progress}%"></i></div>`}
    </button>`;
}

function renderOffice() {
  $("#reception").innerHTML = deskHtml({ ...CUSTOMER, status: state.waitingAsk ? "thinking" : "idle" });
  $("#floor").innerHTML = state.agents.map(deskHtml).join("") +
    `<button class="desk hire" id="hireBtn"><span class="plus">+</span><span>Hire agent</span></button>`;
}

function flashDesk(id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.desk[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add("ping");
    setTimeout(() => el.classList.remove("ping"), 900);
  });
}

// ---------- rendering: feed, board, controls ----------

function nameOf(id) {
  const a = findAgent(id);
  return a ? a.name : id;
}

function renderFeed() {
  const html = state.feed.map((f) => {
    if (f.kind === "system") return `<li class="feed-system">${esc(f.text)}</li>`;
    if (f.kind === "log") {
      return `<li class="feed-log"><time>${f.time}</time><b>${esc(nameOf(f.from))}</b> ${esc(f.text)}</li>`;
    }
    const head = `<time>${f.time}</time><b>${esc(nameOf(f.from))}</b> → <b>${esc(nameOf(f.to))}</b>`;
    if (f.kind === "ask") {
      const body = f.answered
        ? `<div class="answered">You answered: ${esc(f.answered)}</div>`
        : `<div class="ask-options">${f.options.map((o) =>
            `<button class="btn small" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}
            <form class="ask-free"><input name="free" placeholder="Or type your answer…" aria-label="Your answer"><button class="btn small primary">Send</button></form></div>`;
      return `<li class="feed-ask">${head}<p>${esc(f.text)}</p>${body}</li>`;
    }
    return `<li class="feed-msg ${f.from === "customer" ? "from-you" : ""}">${head}<p>${esc(f.text)}</p></li>`;
  }).join("");
  const empty = state.live
    ? `Waiting for activity. In Claude, open this folder and run <code>/office &lt;your request&gt;</code>.`
    : `Press <b>Start</b> to send your request to the team.`;
  $("#feed").innerHTML = html || `<li class="empty">${empty}</li>`;
}

function renderBoard() {
  const cols = { todo: "To do", doing: "Doing", done: "Done" };
  $("#board").innerHTML = Object.entries(cols).map(([key, label]) => {
    const items = state.tasks.filter((t) => t.status === key);
    return `<div class="col"><h3>${label} <span>${items.length}</span></h3>
      ${items.map((t) => `<div class="card" data-id="${esc(t.owner)}">
        <div class="card-top"><b>${esc(t.id)}</b><span>${esc(nameOf(t.owner))}</span></div>
        <div>${esc(t.title)}</div>
        <div class="mini-bar"><i style="width:${t.progress}%"></i></div></div>`).join("")}</div>`;
  }).join("");
}

function renderControls() {
  const p = projectProgress();
  $("#projectBar").style.width = p + "%";
  $("#projectPct").textContent = p + "%";
  $("#requestText").textContent = state.live
    ? (state.liveRequest || "No request yet. In Claude, run: /office <your request>")
    : state.request;
  const btn = $("#playBtn");
  btn.textContent = state.finished ? "Restart" : state.running ? "Pause" : (state.stepIndex ? "Resume" : "Start");
  if (state.live) {
    $("#waitBanner").hidden = !state.liveWaiting;
    if (state.liveWaiting) $("#waitText").textContent = state.liveWaiting;
    return;
  }
  $("#waitBanner").hidden = !state.waitingAsk;
  if (state.waitingAsk) $("#waitText").textContent = `${nameOf(state.waitingAsk.from)} is waiting for your answer in the activity feed.`;
}

// ---------- panel ----------

function openPanel(id, { details = false } = {}) {
  state.selectedId = id;
  state.detailsOpen = details;
  state.draft = null;
  if (details) startDraft();
  renderAll();
  $("#panel").classList.add("open");
}

function closePanel() {
  state.selectedId = null;
  state.draft = null;
  $("#panel").classList.remove("open");
  renderOffice();
}

function startDraft() {
  const a = findAgent(state.selectedId);
  state.draft = structuredClone({
    name: a.name, title: a.title, role: a.role, model: a.model, description: a.description || "",
    skills: a.skills, tools: a.tools, prompt: a.prompt, look: a.look,
  });
}

function renderPanel() {
  const panel = $("#panel");
  const a = state.selectedId ? findAgent(state.selectedId) : null;
  if (!a || a.id === "customer") {
    panel.classList.remove("open");
    return;
  }
  const tasks = agentTasks(a.id);
  const current = tasks.find((t) => t.status === "doing");
  const progress = agentProgress(a.id);
  const status = a.status || "idle";

  // Keep focus and caret if the user is typing in the details form.
  const active = document.activeElement;
  if (active && panel.contains(active) && active.matches("input, textarea, select")) return;
  // Keep unsaved edits when the simulation re-renders the panel.
  readDraftFields();

  panel.innerHTML = `
    <header class="panel-head">
      <div class="avatar">${chibiSvg(a)}</div>
      <div>
        <h2>${esc(a.name)}</h2>
        <p>${esc(a.title)}</p>
        <div class="desk-meta"><span class="pill pill-${status}">${esc(STATUS_LABELS[status])}</span>
          <span class="model model-${esc(a.model)}">${esc(a.model)}</span></div>
      </div>
      <button class="icon-btn" id="closePanel" aria-label="Close panel">×</button>
    </header>

    <section class="panel-sec">
      <h3>Overview</h3>
      <div class="big-progress"><div class="bar"><i style="width:${progress}%"></i></div><b>${progress}%</b></div>
      <p class="current">${current ? `Working on <b>${esc(current.id)}</b>: ${esc(current.title)}` : "No active task right now."}</p>
    </section>

    <section class="panel-sec">
      <h3>Tasks <span class="count">${tasks.length}</span></h3>
      ${tasks.length ? `<ul class="task-list">${tasks.map((t) => `
        <li><span class="dot dot-${t.status}"></span><b>${esc(t.id)}</b> ${esc(t.title)}
          <div class="mini-bar"><i style="width:${t.progress}%"></i></div></li>`).join("")}</ul>`
        : `<p class="muted">No tasks assigned yet.</p>`}
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

function chipList(items, kind) {
  return items.map((x) =>
    `<span class="chip">${esc(x)}<button type="button" data-remove-${kind}="${esc(x)}" aria-label="Remove ${esc(x)}">×</button></span>`
  ).join("") || `<span class="muted">None</span>`;
}

function detailsHtml(a) {
  const d = state.draft;
  if (!d) return "";
  const extraTools = d.tools.filter((t) => !ALL_TOOLS.includes(t));
  return `
  <form class="details" id="detailsForm" data-agent="${esc(a.id)}">
    <p class="hint">You are HR here: edit this employee's profile. Changes apply after <b>Save</b>.</p>
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
      <div class="chips">${chipList(d.skills, "skill")}</div>
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

    <label>Responsibilities (system prompt)<textarea name="prompt" rows="4">${esc(d.prompt)}</textarea></label>

    <div class="form-actions">
      <button type="submit" class="btn primary">Save</button>
      <button type="button" class="btn" id="cancelEdit">Cancel</button>
      <button type="button" class="btn" id="exportBtn">Export .md</button>
      <button type="button" class="btn danger" id="fireBtn">Dismiss</button>
    </div>
    <pre class="export" id="exportBox" hidden></pre>
  </form>`;
}

function readDraftFields() {
  const form = $("#detailsForm");
  // Only read the form that belongs to the agent being edited.
  if (!form || !state.draft || form.dataset.agent !== state.selectedId) return;
  const fd = new FormData(form);
  ["name", "title", "role", "model", "description", "prompt"].forEach((k) => { state.draft[k] = String(fd.get(k) ?? "").trim(); });
}

function rerenderDetails() {
  readDraftFields();
  document.activeElement?.blur();
  renderPanel();
}

function agentMarkdown(id, d) {
  const desc = `${d.title} - ${(d.prompt.split(".")[0] || "").trim()}`;
  return [
    "---",
    `name: ${id}`,
    `description: ${desc}`,
    `model: ${d.model}`,
    `tools: ${d.tools.join(", ")}`,
    `skills: ${d.skills.join(", ")}`,
    "---",
    d.prompt,
  ].join("\n");
}

function saveDraft() {
  readDraftFields();
  const a = findAgent(state.selectedId);
  const d = state.draft;
  if (!d.name) return;
  const roleChanged = d.role !== a.role;
  Object.assign(a, { name: d.name, title: d.title, role: d.role, model: d.model, description: d.description,
    skills: [...d.skills], tools: [...d.tools], prompt: d.prompt });
  if (roleChanged) a.look = { ...a.look, shirt: undefined };
  addAction(a, "Profile updated by HR");
  persistAgent(a);
  pushFeed({ kind: "system", text: `HR updated ${a.name}'s profile.` });
  state.detailsOpen = false;
  state.draft = null;
  document.activeElement?.blur();
  renderAll();
}

function hireAgent() {
  const id = "agent_" + Math.random().toString(36).slice(2, 7);
  const hairStyles = Object.keys(HAIR_PATHS);
  const hairColors = ["#2b2b2b", "#5b3a29", "#b5651d", "#6b4f9e", "#e07a5f"];
  const agent = withRuntime({
    id, name: "New hire", role: "dev", title: "Developer", model: "sonnet",
    look: { skin: "#ffe0c7",
      hair: hairColors[Math.floor(Math.random() * hairColors.length)],
      hairStyle: hairStyles[Math.floor(Math.random() * hairStyles.length)] },
    skills: [], tools: ["Read", "Write", "Edit"], prompt: "Describe this employee's responsibilities.",
  });
  state.agents.push(agent);
  persistAgent(agent);
  pushFeed({ kind: "system", text: "HR hired a new agent. Fill in the profile." });
  openPanel(id, { details: true });
}

function dismissAgent() {
  const a = findAgent(state.selectedId);
  if (!a || !confirm(`Dismiss ${a.name}? Their tasks will stay on the board unassigned.`)) return;
  state.agents = state.agents.filter((x) => x.id !== a.id);
  state.tasks.forEach((t) => { if (t.owner === a.id) t.owner = "unassigned"; });
  removeAgent(a.id);
  pushFeed({ kind: "system", text: `HR dismissed ${a.name}.` });
  closePanel();
  renderAll();
}

// ---------- team proposal (PM staffing, approved by the customer) ----------

function openProposal() {
  setRunning(false);
  state.proposal = proposeTeam(state.request, state.agents);
  const pm = findAgent("pm");
  if (pm) {
    pm.status = "thinking";
    pm.bubble = "Preparing a team proposal for you…";
    addAction(pm, `Proposed a team of ${state.proposal.members.length} for the request`);
  }
  pushFeed({ kind: "system", text: `PM proposed a team of ${state.proposal.members.length}. Waiting for your approval.` });
  renderAll();
  renderProposal();
  $("#proposal").hidden = false;
  $("#propApprove")?.focus();
}

function closeProposal() {
  state.proposal = null;
  $("#proposal").hidden = true;
  const pm = findAgent("pm");
  if (pm && !state.approved) { pm.status = "idle"; pm.bubble = null; }
}

function modelMix(members) {
  const counts = {};
  members.forEach((m) => { counts[m.config.model] = (counts[m.config.model] || 0) + 1; });
  return MODELS.filter((m) => counts[m]).map((m) => `${counts[m]} ${m}`).join(" · ");
}

function renderProposal() {
  const p = state.proposal;
  if (!p) return;
  const chosen = p.members.filter((m) => m.included);
  const options = availableRoles(p, state.agents);
  $("#proposalBody").innerHTML = `
    <header class="modal-head">
      <div>
        <h2 id="proposalTitle">Team proposal</h2>
        <p class="muted">The PM reviewed your request and proposes this team. Adjust it, then approve to start the project.</p>
      </div>
      <button class="icon-btn" id="propClose" aria-label="Close">×</button>
    </header>
    <div class="prop-info">
      <div><span class="muted">Request</span><b>${esc(p.request)}</b></div>
      <div><span class="muted">Complexity</span><b>${esc(p.complexity)}</b></div>
      <div><span class="muted">Team</span><b>${chosen.length} members</b></div>
      <div><span class="muted">Models</span><b>${esc(modelMix(chosen)) || "-"}</b></div>
    </div>
    <ul class="prop-list">
      ${p.members.map((m, i) => `
        <li class="prop-card ${m.included ? "" : "off"}">
          <input type="checkbox" class="prop-check" data-prop-include="${i}" ${m.included ? "checked" : ""}
            ${m.locked ? "disabled title=\"The PM always leads the project\"" : ""} aria-label="Include ${esc(m.config.name)}">
          <div class="prop-avatar">${chibiSvg(m.config)}</div>
          <div class="prop-body">
            <div class="prop-name"><b>${esc(m.config.name)}</b> <span class="muted">${esc(m.config.title)}</span></div>
            <p class="prop-reason">${esc(m.reason)}</p>
            <div class="chips">${m.config.skills.map((s) => `<span class="chip plain">${esc(s)}</span>`).join("")}</div>
            <div class="prop-tools muted">Tools: ${esc(m.config.tools.join(", "))}</div>
          </div>
          <select class="prop-model" data-prop-model="${i}" aria-label="Model for ${esc(m.config.name)}">
            ${MODELS.map((x) => `<option ${x === m.config.model ? "selected" : ""}>${x}</option>`).join("")}
          </select>
        </li>`).join("")}
    </ul>
    ${options.length ? `<div class="prop-add">
      <select id="propAddSel" aria-label="Role to add">${options.map((a) =>
        `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.title)} (${esc(a.model)})</option>`).join("")}</select>
      <button class="btn small" id="propAddBtn">Add to team</button></div>` : ""}
    <p class="muted small-note">You can fine-tune skills and functions later from each employee's Details panel.</p>
    <footer class="modal-foot">
      <button class="btn" id="propCancel">Cancel</button>
      <button class="btn primary" id="propApprove">${p.live ? "Approve team" : "Approve &amp; start"} (${chosen.length})</button>
    </footer>`;
}

function approveProposal() {
  const p = state.proposal;
  if (!p) return;
  const chosen = p.members.filter((m) => m.included).map((m) => m.config);
  state.agents = chosen.map(withRuntime);
  saveStaff();
  closeProposal();
  resetSimulation();
  state.approved = true;
  pushFeed({ kind: "system", text: `You approved a team of ${chosen.length} (${modelMix(chosen.map((c) => ({ config: c })))}).` });
  setRunning(true);
  renderAll();
}

function addProposalRole() {
  const id = $("#propAddSel")?.value;
  const p = state.proposal;
  const source = availableRoles(p, state.agents).find((a) => a.id === id);
  if (!source) return;
  const config = structuredClone({
    id: source.id, name: source.name, role: source.role, title: source.title, model: source.model,
    look: source.look, skills: source.skills, tools: source.tools, prompt: source.prompt,
  });
  p.members.push({ config, reason: "Added by you.", included: true, locked: false });
  renderProposal();
}

// ---------- events ----------

function bindEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target;

    if (t.closest("#propApprove")) return approveProposal();
    if (t.closest("#propCancel") || t.closest("#propClose")) {
      pushFeed({ kind: "system", text: "Team proposal cancelled." });
      closeProposal();
      return renderAll();
    }
    if (t.closest("#propAddBtn")) return addProposalRole();
    if (t.id === "proposal") return; // backdrop click does nothing, use Cancel

    if (t.closest("#hireBtn")) return hireAgent();
    const desk = t.closest(".desk[data-id]");
    if (desk && desk.dataset.id !== "customer") return openPanel(desk.dataset.id);
    const card = t.closest(".card[data-id]");
    if (card && findAgent(card.dataset.id)) return openPanel(card.dataset.id);

    if (t.closest("#closePanel")) return closePanel();
    if (t.closest("#detailsToggle")) {
      state.detailsOpen = !state.detailsOpen;
      if (state.detailsOpen) startDraft(); else state.draft = null;
      return renderPanel();
    }

    if (t.dataset.answer) return answerAsk(t.dataset.answer);

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
    if (t.id === "exportBtn") {
      readDraftFields();
      const box = $("#exportBox");
      box.textContent = agentMarkdown(state.selectedId, state.draft);
      box.hidden = false;
      return;
    }
    if (t.id === "fireBtn") return dismissAgent();
  });

  document.addEventListener("change", (e) => {
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target.id === "newSkill" || e.target.id === "newTool")) {
      e.preventDefault();
      $(e.target.id === "newSkill" ? "#addSkill" : "#addTool").click();
    }
    if (e.key === "Escape" && state.proposal) {
      closeProposal();
      return renderAll();
    }
    if (e.key === "Escape" && state.selectedId) closePanel();
  });

  document.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "detailsForm") return saveDraft();
    if (e.target.classList.contains("ask-free")) {
      const val = new FormData(e.target).get("free")?.toString().trim();
      if (val) answerAsk(val);
    }
    if (e.target.id === "requestForm") {
      const val = $("#requestInput").value.trim();
      if (val) state.request = val;
      $("#requestInput").value = "";
      resetSimulation();
      openProposal();
    }
  });

  // Every new run starts with a team proposal the customer must approve.
  $("#playBtn").addEventListener("click", () => {
    if (state.finished) resetSimulation();
    if (!state.approved) return openProposal();
    setRunning(!state.running);
  });
  $("#stepBtn").addEventListener("click", () => {
    if (!state.approved) return openProposal();
    if (!state.finished) tick();
  });
  $("#resetBtn").addEventListener("click", () => { resetSimulation(); });
  $("#speedSel").addEventListener("change", (e) => {
    state.speed = Number(e.target.value);
    if (state.running) startTimer();
  });
  $("#resetStaffBtn").addEventListener("click", () => {
    if (!confirm("Restore the default staff? Your HR edits will be lost.")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    state.agents = structuredClone(DEFAULT_AGENTS).map(withRuntime);
    closePanel();
    resetSimulation();
  });
}

// ---------- boot ----------

state.agents = loadStaff().map(withRuntime);
state.scenario = buildScenario(state.agents);
bindEvents();
renderAll();
