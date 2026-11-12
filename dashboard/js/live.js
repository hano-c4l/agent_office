// Live mode: when the page is served by server/office-server.mjs, connect to the event stream,
// load real staff from .claude/agents/*.md and animate the office from Claude Code hook events.
// When the server is not available (e.g. python http.server), the dashboard stays in demo mode.

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Skill"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BUBBLE_MS = 7000;

function liveAgentId(ev) {
  return ev.agent === "main" ? "pm" : ev.agent;
}

function eventTime(ev) {
  const d = ev.ts ? new Date(ev.ts) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function showBubble(agent, text, replay) {
  if (!agent || replay) return;
  agent.bubble = text;
  const shown = text;
  setTimeout(() => {
    if (agent.bubble === shown) { agent.bubble = null; renderOffice(); }
  }, BUBBLE_MS);
}

function setStatus(agent, status) {
  if (agent && agent.actions) agent.status = status;
}

function applyEvent(ev, replay = false) {
  const time = eventTime(ev);
  const id = liveAgentId(ev);
  const agent = findAgent(id);
  const who = agent ? agent.name : ev.agent;

  switch (ev.hook) {
    case "UserPromptSubmit": {
      state.liveWaiting = null;
      // Messages sent from the dashboard are already in the feed (added when sent).
      if (state.runner && ev.session === state.runner.sessionId && state.runner.origin === "dashboard") break;
      showBubble(CUSTOMER, ev.text, replay);
      setStatus(findAgent("pm"), "thinking");
      pushFeed({ kind: "msg", from: "customer", to: "pm", text: ev.text, time });
      break;
    }
    case "PreToolUse": {
      if (ev.tool === "Agent" || ev.tool === "Task") {
        const target = findAgent(ev.target);
        setStatus(agent, "talking");
        setStatus(target, "thinking");
        addAction(agent, `Assigned ${target ? target.name : ev.target}: ${ev.text || ""}`);
        if (target && target.actions) addAction(target, `Task from ${who}: ${ev.text || ""}`);
        showBubble(agent, `@${target ? target.name : ev.target}: ${ev.text || ""}`, replay);
        pushFeed({ kind: "msg", from: id, to: target ? target.id : ev.target, text: ev.text || "(new task)", time });
        if (!replay && target) flashDesk(target.id);
        break;
      }
      setStatus(agent, READ_TOOLS.has(ev.tool) ? "thinking" : "working");
      const what = ev.file || ev.detail || "";
      addAction(agent, `${ev.tool}${what ? " " + what : ""}`);
      if (WRITE_TOOLS.has(ev.tool) || ev.tool === "Bash" || ev.tool === "PowerShell") {
        pushFeed({ kind: "log", from: id, text: `${ev.tool} ${what}`.trim(), time });
      }
      break;
    }
    case "PostToolUse": {
      if (ev.file && agent && agent.files && !agent.files.includes(ev.file)) agent.files.unshift(ev.file);
      break;
    }
    case "PostToolUseFailure": {
      addAction(agent, `${ev.tool} failed`);
      break;
    }
    case "SubagentStart": {
      setStatus(agent, "working");
      addAction(agent, "Started working");
      break;
    }
    case "SubagentStop": {
      setStatus(agent, "idle");
      addAction(agent, "Reported back to the PM");
      if (ev.text) {
        showBubble(agent, ev.text.slice(0, 140), replay);
        pushFeed({ kind: "msg", from: id, to: "pm", text: ev.text, time });
      }
      break;
    }
    case "Stop": {
      // Dashboard-driven turns get the full reply through "pm-reply"; skip the clipped hook copy.
      const fromRunner = state.runner && ev.session === state.runner.sessionId && state.runner.origin === "dashboard";
      if (ev.agent === "main" && fromRunner) {
        setStatus(findAgent("pm"), "idle");
      } else if (ev.agent === "main") {
        setStatus(findAgent("pm"), "idle");
        if (ev.text) {
          showBubble(findAgent("pm"), ev.text.slice(0, 140), replay);
          pushFeed({ kind: "msg", from: "pm", to: "customer", text: ev.text, time });
        }
      }
      break;
    }
    case "Notification": {
      setStatus(agent || findAgent("pm"), "waiting");
      state.liveWaiting = `${who} needs you in Claude: ${ev.text || ev.detail || "waiting for input"}`;
      pushFeed({ kind: "system", text: state.liveWaiting, time });
      break;
    }
    default:
      break;
  }
}

function setStaff(staff) {
  const old = new Map(state.agents.map((a) => [a.id, a]));
  state.agents = staff.map((cfg) => {
    const prev = old.get(cfg.id);
    return prev
      ? { ...cfg, status: prev.status, actions: prev.actions, files: prev.files, bubble: prev.bubble }
      : withRuntime(cfg);
  });
}

function setTasks(data) {
  const list = Array.isArray(data) ? data : (data && data.tasks) || [];
  state.tasks = list.map((t) => ({
    id: String(t.id ?? ""), title: t.title || "", owner: t.owner || "unassigned",
    status: ["todo", "doing", "done"].includes(t.status) ? t.status : "todo",
    progress: Math.max(0, Math.min(100, Number(t.progress) || (t.status === "done" ? 100 : 0))),
  }));
}

function setRun(run) {
  state.liveRun = run;
  if (run && run.request) state.liveRequest = run.request;
}

// Proposal written by the PM (office/proposal.json). Shown for approval while it is pending.
function setLiveProposal(p) {
  if (!p || p.status !== "pending" || !Array.isArray(p.members)) {
    if (state.proposal && state.proposal.live) {
      state.proposal = null;
      $("#proposal").hidden = true;
    }
    return;
  }
  state.liveRequest = p.request || state.liveRequest;
  state.proposal = {
    live: true,
    request: p.request || "",
    complexity: p.complexity || "-",
    members: p.members.map((m) => ({
      config: {
        id: m.id, name: m.name || m.id, title: m.title || m.id, role: m.role || "other",
        model: m.model || "sonnet", look: m.look || (findAgent(m.id) || {}).look || {},
        skills: m.skills || [], tools: m.tools || [], prompt: m.prompt || "", description: m.description || "",
      },
      reason: m.reason || "",
      included: m.included !== false,
      locked: m.id === "pm",
    })),
  };
  renderProposal();
  $("#proposal").hidden = false;
}

function proposalPayload(status) {
  return {
    status,
    members: state.proposal.members.map((m) => ({ ...m.config, reason: m.reason, included: m.included })),
  };
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status}`);
  return res.json();
}

function enableLiveMode() {
  state.live = true;
  stopTimer();
  state.running = false;
  state.finished = false;
  state.feed = [];
  state.tasks = [];
  document.body.classList.add("live");
  bindLiveControls();
  const baseRenderAll = renderAll;
  renderAll = () => { baseRenderAll(); renderRunner(); };

  persistAgent = (agent) => {
    const { id, name, title, role, model, description, look, skills, tools, prompt } = agent;
    api("PUT", `/api/staff/${encodeURIComponent(id)}`, { name, title, role, model, description, look, skills, tools, prompt })
      .then(() => pushFeed({ kind: "system", text: `Saved ${name} to .claude/agents/${id}.md` }))
      .catch((err) => pushFeed({ kind: "system", text: `Could not save ${name}: ${err.message}` }))
      .finally(renderFeed);
  };

  removeAgent = (id) => {
    api("DELETE", `/api/staff/${encodeURIComponent(id)}`)
      .catch((err) => pushFeed({ kind: "system", text: `Could not dismiss ${id}: ${err.message}` }))
      .finally(renderFeed);
  };

  approveProposal = () => {
    if (!state.proposal) return;
    api("PUT", "/api/proposal", proposalPayload("approved"))
      .then(() => {
        if (state.runner && state.runner.origin === "dashboard") {
          pushFeed({ kind: "system", text: "Team approved. Mira has been told to continue." });
        } else {
          pushFeed({ kind: "system", text: "Team approved. Reply \"ok\" to the PM in Claude chat to start the project." });
          state.liveWaiting = "Team approved on the dashboard. Reply \"ok\" to the PM in Claude chat to start.";
        }
      })
      .catch((err) => pushFeed({ kind: "system", text: `Could not approve: ${err.message}` }))
      .finally(() => { state.proposal = null; $("#proposal").hidden = true; renderAll(); });
  };

  closeProposal = () => {
    if (state.proposal && state.proposal.live) {
      api("PUT", "/api/proposal", proposalPayload("rejected"))
        .then(() => pushFeed({ kind: "system", text: "Team proposal rejected. Tell the PM in Claude what to change." }))
        .catch(() => {})
        .finally(renderFeed);
    }
    state.proposal = null;
    $("#proposal").hidden = true;
  };
}

// ---------- dashboard control of the PM (Claude CLI runner) ----------

function runActive() {
  const r = state.runner || {};
  return Boolean(r.sessionId && (r.busy || (state.liveRun && state.liveRun.status === "running")));
}

function runnerMode() {
  if (!runActive()) return "new";
  return state.runner.origin === "chat" ? "takeover" : "reply";
}

function renderRunner() {
  const r = state.runner || {};
  const mode = runnerMode();
  const parts = [];
  if (r.busy) parts.push(`<span class="dot-busy"></span>Mira is working…${r.queued ? ` (${r.queued} message queued)` : ""}`);
  else if (mode === "new") parts.push("Ready for a new project.");
  else if (mode === "takeover") parts.push("A run is active in a Claude chat session.");
  else parts.push("Mira is waiting for your reply.");
  if (r.costUsd) parts.push(`<span class="cost">~$${r.costUsd.toFixed(2)} this run</span>`);
  if (r.lastError) parts.push(`<span class="err">${esc(r.lastError.slice(0, 300))}</span>`);
  $("#runnerStatus").innerHTML = parts.join(" ");

  const input = $("#liveInput");
  input.placeholder = {
    new: "Describe a new project for the team…",
    reply: "Reply to Mira (answers, changes, ok)…",
    takeover: "Reply to Mira here (takes the run over from chat)…",
  }[mode];
  $("#liveSend").textContent = { new: "Start project", reply: "Send", takeover: "Take over & send" }[mode];
  $("#liveStop").hidden = !r.busy;
}

async function sendLiveMessage() {
  const input = $("#liveInput");
  const text = input.value.trim();
  if (!text) return;
  const mode = runnerMode();
  if (mode === "takeover" && !confirm("Continue this chat run from the dashboard? Messages sent here will not show in the chat window.")) return;
  try {
    if (mode === "new") {
      await api("POST", "/api/run/start", { request: text });
      state.liveRequest = text;
    } else {
      const res = await api("POST", "/api/run/reply", { text, takeover: mode === "takeover" });
      if (res.queued) pushFeed({ kind: "system", text: "Mira is busy. Your message is queued." });
    }
    pushFeed({ kind: "msg", from: "customer", to: "pm", text });
    showBubble(CUSTOMER, text.slice(0, 140), false);
    input.value = "";
  } catch (err) {
    pushFeed({ kind: "system", text: `Could not send: ${err.message}` });
  }
  renderAll();
}

function bindLiveControls() {
  $("#liveForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendLiveMessage();
  });
  $("#liveInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendLiveMessage(); }
  });
  $("#liveStop").addEventListener("click", () => {
    api("POST", "/api/run/stop").catch((err) => pushFeed({ kind: "system", text: `Could not stop: ${err.message}` }));
  });
}

function setRunner(runner) {
  state.runner = runner || {};
}

function connectLive() {
  // ?demo in the URL keeps the scripted demo even when the office server is running.
  if (typeof EventSource === "undefined" || new URLSearchParams(location.search).has("demo")) return;
  let source;
  try {
    source = new EventSource("/api/stream");
  } catch {
    return;
  }

  source.addEventListener("snapshot", (e) => {
    const data = JSON.parse(e.data);
    if (!state.live) enableLiveMode();
    state.feed = [];
    setStaff(data.staff || []);
    setTasks(data.tasks);
    setRun(data.run);
    setRunner(data.runner);
    (data.events || []).forEach((ev) => applyEvent(ev, true));
    // Statuses replayed from an old run should not stay "working".
    if (!data.run || data.run.status !== "running") state.agents.forEach((a) => { a.status = "idle"; });
    setLiveProposal(data.proposal);
    renderAll();
  });
  source.addEventListener("office-event", (e) => { applyEvent(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("tasks", (e) => { setTasks(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("staff", (e) => { setStaff(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("proposal", (e) => { setLiveProposal(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("run", (e) => { setRun(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("runner", (e) => { setRunner(JSON.parse(e.data)); renderAll(); });
  source.addEventListener("pm-turn", (e) => {
    const data = JSON.parse(e.data);
    const pm = findAgent("pm");
    if (data.status === "started") setStatus(pm, "thinking");
    if (data.status === "ended") {
      setStatus(pm, "idle");
      if (data.error) pushFeed({ kind: "system", text: `PM run stopped: ${data.error.slice(0, 300)}` });
    }
    renderAll();
  });
  source.addEventListener("pm-text", (e) => {
    showBubble(findAgent("pm"), JSON.parse(e.data).text.slice(0, 140), false);
    renderOffice();
  });
  source.addEventListener("pm-reply", (e) => {
    const data = JSON.parse(e.data);
    // Errors are reported once by "pm-turn" (ended with error), so only real replies go to the feed.
    if (data.text && !data.isError) pushFeed({ kind: "msg", from: "pm", to: "customer", text: data.text });
    renderAll();
  });
  source.onerror = () => {
    // Without the office server (demo mode) the stream 404s; stop retrying in that case.
    if (!state.live) source.close();
  };
}

connectLive();
