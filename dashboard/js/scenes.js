// Little scenes in the open department room, on top of the pixel room:
// - idle staff get up for a break (coffee, the lounge, a walk outside) and come back,
// - a task flies from the PM to whoever gets it, and the report flies back,
// - confetti when a project is delivered.
// Scenes are decoration only: they never change the state of the department, and a person who gets
// work while away is back at the desk at once.

const Scenes = (() => {
  const WALK_SPEED = 30; // room pixels per second
  const TICK_MS = 3500;
  const MAX_WALKERS = 2;
  const BREAK_CHANCE = 0.3;

  let stage = null; // the big room element
  let layout = null;
  let deptId = null;
  let onChange = () => {};
  const breaks = new Map(); // agent id -> { el, spot, cancelled }

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pct = (v, total) => `${(v / total) * 100}%`;

  function layer() {
    if (!stage) return null;
    let el = stage.querySelector(".scene-layer");
    if (!el) {
      el = document.createElement("div");
      el.className = "scene-layer";
      stage.appendChild(el);
    }
    return el;
  }

  function place(el, point) {
    el.style.left = pct(point.x - 1, layout.width);
    el.style.top = pct(point.y - 1, layout.height);
  }

  // Called when the room was (re)built: everything on the old room is gone.
  function attach(el, dept, roomLayout, changed) {
    clear();
    stage = el;
    layout = roomLayout;
    deptId = dept.id;
    onChange = changed || (() => {});
  }

  function clear() {
    breaks.forEach((b) => { b.cancelled = true; b.el.remove(); if (b.spot) b.spot.busy = false; });
    breaks.clear();
    if (stage) stage.querySelectorAll(".scene-layer").forEach((el) => el.remove());
    stage = null;
    layout = null;
    deptId = null;
  }

  const isAway = (dept, agentId) => Boolean(dept && dept.id === deptId && breaks.has(agentId));

  // Somebody who is needed at the desk comes straight back.
  function recall(agentId) {
    const b = breaks.get(agentId);
    if (!b) return;
    b.cancelled = true;
    b.el.remove();
    if (b.spot) b.spot.busy = false;
    breaks.delete(agentId);
  }

  // Keeps the scenes in line with the department: only idle people stay away from their desks.
  function sync(dept, statusOf) {
    if (!dept || dept.id !== deptId) return;
    [...breaks.keys()].forEach((id) => {
      const agent = dept.agents.find((a) => a.id === id);
      if (!agent || statusOf(agent) !== "idle") recall(id);
    });
  }

  function route(seat, spot) {
    const start = { x: seat.cx, y: seat.aisleY };
    const points = [start];
    if (spot.zone === "lounge" && seat.wide) points.push({ x: spot.x, y: start.y });
    else points.push({ x: layout.corridorX, y: start.y }, { x: layout.corridorX, y: spot.y });
    points.push({ x: spot.x, y: spot.y });
    return points;
  }

  async function walk(b, points) {
    b.el.classList.add("walking");
    for (let i = 1; i < points.length; i++) {
      if (b.cancelled) return;
      const from = points[i - 1];
      const to = points[i];
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      if (distance < 1) continue;
      const frames = [from, to].map((p) => ({ left: pct(p.x - 1, layout.width), top: pct(p.y - 1, layout.height) }));
      const animation = b.el.animate(frames, { duration: (distance / WALK_SPEED) * 1000, easing: "linear" });
      place(b.el, to);
      try { await animation.finished; } catch { return; }
    }
    b.el.classList.remove("walking");
  }

  async function takeBreak(agent, seat, spot) {
    const host = layer();
    if (!host) return;
    const el = document.createElement("div");
    el.className = "walker";
    el.style.width = pct(18, layout.width);
    el.style.height = pct(22, layout.height);
    el.innerHTML = walkerSvg(agent) + `<span class="emote" hidden></span>`;
    const b = { el, spot, cancelled: false };
    spot.busy = true;
    breaks.set(agent.id, b);
    const points = route(seat, spot);
    place(el, points[0]);
    host.appendChild(el);
    onChange();

    await walk(b, points);
    if (b.cancelled) return;
    if (spot.zone === "door") {
      el.classList.add("outside");
      await wait(5000 + Math.random() * 6000);
      el.classList.remove("outside");
    } else {
      const emote = el.querySelector(".emote");
      emote.textContent = spot.emote || "";
      emote.hidden = !spot.emote;
      await wait(4500 + Math.random() * 5000);
      emote.hidden = true;
      if (spot.mug) el.classList.add("with-mug");
    }
    if (b.cancelled) return;
    await walk(b, [...points].reverse());
    if (b.cancelled) return;
    recall(agent.id);
    onChange();
  }

  // Now and then one idle person leaves the desk.
  function tick(dept, statusOf) {
    if (!stage || !layout || !dept || dept.id !== deptId) return;
    if (document.hidden || reducedMotion() || !stage.isConnected) return;
    if (breaks.size >= MAX_WALKERS || Math.random() > BREAK_CHANCE) return;
    const idle = dept.agents.filter((a) => !a.pending && !breaks.has(a.id) && statusOf(a) === "idle");
    const free = layout.spots.filter((s) => !s.busy);
    if (!idle.length || !free.length) return;
    const agent = idle[Math.floor(Math.random() * idle.length)];
    const seat = layout.seats.find((s) => s.agent.id === agent.id);
    if (!seat || seat.aisleY === undefined) return;
    takeBreak(agent, seat, free[Math.floor(Math.random() * free.length)]);
  }

  const seatCenter = (seat) => ({ x: seat.x + seat.w / 2, y: seat.y + (seat.facing === "up" ? 14 : 10) });

  // A task (or a report) flies from one desk to another.
  function note(dept, fromId, toId, kind = "task") {
    if (!stage || !layout || !dept || dept.id !== deptId || reducedMotion() || document.hidden) return;
    const from = layout.seats.find((s) => s.agent.id === fromId);
    const to = layout.seats.find((s) => s.agent.id === toId);
    const host = layer();
    if (!from || !to || !host || from === to) return;
    const a = seatCenter(from);
    const b = seatCenter(to);
    const el = document.createElement("div");
    el.className = `fly-note ${kind}`;
    el.style.width = pct(11, layout.width);
    el.innerHTML = noteSvg(kind);
    host.appendChild(el);
    const at = (p, lift = 0) => ({ left: pct(p.x - 5, layout.width), top: pct(p.y - 5 - lift, layout.height) });
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    el.animate([
      { ...at(a), transform: "scale(.4)", opacity: 0 },
      { ...at(a), transform: "scale(1)", opacity: 1, offset: 0.12 },
      { ...at(mid, 14), transform: "scale(1.15) rotate(-8deg)", opacity: 1, offset: 0.55 },
      { ...at(b), transform: "scale(1)", opacity: 1, offset: 0.9 },
      { ...at(b), transform: "scale(.3)", opacity: 0 },
    ], { duration: 700 + distance * 6, easing: "ease-in-out" }).finished.then(() => el.remove(), () => el.remove());
  }

  // Confetti over the whole room.
  function celebrate(dept) {
    if (!stage || !dept || dept.id !== deptId || reducedMotion()) return;
    const host = layer();
    if (!host) return;
    const colors = ["#e05a5a", "#f5c242", "#5cc28f", "#6fa3ef", "#a98ae6", "#ff6fb5"];
    const burst = document.createElement("div");
    burst.className = "confetti";
    burst.innerHTML = Array.from({ length: 44 }, (_, i) =>
      `<i style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 1.2).toFixed(2)}s;animation-duration:${(2 + Math.random() * 1.6).toFixed(2)}s"></i>`).join("");
    host.appendChild(burst);
    setTimeout(() => burst.remove(), 4500);
  }

  return { attach, clear, isAway, sync, tick, note, celebrate, TICK_MS };
})();
