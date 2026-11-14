// Pixel-art renderer for department rooms: floor, walls, furniture and the staff at their desks.
// Everything is drawn as SVG rects in "room pixels"; the SVG viewBox scales the room to any size.
// A room is generated from a seed: layout, furniture models, lounge, decoration and colors all come from it,
// so every department looks different and "randomize" simply picks a new seed.
// Character state is a CSS class on each workstation group (st-working, st-idle, st-waiting, ...),
// so animations live in CSS and the DOM can be updated without rebuilding the room.

const BASE_PX = {
  outline: "#3a2f3f",
  wall: "#5f8190", wallDark: "#4b6774", wallTrim: "#88a9b6", post: "#aab6c0", postDark: "#76828c",
  floor: "#f2e5c8", floorLine: "#e5d3ac", floorAlt: "#e8d6b2", rug: "#e7cf9f", rugEdge: "#d9b97f",
  wood: "#dba35a", woodFront: "#b4793a", woodDark: "#8a5a2b",
  chair: "#d4545f", chairDark: "#9e3742", accent: "#5a8be0",
  leaf: "#5aa04a", leafLight: "#7cc35a", leafDark: "#3d7a36", pot: "#b9663a", potDark: "#8a4626",
  glass: "#a9dbf0", glassLight: "#dff4fc", frame: "#e9eef2",
  metal: "#8d96a3", metalDark: "#5d6470", paper: "#fbfaf4",
  cabinet: "#b86a6f", cabinetDark: "#8c4c52",
};
const PX = { ...BASE_PX };

const ROLE_SHIRTS = {
  pm: "#f08a6c", ba: "#f2c14e", sa: "#6fa3ef", leader: "#5a6c96",
  dev: "#5cc28f", test: "#a98ae6", devops: "#ee9a48", other: "#9aa9b4",
};

// ---------- low-level helpers ----------

function rect(x, y, w, h, fill, cls = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${cls ? ` class="${cls}"` : ""}/>`;
}

// Box with a 1px outline.
function box(x, y, w, h, fill, outline = PX.outline) {
  return rect(x, y, w, h, outline) + rect(x + 1, y + 1, w - 2, h - 2, fill);
}

// Turns a map of "x,y" -> color into rects, merging horizontal runs of the same color.
function pixelsToRects(pixels, ox = 0, oy = 0) {
  const rows = new Map();
  for (const [key, color] of pixels) {
    const [x, y] = key.split(",").map(Number);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push([x, color]);
  }
  let out = "";
  for (const [y, list] of rows) {
    list.sort((a, b) => a[0] - b[0]);
    let start = null;
    let prev = null;
    let color = null;
    const flush = () => { if (start !== null) out += rect(ox + start, oy + y, prev - start + 1, 1, color); };
    for (const [x, c] of list) {
      if (start !== null && x === prev + 1 && c === color) { prev = x; continue; }
      flush();
      start = x; prev = x; color = c;
    }
    flush();
  }
  return out;
}

// Adds a dark outline around every filled pixel (4-neighbourhood).
function withOutline(pixels, color = PX.outline) {
  const out = new Map();
  for (const key of pixels.keys()) {
    const [x, y] = key.split(",").map(Number);
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
      const k = `${x + dx},${y + dy}`;
      if (!pixels.has(k)) out.set(k, color);
    });
  }
  for (const [k, c] of pixels) out.set(k, c);
  return out;
}

function fill(pixels, x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pixels.set(`${x},${y}`, color);
}

function dots(pixels, list, color) {
  list.forEach(([x, y]) => pixels.set(`${x},${y}`, color));
}

function shade(hex, amount) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v + amount)));
  const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function escAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small deterministic random generator, so a seed always gives the same room.
function seededRandom(seed) {
  let a = (Number(seed) || 0) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- characters ----------

const HEADWEAR_COLORS = { cap: "#d9534f", beanie: "#5a8be0", headband: "#e05a5a", bow: "#e8738a", bandana: "#c0392b" };

function lookParts(agent) {
  const look = agent.look || {};
  const role = agent.role || "other";
  return {
    look, role,
    skin: look.skin || "#ffe0c7",
    hair: look.hair || "#4a3426",
    shirt: look.shirt || ROLE_SHIRTS[role] || ROLE_SHIRTS.other,
    style: look.hairStyle || "short",
    // Role accessories win over random headwear and eyewear.
    headwear: role === "devops" ? "hardhat" : (look.headwear || "none"),
    eyewear: role === "sa" ? "round" : (look.eyewear || (look.beard ? "none" : "none")),
    eyes: look.eyes || "tall",
    mouth: look.mouth || "small",
    outfit: role === "leader" && (!look.outfit || look.outfit === "tshirt") ? "suit" : (look.outfit || "tshirt"),
    detail: look.detail || (look.beard ? "beard" : "none"),
  };
}

// Shirt, jacket or other outfit on rows 11-14 (front or back).
function drawOutfit(p, parts, back = false) {
  const { shirt, skin, outfit, role } = parts;
  const dark = shade(shirt, -25);
  fill(p, 3, 11, 10, 11, shirt);
  fill(p, 2, 12, 11, 14, shirt);
  fill(p, 1, 12, 1, 14, dark);
  fill(p, 12, 12, 12, 14, dark);
  if (!back) fill(p, 6, 11, 7, 11, skin);
  switch (outfit) {
    case "collar":
      if (!back) dots(p, [[4, 11], [5, 11], [8, 11], [9, 11], [5, 12], [8, 12]], PX.paper);
      else fill(p, 4, 11, 9, 11, PX.paper);
      break;
    case "hoodie":
      fill(p, 3, 10, 10, 11, dark);
      if (!back) { fill(p, 5, 10, 8, 11, skin); dots(p, [[5, 12], [5, 13], [8, 12], [8, 13]], PX.paper); }
      else fill(p, 4, 12, 9, 13, dark);
      break;
    case "sweater":
      fill(p, 2, 12, 11, 12, shade(shirt, 35));
      fill(p, 2, 14, 11, 14, shade(shirt, 35));
      break;
    case "suit": {
      const jacket = "#3b3f52";
      fill(p, 2, 11, 11, 14, jacket);
      fill(p, 1, 12, 1, 14, shade(jacket, -10));
      fill(p, 12, 12, 12, 14, shade(jacket, -10));
      if (!back) { fill(p, 5, 11, 8, 12, PX.paper); fill(p, 6, 11, 7, 11, skin); fill(p, 6, 13, 7, 14, PX.paper); }
      break;
    }
    case "overalls":
      fill(p, 4, 12, 9, 14, "#4a6fa5");
      if (!back) { dots(p, [[4, 11], [9, 11]], "#4a6fa5"); dots(p, [[5, 13], [8, 13]], "#f5c242"); }
      else { dots(p, [[4, 11], [5, 12], [8, 12], [9, 11]], "#4a6fa5"); }
      break;
    case "scarf":
      fill(p, 3, 11, 10, 11, "#e05a5a");
      if (!back) fill(p, 9, 12, 9, 13, "#e05a5a");
      break;
    default:
      break;
  }
  if (role === "leader" && !back) { fill(p, 6, 12, 7, 13, "#c0392b"); dots(p, [[6, 14], [7, 14]], "#c0392b"); }
  if (role === "pm" && !back && outfit === "tshirt") dots(p, [[5, 11], [8, 11]], PX.paper);
}

// Hair that hangs behind the head and shoulders (drawn before the head).
function drawBackHair(p, parts) {
  const { style, hair } = parts;
  if (style === "long") { fill(p, 1, 4, 2, 13, hair); fill(p, 11, 4, 12, 13, hair); }
  if (style === "bob") { fill(p, 1, 4, 2, 9, hair); fill(p, 11, 4, 12, 9, hair); }
  if (style === "ponytail") { fill(p, 12, 3, 13, 4, hair); fill(p, 13, 5, 13, 10, hair); }
  if (style === "twintails") { fill(p, 0, 4, 1, 10, hair); fill(p, 12, 4, 13, 10, hair); }
  if (style === "braid") { fill(p, 11, 5, 12, 12, hair); dots(p, [[11, 7], [12, 9], [11, 11]], shade(hair, 30)); }
  if (style === "afro") { fill(p, 0, 2, 1, 8, hair); fill(p, 12, 2, 13, 8, hair); }
}

function drawHead(p, skin) {
  fill(p, 3, 2, 10, 2, skin);
  fill(p, 2, 3, 11, 9, skin);
  fill(p, 3, 10, 10, 10, skin);
}

// Hair on top of the head, front view.
function drawFrontHair(p, parts) {
  const { style, hair, skin } = parts;
  if (style === "bald") { p.set("4,3", shade(skin, 25)); return; }
  if (style === "mohawk") { fill(p, 6, 0, 7, 3, hair); fill(p, 3, 2, 10, 2, shade(skin, -30)); return; }
  if (style === "buzz") { fill(p, 3, 2, 10, 2, hair); fill(p, 2, 3, 11, 3, shade(hair, 20)); return; }
  if (style === "afro") { fill(p, 1, 0, 12, 3, hair); fill(p, 2, 4, 3, 4, hair); fill(p, 10, 4, 11, 4, hair); return; }
  if (style === "bun") fill(p, 5, 0, 8, 1, hair);
  if (style === "spiky") [3, 5, 8, 10].forEach((x) => p.set(`${x},1`, hair));
  if (style === "curly") { [3, 5, 7, 9].forEach((x) => p.set(`${x},1`, hair)); }
  fill(p, 3, 2, 10, 2, hair);
  fill(p, 2, 3, 11, 3, hair);
  if (style === "short" || style === "spiky") { fill(p, 2, 4, 5, 4, hair); p.set("2,5", hair); p.set("11,4", hair); p.set("11,5", hair); }
  if (style === "curly") { dots(p, [[2, 4], [4, 4], [9, 4], [11, 4], [2, 5], [11, 5]], hair); }
  if (style === "bun" || style === "ponytail" || style === "twintails") { fill(p, 2, 4, 4, 4, hair); fill(p, 10, 4, 11, 4, hair); }
  if (style === "long") { fill(p, 2, 4, 4, 4, hair); fill(p, 9, 4, 11, 4, hair); }
  if (style === "bob") fill(p, 2, 4, 11, 4, hair);
  if (style === "side" || style === "braid") { fill(p, 2, 4, 8, 4, hair); fill(p, 2, 5, 3, 5, hair); p.set("11,4", hair); }
}

function drawHeadwear(p, parts, back = false) {
  const { headwear, role } = parts;
  const c = HEADWEAR_COLORS[headwear];
  if (headwear === "hardhat") { fill(p, 3, 1, 10, 1, "#f5c242"); fill(p, 2, 2, 11, 3, "#f5c242"); fill(p, 1, 4, 12, 4, "#e0a92e"); }
  if (headwear === "cap") {
    fill(p, 3, 1, 10, 1, c); fill(p, 2, 2, 11, 3, c);
    if (!back) fill(p, 1, 4, 7, 4, shade(c, -30)); else fill(p, 5, 3, 8, 3, shade(c, -30));
  }
  if (headwear === "beanie") { p.set("6,0", PX.paper); p.set("7,0", PX.paper); fill(p, 3, 1, 10, 1, c); fill(p, 2, 2, 11, 3, c); fill(p, 2, 4, 11, 4, shade(c, 30)); }
  if (headwear === "headband") fill(p, 2, 3, 11, 3, c);
  if (headwear === "bandana") { fill(p, 2, 2, 11, 3, c); dots(p, [[12, 4], [13, 5]], c); }
  if (headwear === "bow") { dots(p, [[9, 1], [10, 2], [12, 1], [11, 2], [9, 2], [12, 2]], c); dots(p, [[10, 1], [11, 1]], shade(c, -30)); }
  if (role === "dev") { fill(p, 3, 1, 10, 1, "#3b3b4f"); fill(p, 1, 5, 1, 7, "#e05a5a"); fill(p, 12, 5, 12, 7, "#e05a5a"); }
}

// Eye pixels, used for blinking.
function eyePixels(parts) {
  const { eyes, eyewear } = parts;
  if (eyewear === "sunglasses") return [];
  if (eyewear === "round") return [[4, 7], [9, 7]];
  if (eyes === "dot") return [[4, 7], [9, 7]];
  if (eyes === "happy") return [[3, 7], [4, 6], [5, 7], [8, 7], [9, 6], [10, 7]];
  if (eyes === "sleepy") return [[4, 7], [5, 7], [8, 7], [9, 7]];
  if (eyes === "wide") return [[4, 6], [5, 6], [4, 7], [5, 7], [8, 6], [9, 6], [8, 7], [9, 7]];
  return [[4, 6], [4, 7], [9, 6], [9, 7]];
}

function drawFace(p, parts) {
  const { look, skin, hair, eyes, eyewear, mouth, detail } = parts;
  const eye = eyePixels(parts);
  dots(p, eye, PX.outline);
  if (eyes === "wide" && eyewear !== "sunglasses") dots(p, [[4, 6], [8, 6]], PX.paper);
  if (look.gender === "female" && eyes === "tall" && eyewear === "none") dots(p, [[3, 6], [10, 6]], PX.outline);
  if (eyewear === "round") { [3, 5, 6, 7, 8, 10].forEach((x) => p.set(`${x},6`, PX.outline)); dots(p, [[4, 6], [9, 6]], "#cfeaff"); }
  if (eyewear === "square") { fill(p, 3, 5, 5, 5, PX.outline); fill(p, 8, 5, 10, 5, PX.outline); dots(p, [[3, 6], [5, 6], [6, 6], [7, 6], [8, 6], [10, 6]], PX.outline); }
  if (eyewear === "sunglasses") { fill(p, 3, 6, 5, 7, "#1f2633"); fill(p, 8, 6, 10, 7, "#1f2633"); fill(p, 6, 6, 7, 6, "#1f2633"); dots(p, [[3, 6], [8, 6]], "#6a7a99"); }
  // Cheeks and face details.
  if (detail === "blush") dots(p, [[3, 8], [4, 8], [9, 8], [10, 8]], "#f4a3a3");
  else dots(p, [[3, 8], [10, 8]], "#f4a3a3");
  if (detail === "freckles") dots(p, [[4, 8], [9, 8], [5, 8]], shade(skin, -60));
  if (detail === "earrings") dots(p, [[1, 8], [12, 8]], "#f5c242");
  if (detail === "stubble") { fill(p, 3, 9, 10, 10, shade(skin, -28)); }
  if (detail === "beard") { fill(p, 3, 9, 5, 10, hair); fill(p, 8, 9, 10, 10, hair); fill(p, 6, 10, 7, 10, hair); }
  // Mouth.
  const lip = "#b5535b";
  if (mouth === "smile") dots(p, [[5, 9], [8, 9], [6, 10], [7, 10]], lip);
  else if (mouth === "open") fill(p, 6, 9, 7, 10, "#7a3b3b");
  else if (mouth === "flat") fill(p, 5, 9, 8, 9, lip);
  else fill(p, 6, 9, 7, 9, lip);
  if (detail === "mustache") fill(p, 5, 8, 8, 8, hair);
}

// Upper body facing the viewer (14 x 15 pixels). Legs are hidden behind the desk.
function characterPixels(agent) {
  const parts = lookParts(agent);
  const p = new Map();
  drawBackHair(p, parts);
  drawOutfit(p, parts);
  drawHead(p, parts.skin);
  drawFrontHair(p, parts);
  drawHeadwear(p, parts);
  drawFace(p, parts);
  return p;
}

// Upper body seen from behind (sitting with the back to the viewer).
function characterBackPixels(agent) {
  const parts = lookParts(agent);
  const { style, hair, skin } = parts;
  const p = new Map();
  if (style === "twintails") { fill(p, 0, 4, 1, 10, hair); fill(p, 12, 4, 13, 10, hair); }
  if (style === "afro") { fill(p, 0, 2, 13, 8, hair); }
  drawOutfit(p, parts, true);
  drawHead(p, skin);
  dots(p, [[2, 6], [11, 6], [2, 7], [11, 7]], shade(skin, -15));
  const covered = !["bald", "buzz", "mohawk"].includes(style);
  if (covered) { fill(p, 3, 1, 10, 2, hair); fill(p, 2, 3, 11, 8, hair); fill(p, 3, 9, 10, 9, hair); }
  if (style === "buzz") fill(p, 2, 2, 11, 7, shade(hair, 20));
  if (style === "mohawk") fill(p, 6, 0, 7, 8, hair);
  if (style === "bald") p.set("5,3", shade(skin, 25));
  if (style === "afro") fill(p, 1, 0, 12, 9, hair);
  if (style === "curly") [3, 5, 7, 9].forEach((x) => p.set(`${x},0`, hair));
  if (style === "bun") fill(p, 5, 0, 8, 1, hair);
  if (style === "long") fill(p, 2, 9, 11, 13, hair);
  if (style === "bob") fill(p, 2, 9, 11, 10, hair);
  if (style === "ponytail") fill(p, 6, 8, 7, 13, hair);
  if (style === "braid") { fill(p, 6, 8, 7, 14, hair); dots(p, [[6, 10], [7, 12]], shade(hair, 30)); }
  drawHeadwear(p, parts, true);
  return p;
}

// A character sprite as SVG; eyelids and the raised arm are separate groups for CSS animation.
function characterSvg(agent, ox, oy, { back = false } = {}) {
  const parts = lookParts(agent);
  if (back) {
    const arm = new Map();
    fill(arm, 12, 5, 13, 11, parts.shirt);
    fill(arm, 12, 3, 13, 4, parts.skin);
    return `<g class="body">${pixelsToRects(withOutline(characterBackPixels(agent)), ox, oy)}
      <g class="arm-up">${pixelsToRects(withOutline(arm), ox, oy)}</g></g>`;
  }
  const pixels = withOutline(characterPixels(agent));
  const lids = new Map(eyePixels(parts).map(([x, y]) => [`${x},${y}`, parts.skin]));
  const arm = new Map();
  fill(arm, 12, 5, 13, 11, parts.outfit === "suit" ? "#3b3f52" : parts.shirt);
  fill(arm, 12, 3, 13, 4, parts.skin);
  return `<g class="body">${pixelsToRects(pixels, ox, oy)}
    <g class="lids">${pixelsToRects(lids, ox, oy)}</g>
    <g class="arm-up">${pixelsToRects(withOutline(arm), ox, oy)}</g></g>`;
}

// Square portrait used in the panel and the team proposal.
function portraitSvg(agent) {
  return `<svg class="portrait" viewBox="-1 -1 16 17" shape-rendering="crispEdges" aria-hidden="true">
    ${pixelsToRects(withOutline(characterPixels(agent)))}</svg>`;
}

// ---------- furniture ----------

function plant(x, y, big = false) {
  const p = new Map();
  if (big) {
    fill(p, 2, 0, 5, 1, PX.leafLight); fill(p, 0, 2, 7, 5, PX.leaf); fill(p, 1, 6, 6, 7, PX.leafDark);
    p.set("1,2", PX.leafLight); p.set("5,3", PX.leafLight); p.set("3,4", PX.leafDark);
    fill(p, 1, 8, 6, 12, PX.pot); fill(p, 1, 12, 6, 12, PX.potDark);
  } else {
    fill(p, 1, 0, 3, 1, PX.leafLight); fill(p, 0, 2, 4, 3, PX.leaf);
    fill(p, 1, 4, 3, 6, PX.pot);
  }
  return pixelsToRects(withOutline(p), x, y);
}

function cactus(x, y) {
  const p = new Map();
  fill(p, 2, 0, 3, 7, "#4f9a5a"); fill(p, 0, 2, 1, 4, "#4f9a5a"); fill(p, 4, 3, 5, 5, "#4f9a5a");
  fill(p, 1, 8, 4, 11, "#c98a5a");
  return pixelsToRects(withOutline(p), x, y);
}

function windowSvg(x, y, w, h, night = false) {
  if (night) {
    return box(x, y, w, h, PX.frame) + rect(x + 2, y + 2, w - 4, h - 4, "#1d2547") +
      rect(x + 6, y + 5, 1, 1, "#ffffff") + rect(x + w - 9, y + 8, 1, 1, "#ffffff") + rect(x + 12, y + 10, 1, 1, "#fff3a6") +
      rect(x + w - 12, y + 4, 3, 3, "#fff3a6") + rect(x + Math.floor(w / 2) - 1, y + 1, 2, h - 2, PX.frame);
  }
  return box(x, y, w, h, PX.frame) + rect(x + 2, y + 2, w - 4, h - 4, PX.glass) +
    rect(x + 2, y + 2, w - 4, 3, PX.glassLight) + rect(x + Math.floor(w / 2) - 1, y + 1, 2, h - 2, PX.frame) +
    rect(x + 3, y + h - 6, w - 6, 3, "#9fcf8a");
}

function roundWindow(x, y) {
  const p = new Map();
  fill(p, 3, 0, 10, 0, PX.frame); fill(p, 1, 1, 12, 1, PX.frame); fill(p, 0, 2, 13, 11, PX.frame);
  fill(p, 1, 12, 12, 12, PX.frame); fill(p, 3, 13, 10, 13, PX.frame);
  fill(p, 3, 2, 10, 11, PX.glass); fill(p, 2, 3, 11, 10, PX.glass); fill(p, 3, 3, 6, 4, PX.glassLight);
  return pixelsToRects(withOutline(p), x, y);
}

function whiteboard(x, y) {
  return box(x, y, 34, 18, "#fbfdff") + rect(x + 3, y + 4, 14, 1, "#e05a5a") + rect(x + 3, y + 7, 20, 1, "#5a8be0") +
    rect(x + 3, y + 10, 10, 1, "#5cc28f") + rect(x + 20, y + 9, 9, 6, "#ffe9a8") + rect(x + 1, y + 17, 32, 2, PX.metalDark);
}

function clock(x, y) {
  return box(x, y, 9, 9, "#fbfdff") + rect(x + 4, y + 2, 1, 3, PX.outline) + rect(x + 4, y + 4, 3, 1, PX.outline);
}

function posters(x, y) {
  return box(x, y, 14, 17, PX.frame) + rect(x + 2, y + 2, 10, 13, "#f5c242") + rect(x + 4, y + 5, 6, 6, "#e05a5a") +
    box(x + 17, y + 2, 13, 15, PX.frame) + rect(x + 19, y + 4, 9, 11, "#6fa3ef") + rect(x + 21, y + 9, 5, 4, PX.paper);
}

function wallScreen(x, y) {
  return box(x, y, 40, 19, "#1f2633") + rect(x + 3, y + 3, 14, 2, "#5cc28f") + rect(x + 3, y + 7, 22, 1, "#6fa3ef") +
    rect(x + 3, y + 10, 18, 1, "#6fa3ef") + rect(x + 26, y + 4, 10, 10, "#2d3a4f") + rect(x + 28, y + 9, 2, 4, "#f5c242") +
    rect(x + 31, y + 6, 2, 7, "#5cc28f") + rect(x + 18, y + 19, 4, 3, PX.metalDark);
}

function worldMap(x, y) {
  return box(x, y, 32, 18, "#bfe3f2") + rect(x + 4, y + 4, 8, 5, "#7cc35a") + rect(x + 6, y + 9, 4, 5, "#7cc35a") +
    rect(x + 15, y + 3, 6, 6, "#7cc35a") + rect(x + 16, y + 9, 4, 6, "#7cc35a") + rect(x + 23, y + 4, 6, 5, "#7cc35a");
}

function banner(x, y) {
  let s = rect(x, y, 38, 1, PX.metalDark);
  ["#e05a5a", "#f5c242", "#5cc28f", "#5a8be0", "#a98ae6"].forEach((c, i) => {
    s += rect(x + 2 + i * 7, y + 1, 5, 3, c) + rect(x + 3 + i * 7, y + 4, 3, 2, c) + rect(x + 4 + i * 7, y + 6, 1, 1, c);
  });
  return s;
}

function neonSign(x, y) {
  return box(x, y, 30, 12, "#2a2433") + rect(x + 4, y + 3, 2, 6, "#ff6fb5") + rect(x + 6, y + 3, 4, 2, "#ff6fb5") +
    rect(x + 12, y + 3, 2, 6, "#6ff2ff") + rect(x + 14, y + 7, 4, 2, "#6ff2ff") + rect(x + 20, y + 3, 6, 2, "#fff36f") + rect(x + 22, y + 5, 2, 4, "#fff36f");
}

function plantShelf(x, y) {
  return rect(x, y + 12, 32, 2, PX.woodFront) + plant(x + 2, y + 4) + plant(x + 13, y + 4) + cactus(x + 24, y + 1);
}

function bookshelf(x, y) {
  const books = ["#e05a5a", "#5a8be0", "#f5c242", "#5cc28f", "#a98ae6", "#ee9a48"];
  let s = box(x, y, 30, 22, PX.woodFront) + rect(x + 1, y + 10, 28, 1, PX.woodDark);
  for (let i = 0; i < 8; i++) s += rect(x + 3 + i * 3, y + 3 + (i % 3), 2, 7 - (i % 3), books[i % books.length]);
  for (let i = 0; i < 6; i++) s += rect(x + 3 + i * 4, y + 13 + (i % 2), 3, 7 - (i % 2), books[(i + 2) % books.length]);
  return s;
}

function trophyShelf(x, y) {
  return rect(x, y + 14, 30, 2, PX.woodFront) + box(x + 3, y + 6, 6, 6, "#f5c242") + rect(x + 5, y + 12, 2, 2, "#d9a441") +
    box(x + 12, y + 3, 6, 9, "#cfd6de") + rect(x + 14, y + 12, 2, 2, "#9aa3ad") + box(x + 21, y + 7, 6, 5, "#e0915a") + rect(x + 23, y + 12, 2, 2, "#b56b3a");
}

function cabinet(x, y) {
  return box(x, y, 12, 14, PX.cabinet) + rect(x + 1, y + 6, 10, 1, PX.cabinetDark) +
    rect(x + 5, y + 3, 2, 1, PX.paper) + rect(x + 5, y + 9, 2, 1, PX.paper);
}

function waterCooler(x, y) {
  return box(x + 2, y, 8, 7, "#bfe6fb") + box(x, y + 6, 12, 12, PX.frame) + rect(x + 4, y + 10, 4, 2, "#5a8be0");
}

function coffeeMachine(x, y) {
  return box(x, y + 4, 16, 6, PX.woodFront) + box(x + 3, y - 6, 10, 11, PX.metalDark) +
    rect(x + 5, y - 4, 6, 2, "#e05a5a") + rect(x + 6, y + 1, 4, 3, PX.paper);
}

function vendingMachine(x, y) {
  let s = box(x, y - 8, 16, 24, "#d9534f") + rect(x + 2, y - 6, 9, 16, "#2a2433");
  ["#f5c242", "#5cc28f", "#6fa3ef", "#ffffff"].forEach((c, i) => { s += rect(x + 3, y - 5 + i * 4, 3, 2, c) + rect(x + 7, y - 5 + i * 4, 3, 2, c); });
  return s + rect(x + 12, y - 4, 2, 6, PX.paper) + rect(x + 2, y + 12, 9, 2, "#2a2433");
}

function aquarium(x, y) {
  return box(x, y + 10, 26, 6, PX.woodFront) + box(x + 1, y - 4, 24, 15, "#7fd0ef") + rect(x + 2, y - 3, 22, 2, "#b9ecfb") +
    rect(x + 6, y + 2, 4, 2, "#ff8c42") + rect(x + 10, y + 2, 1, 2, "#ff8c42") + rect(x + 16, y + 5, 3, 2, "#f5c242") +
    rect(x + 3, y + 6, 1, 4, "#3d7a36") + rect(x + 21, y + 4, 1, 6, "#3d7a36");
}

function arcade(x, y) {
  return box(x, y - 10, 16, 26, "#6a4aa6") + box(x + 2, y - 7, 12, 9, "#1f2633") + rect(x + 4, y - 5, 3, 2, "#5cc28f") +
    rect(x + 9, y - 3, 3, 2, "#ff6fb5") + rect(x + 2, y + 4, 12, 3, "#2a2433") + rect(x + 4, y + 4, 2, 2, "#e05a5a") + rect(x + 10, y + 5, 2, 1, "#f5c242");
}

function printer(x, y) {
  return box(x, y + 4, 18, 12, PX.metalDark) + box(x + 2, y, 14, 6, "#cfd6de") + rect(x + 4, y - 3, 10, 3, PX.paper) +
    rect(x + 3, y + 8, 4, 1, "#5cc28f");
}

function beanbags(x, y) {
  const one = (bx, c) => {
    const p = new Map();
    fill(p, 2, 0, 7, 1, c); fill(p, 0, 2, 9, 6, c); fill(p, 1, 7, 8, 7, shade(c, -30)); fill(p, 3, 2, 6, 3, shade(c, 25));
    return pixelsToRects(withOutline(p), bx, y);
  };
  return one(x, "#e8738a") + one(x + 13, "#6fa3ef");
}

function floorLamp(x, y) {
  return rect(x + 4, y - 4, 1, 16, PX.metalDark) + box(x, y - 9, 9, 6, "#fff3a6") + box(x + 1, y + 12, 7, 3, PX.metalDark);
}

// ---------- desks and chairs ----------

const DESK_MODELS = {
  wood: () => ({ top: PX.wood, front: PX.woodFront, edge: PX.woodDark }),
  white: () => ({ top: "#f4f4f1", front: "#d7dbdf", edge: "#aab2bb" }),
  dark: () => ({ top: "#565c6b", front: "#3d424e", edge: "#2b2f38" }),
};

function deskSvg(x, y, w, model) {
  const c = (DESK_MODELS[model] || DESK_MODELS.wood)();
  return box(x, y, w, 7, c.top) + rect(x + 1, y + 1, w - 2, 1, shade(c.top, 22)) +
    box(x, y + 6, w, 6, c.front) + rect(x + 1, y + 10, w - 2, 1, c.edge);
}

// Chair behind a character that faces the viewer.
function chairBackSvg(cx, y, model) {
  if (model === "stool") return "";
  if (model === "gaming") {
    return box(cx - 2, y + 5, 18, 19, "#2a2433") + rect(cx + 5, y + 6, 4, 17, PX.accent) + box(cx + 2, y + 2, 10, 5, "#2a2433");
  }
  return box(cx - 2, y + 9, 18, 15, PX.chair) + rect(cx - 1, y + 10, 16, 2, shade(PX.chair, 25));
}

// Chair in front of a character that sits with the back to the viewer.
function chairFrontSvg(cx, y, model) {
  if (model === "stool") return box(cx + 2, y + 10, 10, 4, PX.metal);
  if (model === "gaming") return box(cx - 2, y, 18, 14, "#2a2433") + rect(cx + 5, y + 1, 4, 12, PX.accent);
  return box(cx - 2, y, 18, 12, PX.chair) + rect(cx - 1, y + 1, 16, 2, shade(PX.chair, 25)) + rect(cx + 5, y + 12, 4, 3, PX.metalDark);
}

function deskProp(role, x, y) {
  if (role === "pm") return box(x, y, 7, 9, "#b07d4f") + rect(x + 2, y + 2, 3, 5, PX.paper) + rect(x + 2, y - 1, 3, 2, PX.metal);
  if (role === "ba") return box(x, y + 1, 7, 8, "#fff3a6") + rect(x + 2, y + 3, 3, 1, PX.metal) + rect(x + 2, y + 5, 3, 1, PX.metal);
  if (role === "test") return box(x + 1, y, 6, 6, "#d7f0ff") + rect(x + 6, y + 6, 2, 3, PX.metalDark);
  if (role === "sa" || role === "leader") return box(x, y + 2, 8, 3, "#5a8be0") + box(x + 1, y + 4, 8, 3, "#e05a5a") + box(x, y + 6, 8, 3, "#f5c242");
  if (role === "devops") return box(x, y + 2, 8, 7, "#3b3b4f") + rect(x + 2, y + 4, 1, 1, "#5cc28f") + rect(x + 4, y + 4, 1, 1, "#5cc28f");
  return plant(x, y + 1);
}

// Status icons drawn above the head; CSS shows the one matching the state.
function statusIcons(x, y) {
  const bubble = (inner, border = PX.outline, bg = "#ffffff") =>
    box(x, y, 13, 9, bg, border) + rect(x + 3, y + 9, 2, 2, border) + inner;
  return `
    <g class="icon icon-think">${bubble(`<rect class="d1" x="${x + 3}" y="${y + 4}" width="1" height="1" fill="${PX.outline}"/>
      <rect class="d2" x="${x + 6}" y="${y + 4}" width="1" height="1" fill="${PX.outline}"/>
      <rect class="d3" x="${x + 9}" y="${y + 4}" width="1" height="1" fill="${PX.outline}"/>`)}</g>
    <g class="icon icon-talk">${bubble(rect(x + 3, y + 3, 7, 1, PX.metal) + rect(x + 3, y + 5, 5, 1, PX.metal))}</g>
    <g class="icon icon-alert">${bubble(rect(x + 6, y + 2, 1, 4, "#c0392b") + rect(x + 6, y + 7, 1, 1, "#c0392b"), "#a77b00", "#ffd84d")}</g>
    <g class="icon icon-error">${bubble(rect(x + 4, y + 3, 5, 1, "#ffffff") + rect(x + 3, y + 5, 7, 1, "#ffffff"), "#555b66", "#8b93a1")}</g>
    <g class="icon icon-done">${bubble(rect(x + 4, y + 5, 1, 1, "#22744c") + rect(x + 5, y + 6, 1, 1, "#22744c") +
      rect(x + 6, y + 5, 1, 1, "#22744c") + rect(x + 7, y + 4, 1, 1, "#22744c") + rect(x + 8, y + 3, 1, 1, "#22744c"), "#2f8a5b", "#d8f5e5")}</g>`;
}

// A desk with its chair, the agent, a laptop and a role prop, facing the viewer. Slot: 44 x 40 (wide: 62 x 40).
function workstationSvg(agent, x, y, { wide = false, desk = "wood", chair = "office", deskX, deskW } = {}) {
  const w = wide ? 58 : 40;
  const dx = deskX ?? x + 2;
  const dw = deskW ?? w;
  const cx = x + 2 + Math.floor(w / 2) - 7; // character left edge
  const deskY = y + 22;
  const skin = (agent.look && agent.look.skin) || "#ffe0c7";
  return `
  <g class="ws st-idle" data-agent="${escAttr(agent.id)}">
    ${rect(dx + 2, deskY + 12, dw - 4, 2, "rgba(90,60,30,.18)")}
    ${chairBackSvg(cx, y, chair)}
    ${characterSvg(agent, cx, y + 6)}
    <rect class="glow" x="${cx + 2}" y="${y + 9}" width="10" height="7" fill="#9fe7ff"/>
    ${deskSvg(dx, deskY, dw, desk)}
    ${box(cx + 2, deskY - 3, 10, 5, PX.metal)}${rect(cx + 6, deskY - 2, 2, 2, PX.frame)}
    <g class="hands">${rect(cx, deskY + 1, 2, 1, skin)}${rect(cx + 12, deskY + 1, 2, 1, skin)}</g>
    <g class="mug">${box(x + w - 7, deskY - 3, 5, 5, PX.paper)}${rect(x + w - 2, deskY - 2, 1, 2, PX.outline)}
      <g class="steam">${rect(x + w - 6, deskY - 6, 1, 2, "#ffffff")}${rect(x + w - 4, deskY - 8, 1, 2, "#ffffff")}</g></g>
    ${deskProp(agent.role, x + 4, deskY - 8)}
    ${wide ? deskProp("sa", x + 15, deskY - 8) : ""}
    ${statusIcons(cx + 9, y - 6)}
  </g>`;
}

// The same, but the agent sits with the back to the viewer: desk first, then the agent, then the chair.
function workstationBackSvg(agent, x, y, { desk = "wood", chair = "office" } = {}) {
  const w = 40;
  const cx = x + 2 + Math.floor(w / 2) - 7;
  return `
  <g class="ws st-idle back" data-agent="${escAttr(agent.id)}">
    ${deskSvg(x + 2, y, w, desk)}
    ${box(cx + 1, y - 4, 12, 7, PX.metalDark)}<rect class="screen" x="${cx + 2}" y="${y - 3}" width="10" height="5" fill="#9fe7ff"/>
    <rect class="glow" x="${cx + 2}" y="${y - 3}" width="10" height="5" fill="#ffffff"/>
    ${box(x + w - 6, y + 1, 5, 5, PX.paper)}
    ${characterSvg(agent, cx, y + 8, { back: true })}
    ${chairFrontSvg(cx, y + 17, chair)}
    ${statusIcons(cx + 10, y - 2)}
  </g>`;
}

// ---------- lounge areas ----------

function meetingTable(x, y) {
  let s = "";
  const chairs = [[x + 4, y - 7], [x + 20, y - 7], [x + 4, y + 22], [x + 20, y + 22]];
  chairs.forEach(([cx, cy]) => { s += box(cx, cy, 10, 7, PX.chair) + rect(cx + 1, cy + 5, 8, 1, PX.chairDark); });
  s += box(x, y, 34, 20, PX.wood) + rect(x + 1, y + 15, 32, 4, PX.woodFront);
  s += rect(x + 8, y + 5, 6, 4, PX.paper) + rect(x + 20, y + 6, 5, 3, PX.paper);
  return s;
}

function sofaCorner(x, y) {
  const sofa = PX.accent;
  return box(x + 6, y - 6, 26, 14, "#2a2433") + rect(x + 8, y - 4, 22, 10, "#3f6fb0") + rect(x + 17, y + 8, 4, 3, PX.metalDark) +
    box(x + 9, y + 16, 20, 8, PX.wood) +
    box(x, y + 28, 38, 12, sofa) + rect(x + 1, y + 29, 36, 3, shade(sofa, 25)) + rect(x + 12, y + 32, 1, 7, shade(sofa, -30)) + rect(x + 25, y + 32, 1, 7, shade(sofa, -30));
}

function pingPong(x, y) {
  return box(x, y, 36, 22, "#2f7d4f") + rect(x + 1, y + 10, 34, 2, PX.paper) + rect(x + 17, y + 1, 1, 20, PX.paper) +
    rect(x + 2, y + 22, 2, 4, PX.metalDark) + rect(x + 32, y + 22, 2, 4, PX.metalDark) +
    box(x + 6, y + 4, 5, 5, "#e05a5a") + box(x + 26, y + 14, 5, 5, "#e05a5a") + rect(x + 20, y + 6, 2, 2, "#ffffff");
}

function roundTable(x, y) {
  const p = new Map();
  fill(p, 4, 0, 13, 0, PX.wood); fill(p, 2, 1, 15, 2, PX.wood); fill(p, 1, 3, 16, 9, PX.wood);
  fill(p, 2, 10, 15, 11, PX.woodFront); fill(p, 4, 12, 13, 12, PX.woodFront);
  let s = pixelsToRects(withOutline(p), x + 9, y + 8);
  [[x + 1, y + 10], [x + 28, y + 10], [x + 14, y - 2], [x + 14, y + 23]].forEach(([sx, sy]) => { s += box(sx, sy, 8, 7, PX.chair); });
  return s + rect(x + 15, y + 12, 6, 3, PX.paper);
}

function lounge(kind, x, y) {
  if (kind === "sofa") return sofaCorner(x + 8, y + 6);
  if (kind === "pingpong") return pingPong(x + 10, y + 14);
  if (kind === "round") return roundTable(x + 8, y + 12);
  return meetingTable(x + 12, y + 14);
}

// ---------- room style ----------

const PALETTES = [
  { name: "Harbor", floor: "tiles", colors: {} },
  { name: "Forest", floor: "planks", colors: {
    wall: "#5d7a52", wallDark: "#4a6342", wallTrim: "#8fae7f", floor: "#d9b78a", floorLine: "#c49a68", floorAlt: "#ceaa7b",
    rug: "#b9cf9a", rugEdge: "#93ad75", chair: "#e0a63b", chairDark: "#b07f22", accent: "#6aa84f" } },
  { name: "Sunset", floor: "checker", colors: {
    wall: "#b8674f", wallDark: "#96503d", wallTrim: "#e09a7f", floor: "#f2d2b0", floorLine: "#e3b48a", floorAlt: "#ecc39b",
    rug: "#f2d27a", rugEdge: "#d8b04f", chair: "#4f7fb8", chairDark: "#365d8c", accent: "#e8738a" } },
  { name: "Midnight", floor: "carpet", night: true, colors: {
    wall: "#3c4466", wallDark: "#2e3552", wallTrim: "#6a74a3", floor: "#9097b0", floorLine: "#838aa4", floorAlt: "#878ea8",
    rug: "#5f6a96", rugEdge: "#4b5580", chair: "#8e6bd1", chairDark: "#6a4aa6", post: "#7c86a6", postDark: "#535c7a", accent: "#ff6fb5" } },
  { name: "Sakura", floor: "planks", colors: {
    wall: "#d48ea3", wallDark: "#b97389", wallTrim: "#f2bccb", floor: "#f4e3d1", floorLine: "#e6cdb5", floorAlt: "#efd9c2",
    rug: "#fbd3df", rugEdge: "#eaa9bd", chair: "#6fa86b", chairDark: "#4c7f49", accent: "#c27ac9" } },
  { name: "Lab", floor: "tiles", colors: {
    wall: "#4d5560", wallDark: "#3c434c", wallTrim: "#7a8592", floor: "#dde2e6", floorLine: "#c9d0d6", floorAlt: "#d3d9de",
    rug: "#a9dcea", rugEdge: "#7cc0d4", chair: "#38a3a5", chairDark: "#26797b", glass: "#bfe6f2", accent: "#38a3a5" } },
  { name: "Sand", floor: "checker", colors: {
    wall: "#8a6f4e", wallDark: "#6f583c", wallTrim: "#b89a72", floor: "#f3ead6", floorLine: "#e2d4b4", floorAlt: "#e9dcc0",
    rug: "#c9e0d0", rugEdge: "#9cc2a8", chair: "#2f8a7a", chairDark: "#1f6458", accent: "#d9844a" } },
  { name: "Mint", floor: "carpet", colors: {
    wall: "#5fa596", wallDark: "#4a8578", wallTrim: "#93cdbf", floor: "#e8f1ec", floorLine: "#d4e4da", floorAlt: "#dcebe2",
    rug: "#f7d6a0", rugEdge: "#e6b867", chair: "#e0645a", chairDark: "#b4473e", accent: "#f2a65a" } },
];

const LAYOUTS = ["rows", "cubicles", "pods", "bench"];
const LOUNGES = ["meeting", "sofa", "pingpong", "round"];
const DESKS = ["wood", "white", "dark"];
const CHAIRS = ["office", "gaming", "stool"];
const WALL_DECOR = ["whiteboard", "posters", "screen", "map", "banner", "neon", "plantShelf", "clock"];
const FLOOR_EXTRAS = ["coffee", "cooler", "vending", "aquarium", "arcade", "printer", "beanbags", "lamp", "bigPlant"];
const PM_SHELVES = ["bookshelf", "trophies", "plantShelf"];

function pickFrom(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function pickMany(rnd, list, count) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

// Everything that makes a room look the way it does, derived from one number.
function roomStyle(seed) {
  const rnd = seededRandom(seed);
  const palette = pickFrom(rnd, PALETTES);
  return {
    seed,
    palette,
    layout: pickFrom(rnd, LAYOUTS),
    pmSide: rnd() < 0.5 ? "right" : "left",
    lounge: pickFrom(rnd, LOUNGES),
    desk: pickFrom(rnd, DESKS),
    chair: pickFrom(rnd, CHAIRS),
    windows: 1 + Math.floor(rnd() * 3),
    roundWindows: rnd() < 0.25,
    wallDecor: pickMany(rnd, WALL_DECOR, 2),
    extras: pickMany(rnd, FLOOR_EXTRAS, 3),
    pmShelf: pickFrom(rnd, PM_SHELVES),
  };
}

// ---------- room layout ----------

const ROOM_W = 260;
const SLOT_W = 46;
const SLOT_H = 46;
const TEAM_Y = 42;

// Where everybody sits. Seats carry the overlay positions (tag and speech bubble) too.
function roomLayout(agents, style = roomStyle(0)) {
  const pm = agents.find((a) => a.id === "pm");
  const team = agents.filter((a) => a !== pm);
  const pmX = style.pmSide === "right" ? 194 : 2;
  const teamX = style.pmSide === "right" ? 6 : 72;
  const seats = [];
  let bottom = TEAM_Y + 40;

  if (style.layout === "pods") {
    // Pods of four: two face the viewer, two sit opposite with their backs to the viewer.
    team.forEach((agent, i) => {
      const pod = Math.floor(i / 4);
      const k = i % 4;
      const px = teamX + (pod % 2) * 92 + (k % 2) * 44;
      const py = TEAM_Y + 12 + Math.floor(pod / 2) * 96;
      if (k < 2) seats.push({ agent, x: px, y: py, w: 44, h: 34, facing: "down", tagY: py - 17, sayY: py - 18 });
      else seats.push({ agent, x: px, y: py + 34, w: 44, h: 34, facing: "up", tagY: py + 66, sayY: py + 30 });
      bottom = Math.max(bottom, py + 74);
    });
  } else {
    const gapY = style.layout === "bench" ? 50 : SLOT_H;
    team.forEach((agent, i) => {
      const x = teamX + (i % 4) * SLOT_W;
      const y = TEAM_Y + Math.floor(i / 4) * gapY;
      seats.push({ agent, x, y, w: 44, h: 40, facing: "down", tagY: y + 38, sayY: y - 6 });
      bottom = Math.max(bottom, y + 46);
    });
  }
  if (pm) seats.unshift({ agent: pm, x: pmX, y: 42, w: 62, h: 40, facing: "down", wide: true, tagY: 80, sayY: 36 });
  const height = Math.max(160, bottom + 30);
  return { width: ROOM_W, height, seats, pmX, teamX };
}

function floorSvg(kind, W, H) {
  let s = rect(0, 0, W, H, PX.floor);
  if (kind === "planks") {
    for (let y = 30, row = 0; y < H; y += 8, row++) {
      s += rect(0, y, W, 1, PX.floorLine);
      for (let x = (row % 3) * 18; x < W; x += 54) s += rect(x, y, 1, 8, PX.floorLine);
    }
  } else if (kind === "carpet") {
    for (let y = 33; y < H; y += 6) for (let x = (y % 12) ? 3 : 0; x < W; x += 6) s += rect(x, y, 1, 1, PX.floorLine);
  } else if (kind === "checker") {
    for (let y = 30, r = 0; y < H; y += 16, r++) for (let x = (r % 2) * 16; x < W; x += 32) s += rect(x, y, 16, 16, PX.floorAlt);
  } else {
    for (let x = 0; x < W; x += 12) s += rect(x, 30, 1, H - 30, PX.floorLine);
    for (let y = 30; y < H; y += 12) s += rect(0, y, W, 1, PX.floorLine);
  }
  return s;
}

const WALL_ITEMS = {
  whiteboard: { w: 34, draw: (x) => whiteboard(x, 5) },
  posters: { w: 30, draw: (x) => posters(x, 6) },
  screen: { w: 40, draw: (x) => wallScreen(x, 4) },
  map: { w: 32, draw: (x) => worldMap(x, 5) },
  banner: { w: 38, draw: (x) => banner(x, 4) },
  neon: { w: 30, draw: (x) => neonSign(x, 8) },
  plantShelf: { w: 32, draw: (x) => plantShelf(x, 6) },
  clock: { w: 9, draw: (x) => clock(x, 8) },
};

const FLOOR_ITEMS = {
  coffee: { w: 18, draw: (x, H) => coffeeMachine(x, H - 16) },
  cooler: { w: 14, draw: (x, H) => waterCooler(x, H - 22) },
  vending: { w: 18, draw: (x, H) => vendingMachine(x, H - 20) },
  aquarium: { w: 28, draw: (x, H) => aquarium(x, H - 20) },
  arcade: { w: 18, draw: (x, H) => arcade(x, H - 20) },
  printer: { w: 20, draw: (x, H) => printer(x, H - 20) },
  beanbags: { w: 26, draw: (x, H) => beanbags(x, H - 13) },
  lamp: { w: 11, draw: (x, H) => floorLamp(x, H - 18) },
  bigPlant: { w: 10, draw: (x, H) => plant(x, H - 18, true) },
};

function roomSvg(agents, seed = 0) {
  const style = roomStyle(seed);
  Object.assign(PX, BASE_PX, style.palette.colors);
  try {
    const layout = roomLayout(agents, style);
    const { width: W, height: H, pmX, teamX } = layout;
    let s = floorSvg(style.palette.floor, W, H);

    // Rugs: manager corner and the lounge.
    s += box(pmX - 2, 36, 66, 56, PX.rug, PX.rugEdge);
    const loungeY = Math.max(98, H - 66);
    s += box(pmX + 2, loungeY, 58, H - loungeY - 8, PX.rug, PX.rugEdge);

    // Back wall: windows and decoration over the team area, a shelf over the manager.
    s += rect(0, 0, W, 30, PX.wall) + rect(0, 26, W, 4, PX.wallDark) + rect(0, 0, W, 3, PX.wallTrim);
    let wx = teamX + 6;
    for (let i = 0; i < style.windows; i++) {
      s += style.roundWindows ? roundWindow(wx, 7) : windowSvg(wx, 6, 34, 17, style.palette.night);
      wx += style.roundWindows ? 22 : 42;
    }
    for (const name of style.wallDecor) {
      const item = WALL_ITEMS[name];
      if (wx + item.w > teamX + 186) continue;
      s += item.draw(wx);
      wx += item.w + 8;
    }
    s += { bookshelf: bookshelf(pmX + 28, 6), trophies: trophyShelf(pmX + 28, 8), plantShelf: plantShelf(pmX + 26, 6) }[style.pmShelf];
    s += cabinet(pmX + 6, 15) + plant(pmX + 19, 16);

    // Lounge under the manager's corner.
    s += lounge(style.lounge, pmX, loungeY);

    // Floor extras along the bottom wall of the team area (the door is in the middle).
    let ex = teamX + 2;
    for (const name of style.extras) {
      const item = FLOOR_ITEMS[name];
      if (ex + item.w > 112 && ex < 148) ex = 150;
      if (ex + item.w > teamX + 188) break;
      s += item.draw(ex, H);
      ex += item.w + 6;
    }

    // Desks and staff. Bench desks join into one long table; cubicles get partitions.
    const deskOpts = { desk: style.desk, chair: style.chair };
    layout.seats.forEach((seat) => {
      if (seat.facing === "up") s += workstationBackSvg(seat.agent, seat.x, seat.y, deskOpts);
      else if (style.layout === "bench" && !seat.wide) s += workstationSvg(seat.agent, seat.x, seat.y, { ...deskOpts, deskX: seat.x - 1, deskW: 48 });
      else s += workstationSvg(seat.agent, seat.x, seat.y, { ...deskOpts, wide: seat.wide });
      if (style.layout === "cubicles" && !seat.wide) {
        s += box(seat.x - 1, seat.y + 14, 3, 22, "#c9d0d6") + box(seat.x + 43, seat.y + 14, 3, 22, "#c9d0d6");
      }
    });

    // Walls and corner posts, with a door gap at the bottom.
    const wallColor = PX.post;
    s += rect(0, 0, 3, H, wallColor) + rect(W - 3, 0, 3, H, wallColor) + rect(0, 0, W, 2, wallColor);
    s += rect(0, H - 3, 116, 3, wallColor) + rect(146, H - 3, W - 146, 3, wallColor);
    s += rect(116, H - 2, 30, 2, PX.woodDark);
    [[0, 0], [W - 5, 0], [0, H - 5], [W - 5, H - 5], [112, H - 5], [146, H - 5]].forEach(([x, y]) => {
      s += box(x, y, 5, 5, PX.post, PX.postDark);
    });

    const svg = `<svg class="room-svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">${s}</svg>`;
    return { svg, layout, style };
  } finally {
    Object.assign(PX, BASE_PX);
  }
}

// Empty room drawn for the "new department" tile.
function emptyRoomSvg() {
  const W = ROOM_W;
  const H = 156;
  let s = rect(0, 0, W, H, PX.floor);
  for (let x = 0; x < W; x += 12) s += rect(x, 30, 1, H - 30, PX.floorLine);
  for (let y = 30; y < H; y += 12) s += rect(0, y, W, 1, PX.floorLine);
  s += rect(0, 0, W, 30, PX.wall) + rect(0, 26, W, 4, PX.wallDark) + windowSvg(110, 6, 40, 17);
  s += plant(20, 120, true) + plant(226, 120, true);
  return `<svg class="room-svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">${s}</svg>`;
}
