// Little scenes in the open department room, on top of the pixel room:
// - idle staff get up for a break and use the room: they sit on the sofa or at the meeting table, play
//   ping-pong or the arcade, wait at the coffee machine, pet the cat, or step outside,
// - sometimes several people take the break together and gather in the lounge,
// - a task flies from the PM to whoever gets it, and the report flies back,
// - the room has a life of its own: a robot vacuum, the cat going for a walk, a courier with a parcel,
// - confetti when a project is delivered.
// Scenes are decoration only: they never change the state of the department, and a person who gets
// work while away is back at the desk at once.

const Scenes = (() => {
  const WALK_SPEED = 30; // room pixels per second
  const TICK_MS = 3500;
  const MAX_WALKERS = 4;
  const BREAK_CHANCE = 0.3;
  const GATHER_CHANCE = 0.3;
  const CHAT = ["💬", "😄", "👍", "🤔", "💡", "😂"];
  const SPRITE_ROWS = 22; // height of the walker sprite's view box

  let stage = null; // the big room element
  let layout = null;
  let deptId = null;
  let onChange = () => {};
  let generation = 0; // changes whenever the room is rebuilt, which ends the loops of the old room
  const breaks = new Map(); // agent id -> { el, spot, cancelled, arrived }
  const uses = new Map(); // furniture in use -> how many people

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pct = (v, total) => `${(v / total) * 100}%`;
  const any = (list) => list[Math.floor(Math.random() * list.length)];
  const between = (a, b) => a + Math.random() * (b - a);

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

  // An element in the scene layer, sized and placed in room pixels.
  function sprite(cls, html, w, h) {
    const el = document.createElement("div");
    el.className = cls;
    el.style.width = pct(w, layout.width);
    el.style.height = pct(h, layout.height);
    el.innerHTML = html;
    return el;
  }

  function place(el, point) {
    el.style.left = pct(point.x - 1, layout.width);
    el.style.top = pct(point.y - 1, layout.height);
  }

  // Furniture reacts while somebody uses it: the room gets a "use-<name>" class.
  function use(name, on) {
    if (!name || !stage) return;
    const count = Math.max(0, (uses.get(name) || 0) + (on ? 1 : -1));
    uses.set(name, count);
    stage.classList.toggle(`use-${name}`, count > 0);
    if (name === "pingpong") pingPongBall(count > 0);
  }

  // The sliding door opens for a moment when somebody passes.
  function openDoor() {
    const mine = generation;
    use("door", true);
    setTimeout(() => { if (mine === generation) use("door", false); }, 1500);
  }

  function pingPongBall(on) {
    const host = layer();
    if (!host || !layout.pingpong) return;
    let ball = host.querySelector(".pp-live");
    if (!on) { if (ball) ball.remove(); return; }
    if (ball) return;
    const t = layout.pingpong;
    ball = sprite("pp-live", "", 2, 2);
    ball.style.setProperty("--x0", pct(t.x + 4, layout.width));
    ball.style.setProperty("--x1", pct(t.x + t.w - 6, layout.width));
    ball.style.setProperty("--y0", pct(t.y + 5, layout.height));
    ball.style.setProperty("--y1", pct(t.y + 14, layout.height));
    host.appendChild(ball);
  }

  // Called when the room was (re)built: everything on the old room is gone.
  function attach(el, dept, roomLayout, changed) {
    clear();
    stage = el;
    layout = roomLayout;
    deptId = dept.id;
    onChange = changed || (() => {});
    const mine = ++generation;
    if (reducedMotion()) return;
    vacuumLoop(mine);
    catLoop(mine);
    courierLoop(mine);
  }

  function clear() {
    generation += 1;
    breaks.forEach((b) => { b.cancelled = true; b.el.remove(); if (b.spot) b.spot.busy = false; });
    breaks.clear();
    if (stage) {
      stage.querySelectorAll(".scene-layer").forEach((el) => el.remove());
      [...stage.classList].filter((c) => c.startsWith("use-") || c === "cat-away").forEach((c) => stage.classList.remove(c));
    }
    uses.clear();
    stage = null;
    layout = null;
    deptId = null;
  }

  const alive = (mine) => mine === generation && stage && stage.isConnected && layout;
  const isAway = (dept, agentId) => Boolean(dept && dept.id === deptId && breaks.has(agentId));

  // Somebody who is needed at the desk comes straight back.
  function recall(agentId) {
    const b = breaks.get(agentId);
    if (!b) return;
    b.cancelled = true;
    if (b.arrived) use(b.spot.use, false);
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

  // Moves an element along points. `who` only needs { el, cancelled }.
  async function walk(who, points, speed = WALK_SPEED) {
    who.el.classList.add("walking");
    for (let i = 1; i < points.length; i++) {
      if (who.cancelled) return;
      const from = points[i - 1];
      const to = points[i];
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      if (distance < 1) continue;
      who.el.classList.toggle("flip", to.x < from.x - 1);
      const frames = [from, to].map((p) => ({ left: pct(p.x - 1, layout.width), top: pct(p.y - 1, layout.height) }));
      const animation = who.el.animate(frames, { duration: (distance / speed) * 1000, easing: "linear" });
      place(who.el, to);
      try { await animation.finished; } catch { return; }
    }
    who.el.classList.remove("walking");
  }

  // How somebody uses a spot: sitting hides the legs (or more, behind a sofa back), a game has its own pose.
  function pose(el, spot, on) {
    const svg = el.querySelector("svg");
    el.classList.toggle("sitting", Boolean(on && spot.sit));
    el.classList.toggle("show-back", Boolean(on && spot.back));
    el.classList.toggle(`play-${spot.play}`, Boolean(on && spot.play));
    svg.style.clipPath = on && spot.show ? `inset(0 0 ${((SPRITE_ROWS - spot.show - 1) / SPRITE_ROWS) * 100}% 0)` : "";
  }

  async function takeBreak(agent, seat, spot, { delay = 0, stay = between(5000, 10000), chat = false } = {}) {
    const host = layer();
    if (!host) return;
    const el = sprite("walker", walkerSvg(agent) + `<span class="emote" hidden></span>`, 18, SPRITE_ROWS);
    const b = { el, spot, cancelled: false, arrived: false };
    spot.busy = true;
    breaks.set(agent.id, b);
    const points = route(seat, spot);
    place(el, points[0]);
    if (delay) {
      el.hidden = true;
      await wait(delay);
      if (b.cancelled) return;
      el.hidden = false;
    }
    host.appendChild(el);
    onChange();

    await walk(b, points);
    if (b.cancelled) return;
    if (spot.zone === "door") {
      openDoor();
      el.classList.add("outside");
      await wait(stay);
      if (b.cancelled) return;
      openDoor();
      el.classList.remove("outside");
    } else {
      b.arrived = true;
      use(spot.use, true);
      pose(el, spot, true);
      const emote = el.querySelector(".emote");
      const lines = chat ? CHAT : spot.emotes || [];
      const until = Date.now() + stay;
      for (let i = 0; Date.now() < until && !b.cancelled; i++) {
        emote.textContent = chat ? any(lines) : lines[i % lines.length] || "";
        emote.hidden = !emote.textContent || (chat && i % 2 === 1);
        await wait(1600);
      }
      emote.hidden = true;
      if (b.cancelled) return;
      pose(el, spot, false);
      if (spot.mug) el.classList.add("with-mug");
    }
    if (b.cancelled) return;
    if (b.arrived) use(spot.use, false);
    b.arrived = false;
    await walk(b, [...points].reverse());
    if (b.cancelled) return;
    recall(agent.id);
    onChange();
  }

  // Now and then one idle person leaves the desk, or a few go to the lounge together.
  function tick(dept, statusOf) {
    if (!stage || !layout || !dept || dept.id !== deptId) return;
    if (document.hidden || reducedMotion() || !stage.isConnected) return;
    if (breaks.size >= MAX_WALKERS || Math.random() > BREAK_CHANCE) return;
    const idle = dept.agents.filter((a) => !a.pending && !breaks.has(a.id) && statusOf(a) === "idle")
      .map((agent) => ({ agent, seat: layout.seats.find((s) => s.agent.id === agent.id) }))
      .filter((x) => x.seat && x.seat.aisleY !== undefined)
      .sort(() => Math.random() - 0.5);
    const free = layout.spots.filter((s) => !s.busy);
    if (!idle.length || !free.length) return;

    const lounge = free.filter((s) => s.zone === "lounge" && (s.sit || s.play));
    if (breaks.size === 0 && idle.length >= 2 && lounge.length >= 2 && Math.random() < GATHER_CHANCE) {
      // A break together: everybody stays about as long, so they are at the table at the same time.
      const size = Math.min(idle.length, lounge.length, MAX_WALKERS, 2 + Math.floor(Math.random() * 3));
      const stay = between(11000, 16000);
      idle.slice(0, size).forEach((x, i) => takeBreak(x.agent, x.seat, lounge[i], { delay: i * 900, stay, chat: !lounge[i].play }));
      return;
    }
    takeBreak(idle[0].agent, idle[0].seat, any(free));
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

  // ---------- the room's own life ----------

  // A point on the free floor (between the desks and the things along the bottom wall).
  function floorPoint() {
    const f = layout.openFloor;
    return { x: between(f.x0, f.x1), y: between(f.y0, f.y1) };
  }

  // The robot vacuum crosses the free floor, stops, turns and goes on.
  async function vacuumLoop(mine) {
    await wait(between(2000, 6000));
    if (!alive(mine)) return;
    const host = layer();
    const bot = { el: sprite("npc vacuum", vacuumSvg(), 10, 6), cancelled: false };
    let at = floorPoint();
    place(bot.el, at);
    host.appendChild(bot.el);
    while (alive(mine) && bot.el.isConnected) {
      const to = floorPoint();
      await walk(bot, [at, { x: to.x, y: at.y }, to], 13);
      at = to;
      await wait(between(600, 2600));
    }
  }

  // The cat leaves its cushion, strolls around, sits somewhere for a while and goes back to sleep.
  async function catLoop(mine) {
    while (alive(mine) && layout.cat) {
      await wait(between(20000, 50000));
      if (!alive(mine)) return;
      const spot = layout.spots.find((s) => s.use === "cat");
      if (!spot || spot.busy || document.hidden) continue;
      spot.busy = true;
      stage.classList.add("cat-away");
      const home = { x: layout.cat.x + 2, y: layout.cat.y - 1 };
      const cat = { el: sprite("npc cat", catSpriteSvg(layout.cat.color), 14, 9), cancelled: false };
      place(cat.el, home);
      layer().appendChild(cat.el);
      let at = home;
      for (let i = 0; i < 2 && alive(mine); i++) {
        const to = floorPoint();
        await walk(cat, [at, { x: to.x, y: at.y }, to], 20);
        at = to;
        await wait(between(3500, 7000));
      }
      if (!alive(mine)) return;
      await walk(cat, [at, { x: home.x, y: at.y }, home], 20);
      cat.el.remove();
      if (!alive(mine)) return;
      stage.classList.remove("cat-away");
      spot.busy = false;
    }
  }

  // A courier comes in through the door, brings a parcel to the manager's desk and leaves.
  async function courierLoop(mine) {
    const looks = [
      { skin: "#eac09c", hair: "#2b2b2b", hairStyle: "short", headwear: "cap", outfit: "vest", shirt: "#d9844a" },
      { skin: "#ffe0c7", hair: "#8a5a2b", hairStyle: "ponytail", headwear: "cap", outfit: "polo", shirt: "#5fb3b3", gender: "female" },
      { skin: "#c68a5e", hair: "#1f2a44", hairStyle: "buzz", headwear: "visor", outfit: "jersey", shirt: "#7d8fe0" },
    ];
    while (alive(mine)) {
      await wait(between(45000, 110000));
      if (!alive(mine)) return;
      const boss = layout.seats.find((s) => s.wide);
      if (!boss || document.hidden) continue;
      const door = layout.door;
      const drop = { x: boss.cx + (layout.corridorX < boss.cx ? -20 : 20), y: boss.aisleY };
      const path = [door, { x: door.x, y: door.y - 16 }, { x: layout.corridorX, y: door.y - 16 }, { x: layout.corridorX, y: drop.y }, drop];
      const guest = { el: sprite("walker npc courier", walkerSvg({ id: "courier", role: "other", look: any(looks) }, { carry: "parcel" }) + `<span class="emote" hidden></span>`, 18, SPRITE_ROWS), cancelled: false };
      place(guest.el, door);
      layer().appendChild(guest.el);
      openDoor();
      await walk(guest, path);
      if (!alive(mine)) return;
      const emote = guest.el.querySelector(".emote");
      emote.textContent = "📦";
      emote.hidden = false;
      await wait(1800);
      if (!alive(mine)) return;
      emote.hidden = true;
      guest.el.classList.add("delivered");
      const parcel = sprite("npc parcel", parcelSvg(), 9, 7);
      place(parcel, { x: drop.x + 5, y: drop.y + 13 });
      layer().appendChild(parcel);
      setTimeout(() => parcel.remove(), 20000);
      await walk(guest, [...path].reverse());
      if (!alive(mine)) return;
      openDoor();
      await wait(500);
      guest.el.remove();
    }
  }

  return { attach, clear, isAway, sync, tick, note, celebrate, TICK_MS };
})();
