// Pixel-art renderer for department rooms: floor, walls, furniture and the staff at their desks.
// Everything is drawn as SVG rects in "room pixels"; the SVG viewBox scales the room to any size.
// A room is generated from a seed: layout, furniture models, lounge, decoration and colors all come from it,
// so every department looks different and "randomize" simply picks a new seed.
// Character state is a CSS class on each workstation group (st-working, st-idle, st-waiting, ...),
// so animations live in CSS and the DOM can be updated without rebuilding the room.
// Furniture that moves (fish, screens, steam, the office cat) carries an "amb-*" class; CSS animates it too.

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

function group(cls, inner, attrs = "") {
  return `<g class="${cls}"${attrs ? " " + attrs : ""}>${inner}</g>`;
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

// Stable small number from a string, used to give each person their own habits.
function hashOf(text) {
  return [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

// Outlined sprite from a list of [x, y] pixels.
function glyph(list, x, y, color) {
  return pixelsToRects(withOutline(new Map(list.map(([px, py]) => [`${px},${py}`, color]))), x, y);
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

const HEADWEAR_COLORS = {
  cap: "#d9534f", beanie: "#5a8be0", headband: "#e05a5a", bow: "#e8738a", bandana: "#c0392b", beret: "#b5485d", flower: "#ff8fb1",
};

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
    case "vest": {
      const vest = shade(shirt, -60);
      if (back) fill(p, 2, 12, 11, 14, vest);
      else { fill(p, 2, 12, 4, 14, vest); fill(p, 9, 12, 11, 14, vest); dots(p, [[4, 11], [9, 11]], vest); }
      break;
    }
    case "jersey":
      dots(p, [[1, 12], [12, 12]], PX.paper);
      fill(p, 5, 12, 8, back ? 13 : 14, PX.paper);
      if (!back) dots(p, [[6, 13], [7, 13]], dark);
      break;
    case "cardigan": {
      const knit = shade(shirt, -38);
      fill(p, 2, 11, 4, 14, knit);
      fill(p, 9, 11, 11, 14, knit);
      if (back) fill(p, 5, 11, 8, 14, knit);
      else { fill(p, 5, 12, 8, 14, PX.paper); dots(p, [[5, 13], [5, 14]], "#f5c242"); }
      break;
    }
    case "turtleneck":
      fill(p, back ? 4 : 5, 11, back ? 9 : 8, 11, shade(shirt, 30));
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
  if (style === "wavy") {
    fill(p, 1, 4, 2, 12, hair); fill(p, 11, 4, 12, 12, hair);
    dots(p, [[0, 6], [13, 6], [0, 9], [13, 9], [0, 12], [13, 12]], hair);
  }
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
  if (style === "undercut") {
    fill(p, 3, 1, 10, 3, hair);
    dots(p, [[2, 3], [11, 3], [2, 4], [11, 4]], shade(skin, -24));
    return;
  }
  if (style === "quiff") { fill(p, 4, 0, 9, 1, hair); p.set("10,1", hair); }
  if (style === "bun") fill(p, 5, 0, 8, 1, hair);
  if (style === "spiky") [3, 5, 8, 10].forEach((x) => p.set(`${x},1`, hair));
  if (style === "curly") { [3, 5, 7, 9].forEach((x) => p.set(`${x},1`, hair)); }
  fill(p, 3, 2, 10, 2, hair);
  fill(p, 2, 3, 11, 3, hair);
  if (style === "short" || style === "spiky") { fill(p, 2, 4, 5, 4, hair); p.set("2,5", hair); p.set("11,4", hair); p.set("11,5", hair); }
  if (style === "curly") { dots(p, [[2, 4], [4, 4], [9, 4], [11, 4], [2, 5], [11, 5]], hair); }
  if (style === "bun" || style === "ponytail" || style === "twintails") { fill(p, 2, 4, 4, 4, hair); fill(p, 10, 4, 11, 4, hair); }
  if (style === "long" || style === "wavy") { fill(p, 2, 4, 4, 4, hair); fill(p, 9, 4, 11, 4, hair); }
  if (style === "quiff") dots(p, [[2, 4], [11, 4]], hair);
  if (style === "pixie") { fill(p, 2, 4, 9, 4, hair); dots(p, [[2, 5], [2, 6], [11, 4], [11, 5]], hair); }
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
  if (headwear === "beret") { fill(p, 4, 1, 10, 1, c); fill(p, 2, 2, 12, 3, c); p.set("9,0", shade(c, -35)); }
  if (headwear === "flower") { dots(p, [[10, 1], [9, 2], [11, 2], [10, 3]], c); p.set("10,2", "#ffe08a"); }
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
  const covered = !["bald", "buzz", "mohawk", "undercut"].includes(style);
  if (style === "undercut") { fill(p, 3, 1, 10, 4, hair); fill(p, 2, 5, 11, 7, shade(skin, -24)); }
  if (style === "wavy") { fill(p, 1, 4, 12, 12, hair); dots(p, [[0, 6], [13, 6], [0, 9], [13, 9], [0, 12], [13, 12]], hair); }
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
  // An open mouth that flaps while the character talks.
  const talk = new Map();
  fill(talk, 6, 9, 7, 10, "#7a3b3b");
  return `<g class="body">${pixelsToRects(pixels, ox, oy)}
    <g class="lids">${pixelsToRects(lids, ox, oy)}</g>
    <g class="talk-mouth">${pixelsToRects(talk, ox, oy)}</g>
    <g class="arm-up">${pixelsToRects(withOutline(arm), ox, oy)}</g></g>`;
}

// A standing character with legs, used when somebody leaves the desk and walks through the room.
// The two leg groups alternate in CSS while the sprite moves.
function walkerSvg(agent) {
  const pants = agent.role === "leader" || (agent.look || {}).outfit === "suit" ? "#3b3f52" : "#4a5670";
  const legs = (left, right) => {
    const p = new Map();
    fill(p, 3, 15, 6, 14 + left, pants);
    fill(p, 7, 15, 10, 14 + right, pants);
    fill(p, 3, 15 + left, 6, 15 + left, "#2a2433");
    fill(p, 7, 15 + right, 10, 15 + right, "#2a2433");
    return pixelsToRects(withOutline(p));
  };
  const mug = box(11, 9, 5, 5, PX.paper) + rect(13, 10, 2, 1, "#b07d4f");
  return `<svg class="walker-svg" viewBox="-1 -1 18 22" shape-rendering="crispEdges" aria-hidden="true">
    <g class="leg-s">${legs(3, 3)}</g><g class="leg-a">${legs(3, 2)}</g><g class="leg-b">${legs(2, 3)}</g>
    <g class="walker-body">${pixelsToRects(withOutline(characterPixels(agent)))}</g>
    <g class="walker-mug">${mug}</g></svg>`;
}

// Small sprites that fly between desks: a task on its way to somebody, or a finished report coming back.
function noteSvg(kind) {
  const inner = kind === "report"
    ? box(0, 0, 9, 11, PX.paper) + rect(2, 2, 5, 1, PX.metal) + rect(2, 4, 4, 1, PX.metal) +
      rect(2, 7, 1, 1, "#22744c") + rect(3, 8, 1, 1, "#22744c") + rect(4, 7, 1, 1, "#22744c") + rect(5, 6, 1, 1, "#22744c") + rect(6, 5, 1, 1, "#22744c")
    : box(0, 1, 11, 8, "#fff3a6") + rect(1, 2, 1, 1, PX.outline) + rect(2, 3, 1, 1, PX.outline) + rect(3, 4, 1, 1, PX.outline) +
      rect(4, 5, 3, 1, PX.outline) + rect(7, 4, 1, 1, PX.outline) + rect(8, 3, 1, 1, PX.outline) + rect(9, 2, 1, 1, PX.outline);
  return `<svg viewBox="0 0 11 11" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
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

// The sky in the windows follows the time of day: "day", "sunset" or "night".
function skyPhase(date = new Date()) {
  const h = date.getHours();
  if (h >= 6 && h < 17) return "day";
  if (h >= 17 && h < 19) return "sunset";
  return "night";
}

function windowSvg(x, y, w, h, sky = "day") {
  const bar = rect(x + Math.floor(w / 2) - 1, y + 1, 2, h - 2, PX.frame);
  if (sky === "night") {
    return box(x, y, w, h, PX.frame) + rect(x + 2, y + 2, w - 4, h - 4, "#1d2547") +
      rect(x + 6, y + 5, 1, 1, "#ffffff", "amb-star") + rect(x + w - 9, y + 8, 1, 1, "#ffffff", "amb-star s2") +
      rect(x + 12, y + 10, 1, 1, "#fff3a6", "amb-star s3") + rect(x + w - 12, y + 4, 3, 3, "#fff3a6") +
      rect(x + w - 11, y + 4, 2, 2, "#1d2547") + bar + rect(x + 3, y + h - 5, w - 6, 2, "#2b3a4f");
  }
  if (sky === "sunset") {
    return box(x, y, w, h, PX.frame) + rect(x + 2, y + 2, w - 4, h - 4, "#ffb37a") + rect(x + 2, y + 2, w - 4, 4, "#f58f6c") +
      rect(x + 2, y + 6, w - 4, 2, "#fba36f") + rect(x + w - 12, y + h - 10, 5, 5, "#ffe08a") + bar +
      rect(x + 3, y + h - 6, w - 6, 3, "#7d8f5a");
  }
  const cloud = group("amb-cloud", rect(x + 4, y + 5, 7, 2, "#ffffff") + rect(x + 6, y + 4, 3, 1, "#ffffff"), `style="--drift:${w - 16}px"`);
  return box(x, y, w, h, PX.frame) + rect(x + 2, y + 2, w - 4, h - 4, PX.glass) +
    rect(x + 2, y + 2, w - 4, 3, PX.glassLight) + cloud + bar + rect(x + 3, y + h - 6, w - 6, 3, "#9fcf8a");
}

function roundWindow(x, y, sky = "day") {
  const glass = { day: PX.glass, sunset: "#ffb37a", night: "#1d2547" }[sky];
  const p = new Map();
  fill(p, 3, 0, 10, 0, PX.frame); fill(p, 1, 1, 12, 1, PX.frame); fill(p, 0, 2, 13, 11, PX.frame);
  fill(p, 1, 12, 12, 12, PX.frame); fill(p, 3, 13, 10, 13, PX.frame);
  fill(p, 3, 2, 10, 11, glass); fill(p, 2, 3, 11, 10, glass);
  if (sky === "day") fill(p, 3, 3, 6, 4, PX.glassLight);
  if (sky === "sunset") fill(p, 7, 7, 9, 9, "#ffe08a");
  let s = pixelsToRects(withOutline(p), x, y);
  if (sky === "night") s += rect(x + 4, y + 4, 1, 1, "#ffffff", "amb-star") + rect(x + 9, y + 8, 1, 1, "#fff3a6", "amb-star s2");
  return s;
}

function whiteboard(x, y) {
  return box(x, y, 34, 18, "#fbfdff") + rect(x + 3, y + 4, 14, 1, "#e05a5a") + rect(x + 3, y + 7, 20, 1, "#5a8be0") +
    rect(x + 3, y + 10, 10, 1, "#5cc28f") + rect(x + 20, y + 9, 9, 6, "#ffe9a8") + rect(x + 1, y + 17, 32, 2, PX.metalDark);
}

function clock(x, y) {
  return box(x, y, 9, 9, "#fbfdff") + rect(x + 4, y + 4, 3, 1, PX.outline) +
    `<rect class="amb-hand" x="${x + 4}" y="${y + 2}" width="1" height="3" fill="#c0392b" style="transform-origin:${x + 4.5}px ${y + 4.5}px"/>`;
}

function posters(x, y) {
  return box(x, y, 14, 17, PX.frame) + rect(x + 2, y + 2, 10, 13, "#f5c242") + rect(x + 4, y + 5, 6, 6, "#e05a5a") +
    box(x + 17, y + 2, 13, 15, PX.frame) + rect(x + 19, y + 4, 9, 11, "#6fa3ef") + rect(x + 21, y + 9, 5, 4, PX.paper);
}

function wallScreen(x, y) {
  return box(x, y, 40, 19, "#1f2633") + rect(x + 3, y + 3, 14, 2, "#5cc28f", "amb-blink slow") + rect(x + 3, y + 7, 22, 1, "#6fa3ef") +
    rect(x + 3, y + 10, 18, 1, "#6fa3ef") + rect(x + 3, y + 13, 9, 1, "#6fa3ef", "amb-blink") + rect(x + 26, y + 4, 10, 10, "#2d3a4f") +
    rect(x + 27, y + 9, 2, 4, "#f5c242", "amb-bar") + rect(x + 30, y + 6, 2, 7, "#5cc28f", "amb-bar b2") +
    rect(x + 33, y + 8, 2, 5, "#e8738a", "amb-bar b3") + rect(x + 18, y + 19, 4, 3, PX.metalDark);
}

// Team kanban board with sticky notes; one note wiggles as if it was just moved.
function kanbanBoard(x, y) {
  let s = box(x, y, 36, 18, "#fbfdff") + rect(x + 12, y + 1, 1, 16, "#d7dbdf") + rect(x + 24, y + 1, 1, 16, "#d7dbdf");
  [[2, 3, "#f5c242"], [2, 8, "#e8738a"], [7, 5, "#6fa3ef"], [14, 3, "#5cc28f"], [18, 9, "#f5c242"], [26, 3, "#a98ae6"], [30, 8, "#5cc28f"], [26, 12, "#ee9a48"]]
    .forEach(([dx, dy, c], i) => { s += rect(x + dx, y + dy, 4, 4, c, i === 4 ? "amb-wiggle" : ""); });
  return s;
}

function pictureFrames(x, y) {
  return box(x, y + 2, 11, 13, PX.woodFront) + rect(x + 2, y + 4, 7, 9, "#bfe3f2") + rect(x + 2, y + 10, 7, 3, "#7cc35a") + rect(x + 6, y + 6, 2, 2, "#fff3a6") +
    box(x + 13, y, 9, 9, PX.frame) + rect(x + 15, y + 2, 5, 5, "#f2a65a") + rect(x + 16, y + 3, 3, 3, "#e05a5a") +
    box(x + 13, y + 11, 9, 7, PX.woodDark) + rect(x + 15, y + 13, 5, 3, "#a98ae6") +
    box(x + 24, y + 3, 10, 12, PX.frame) + rect(x + 26, y + 5, 6, 8, "#ffd0d9") + rect(x + 28, y + 7, 2, 4, "#c2405a");
}

function wallCalendar(x, y) {
  let s = box(x, y, 16, 17, PX.paper) + rect(x + 1, y + 1, 14, 4, "#e05a5a") + rect(x + 4, y - 1, 1, 3, PX.metalDark) + rect(x + 11, y - 1, 1, 3, PX.metalDark);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) s += rect(x + 2 + c * 3, y + 7 + r * 3, 2, 2, r === 1 && c === 2 ? "#e05a5a" : "#c9d0d6");
  return s;
}

// Air conditioner with drifting air.
function airConditioner(x, y) {
  return box(x, y, 28, 9, "#f4f4f1") + rect(x + 2, y + 6, 24, 1, "#aab2bb") + rect(x + 23, y + 2, 2, 1, "#5cc28f", "amb-blink slow") +
    group("amb-air", rect(x + 5, y + 10, 4, 1, "#dff4fc") + rect(x + 13, y + 11, 5, 1, "#dff4fc") + rect(x + 21, y + 10, 3, 1, "#dff4fc"));
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
  return box(x, y, 30, 12, "#2a2433") +
    group("amb-flicker", rect(x + 4, y + 3, 2, 6, "#ff6fb5") + rect(x + 6, y + 3, 4, 2, "#ff6fb5")) +
    rect(x + 12, y + 3, 2, 6, "#6ff2ff") + rect(x + 14, y + 7, 4, 2, "#6ff2ff") +
    group("amb-blink slow", rect(x + 20, y + 3, 6, 2, "#fff36f") + rect(x + 22, y + 5, 2, 4, "#fff36f"));
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
    rect(x + 5, y - 4, 6, 2, "#e05a5a") + rect(x + 6, y + 1, 4, 3, PX.paper) +
    group("amb-steam", rect(x + 7, y - 2, 1, 2, "#ffffff") + rect(x + 9, y - 3, 1, 2, "#ffffff"));
}

function vendingMachine(x, y) {
  let s = box(x, y - 8, 16, 24, "#d9534f") + rect(x + 2, y - 6, 9, 16, "#2a2433");
  ["#f5c242", "#5cc28f", "#6fa3ef", "#ffffff"].forEach((c, i) => { s += rect(x + 3, y - 5 + i * 4, 3, 2, c) + rect(x + 7, y - 5 + i * 4, 3, 2, c); });
  return s + rect(x + 12, y - 4, 2, 6, PX.paper) + rect(x + 12, y + 4, 2, 1, "#5cc28f", "amb-blink") + rect(x + 2, y + 12, 9, 2, "#2a2433");
}

function aquarium(x, y) {
  return box(x, y + 10, 26, 6, PX.woodFront) + box(x + 1, y - 4, 24, 15, "#7fd0ef") + rect(x + 2, y - 3, 22, 2, "#b9ecfb") +
    rect(x + 3, y + 6, 1, 4, "#3d7a36") + rect(x + 21, y + 4, 1, 6, "#3d7a36") + rect(x + 12, y + 7, 1, 3, "#3d7a36") +
    group("amb-fish", rect(x + 4, y + 1, 4, 2, "#ff8c42") + rect(x + 3, y + 1, 1, 2, "#e0662a") + rect(x + 7, y + 1, 1, 1, PX.outline)) +
    group("amb-fish f2", rect(x + 17, y + 5, 3, 2, "#f5c242") + rect(x + 20, y + 5, 1, 2, "#d9a441") + rect(x + 17, y + 5, 1, 1, PX.outline)) +
    rect(x + 9, y + 6, 1, 1, "#dff4fc", "amb-bubble") + rect(x + 15, y + 4, 1, 1, "#dff4fc", "amb-bubble b2");
}

function arcade(x, y) {
  return box(x, y - 10, 16, 26, "#6a4aa6") + box(x + 2, y - 7, 12, 9, "#1f2633") + rect(x + 4, y - 5, 3, 2, "#5cc28f", "amb-blink") +
    rect(x + 9, y - 3, 3, 2, "#ff6fb5", "amb-blink slow") + rect(x + 6, y - 1, 2, 1, "#fff36f", "amb-flicker") +
    rect(x + 2, y + 4, 12, 3, "#2a2433") + rect(x + 4, y + 4, 2, 2, "#e05a5a") + rect(x + 10, y + 5, 2, 1, "#f5c242");
}

function printer(x, y) {
  return rect(x + 4, y - 3, 10, 3, PX.paper, "amb-paper") + box(x, y + 4, 18, 12, PX.metalDark) + box(x + 2, y, 14, 6, "#cfd6de") +
    rect(x + 3, y + 8, 4, 1, "#5cc28f", "amb-blink slow");
}

// Server rack with busy status lights.
function serverRack(x, y) {
  let s = box(x, y - 10, 14, 26, "#2a2f3a");
  for (let i = 0; i < 5; i++) {
    s += rect(x + 2, y - 8 + i * 5, 10, 3, "#3d4452") + rect(x + 3, y - 7 + i * 5, 1, 1, "#5cc28f", `amb-blink${i % 2 ? " slow" : ""}`) +
      rect(x + 5, y - 7 + i * 5, 1, 1, i === 3 ? "#f5c242" : "#6fa3ef", i % 3 ? "amb-flicker" : "amb-blink");
  }
  return s;
}

// The office cat asleep on a cushion: the tail flicks and the ears twitch now and then.
function officeCat(x, y, color = "#e8a25c") {
  const dark = shade(color, -45);
  const p = new Map();
  fill(p, 2, 3, 11, 7, color); fill(p, 1, 4, 1, 6, color); fill(p, 3, 2, 6, 2, color);
  dots(p, [[2, 1], [5, 1]], color);
  dots(p, [[3, 4], [5, 4]], PX.outline);
  dots(p, [[8, 3], [10, 3], [8, 5], [10, 5]], dark);
  p.set("4,5", "#f4a3a3");
  const tail = new Map();
  fill(tail, 12, 5, 13, 6, color); fill(tail, 13, 3, 14, 4, dark);
  return box(x - 1, y + 6, 18, 5, "#c27ac9") + rect(x, y + 7, 16, 1, shade("#c27ac9", 30)) +
    pixelsToRects(withOutline(p), x, y) + group("amb-tail", pixelsToRects(withOutline(tail), x, y)) +
    group("amb-zzz", glyph([[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]], x + 2, y - 7, "#ffffff"));
}

function recyclingBins(x, y) {
  const bin = (bx, c) => box(bx, y + 3, 8, 12, c) + box(bx - 1, y + 1, 10, 3, shade(c, -30)) + rect(bx + 3, y + 7, 2, 4, PX.paper);
  return bin(x + 1, "#5a8be0") + bin(x + 12, "#5cc28f");
}

function coatRack(x, y) {
  return rect(x + 5, y - 10, 1, 25, PX.woodDark) + box(x + 2, y + 14, 7, 3, PX.woodDark) + rect(x + 2, y - 9, 7, 1, PX.woodDark) +
    box(x, y - 8, 5, 10, "#e8738a") + box(x + 6, y - 7, 5, 8, "#5a6c96");
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
  return rect(x - 2, y - 11, 13, 10, "#fff3a6", "amb-lamp") + rect(x + 4, y - 4, 1, 16, PX.metalDark) +
    box(x, y - 9, 9, 6, "#fff3a6") + box(x + 1, y + 12, 7, 3, PX.metalDark);
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
      rect(x + 6, y + 5, 1, 1, "#22744c") + rect(x + 7, y + 4, 1, 1, "#22744c") + rect(x + 8, y + 3, 1, 1, "#22744c"), "#2f8a5b", "#d8f5e5")}</g>
    <g class="icon icon-bulb">${bubble(rect(x + 5, y + 2, 3, 3, "#f5a623") + rect(x + 4, y + 3, 5, 1, "#f5a623") +
      rect(x + 6, y + 5, 1, 2, PX.metalDark), "#a77b00", "#fff8d6")}</g>
    <g class="icon icon-queue">${bubble(rect(x + 4, y + 2, 5, 1, "#8a5a2b") + rect(x + 4, y + 7, 5, 1, "#8a5a2b") +
      rect(x + 5, y + 3, 3, 1, "#f5c242") + rect(x + 6, y + 4, 1, 1, "#f5c242") +
      `<rect class="sand" x="${x + 6}" y="${y + 5}" width="1" height="1" fill="#f5c242"/>` + rect(x + 5, y + 6, 3, 1, "#f5c242"), "#a77b00", "#fff2c2")}</g>
    <g class="icon icon-zzz">${group("z1", glyph([[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]], x + 1, y + 5, "#ffffff"))}
      ${group("z2", glyph([[0, 0], [1, 0], [2, 0], [3, 0], [2, 1], [1, 2], [0, 3], [1, 3], [2, 3], [3, 3]], x + 6, y - 1, "#ffffff"))}</g>
    <g class="icon icon-note">${group("n1", glyph([[2, 0], [3, 0], [2, 1], [2, 2], [2, 3], [0, 3], [1, 3], [0, 4], [1, 4]], x + 1, y + 3, "#ff6fb5"))}
      ${group("n2", glyph([[2, 0], [3, 1], [2, 1], [2, 2], [2, 3], [0, 3], [1, 3], [0, 4], [1, 4]], x + 8, y, "#6fa3ef"))}</g>
    <g class="icon icon-sweat">${glyph([[1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2], [1, 3]], x - 15, y + 8, "#7fd0ef")}</g>
    <g class="icon icon-confetti">${[["#e05a5a", -14, 2], ["#f5c242", -9, -3], ["#5cc28f", -3, 1], ["#6fa3ef", 3, -4], ["#a98ae6", 9, 0], ["#ff6fb5", 14, -2]]
      .map(([c, dx, dy], i) => rect(x + dx, y + dy, 2, 2, c, `c${i % 3}`)).join("")}</g>`;
}

// A desk with its chair, the agent, a laptop and a role prop, facing the viewer. Slot: 44 x 40 (wide: 62 x 40).
function workstationSvg(agent, x, y, { wide = false, desk = "wood", chair = "office", deskX, deskW } = {}) {
  const w = wide ? 58 : 40;
  const dx = deskX ?? x + 2;
  const dw = deskW ?? w;
  const cx = x + 2 + Math.floor(w / 2) - 7; // character left edge
  const deskY = y + 22;
  const skin = (agent.look && agent.look.skin) || "#ffe0c7";
  // data-idle picks what this person does when there is no work (coffee, a nap, music, the phone).
  return `
  <g class="ws st-idle" data-agent="${escAttr(agent.id)}" data-idle="${hashOf(agent.id) % 4}">
    ${rect(dx + 2, deskY + 12, dw - 4, 2, "rgba(90,60,30,.18)")}
    ${chairBackSvg(cx, y, chair)}
    ${characterSvg(agent, cx, y + 6)}
    <rect class="glow" x="${cx + 2}" y="${y + 9}" width="10" height="7" fill="#9fe7ff"/>
    <g class="phone">${box(cx + 5, y + 16, 4, 6, "#2a2433")}${rect(cx + 6, y + 17, 2, 3, "#9fe7ff")}</g>
    ${deskSvg(dx, deskY, dw, desk)}
    <g class="laptop">${box(cx + 2, deskY - 3, 10, 5, PX.metal)}${rect(cx + 6, deskY - 2, 2, 2, PX.frame)}</g>
    <g class="sparks">${rect(cx + 3, deskY - 5, 1, 1, "#5cc28f", "k0")}${rect(cx + 7, deskY - 6, 1, 1, "#6fa3ef", "k1")}${rect(cx + 10, deskY - 5, 1, 1, "#f5c242", "k2")}</g>
    <g class="hands">${rect(cx, deskY + 1, 2, 1, skin)}${rect(cx + 12, deskY + 1, 2, 1, skin)}</g>
    <g class="mug">${box(x + w - 7, deskY - 3, 5, 5, PX.paper)}${rect(x + w - 2, deskY - 2, 1, 2, PX.outline)}
      <g class="steam">${rect(x + w - 6, deskY - 6, 1, 2, "#ffffff")}${rect(x + w - 4, deskY - 8, 1, 2, "#ffffff")}</g></g>
    <g class="prop">${deskProp(agent.role, x + 4, deskY - 8)}</g>
    <g class="movebox">${box(x + 3, deskY - 9, 10, 10, "#c9955c")}${rect(x + 4, deskY - 5, 8, 1, "#a8743d")}${rect(x + 7, deskY - 8, 2, 8, "#e8d3a8")}</g>
    ${wide ? deskProp("sa", x + 15, deskY - 8) : ""}
    ${statusIcons(cx + 9, y - 6)}
  </g>`;
}

// The same, but the agent sits with the back to the viewer: desk first, then the agent, then the chair.
function workstationBackSvg(agent, x, y, { desk = "wood", chair = "office" } = {}) {
  const w = 40;
  const cx = x + 2 + Math.floor(w / 2) - 7;
  return `
  <g class="ws st-idle back" data-agent="${escAttr(agent.id)}" data-idle="${hashOf(agent.id) % 4}">
    ${deskSvg(x + 2, y, w, desk)}
    ${box(cx + 1, y - 4, 12, 7, PX.metalDark)}<rect class="screen" x="${cx + 2}" y="${y - 3}" width="10" height="5" fill="#9fe7ff"/>
    <g class="code">${rect(cx + 3, y - 2, 5, 1, "#2b5ea7", "k0")}${rect(cx + 3, y, 7, 1, "#22744c", "k1")}</g>
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

// Kitchen corner: counter with a coffee machine and a sink, a fridge and two stools.
function kitchen(x, y) {
  return box(x, y + 6, 40, 12, PX.wood) + rect(x + 1, y + 13, 38, 4, PX.woodFront) +
    box(x + 3, y - 2, 9, 9, PX.metalDark) + rect(x + 5, y, 5, 2, "#e05a5a") + rect(x + 6, y + 4, 3, 2, PX.paper) +
    group("amb-steam", rect(x + 6, y - 4, 1, 2, "#ffffff") + rect(x + 9, y - 5, 1, 2, "#ffffff")) +
    box(x + 17, y + 7, 10, 5, "#cfd6de") + rect(x + 21, y + 4, 1, 4, PX.metalDark) + rect(x + 21, y + 4, 3, 1, PX.metalDark) +
    box(x + 30, y + 3, 5, 4, "#f2a65a") + rect(x + 31, y + 2, 2, 1, "#5aa04a") +
    box(x + 42, y - 6, 14, 26, "#e9eef2") + rect(x + 43, y + 4, 12, 1, "#aab2bb") + rect(x + 53, y - 2, 1, 4, PX.metalDark) + rect(x + 53, y + 7, 1, 5, PX.metalDark) +
    box(x + 6, y + 24, 9, 5, PX.chair) + rect(x + 10, y + 29, 1, 4, PX.metalDark) +
    box(x + 24, y + 24, 9, 5, PX.chair) + rect(x + 28, y + 29, 1, 4, PX.metalDark);
}

// Reading corner: bookshelves, an armchair and a reading lamp.
function libraryCorner(x, y) {
  const seat = PX.accent;
  return bookshelf(x, y - 4) + bookshelf(x + 28, y - 4).replace(/#e05a5a/g, "#6fa3ef") +
    box(x + 4, y + 24, 20, 14, seat) + rect(x + 5, y + 25, 18, 3, shade(seat, 25)) + box(x + 2, y + 28, 4, 10, shade(seat, -25)) + box(x + 22, y + 28, 4, 10, shade(seat, -25)) +
    box(x + 32, y + 30, 10, 6, PX.wood) + rect(x + 34, y + 28, 5, 2, "#e05a5a") + rect(x + 35, y + 26, 4, 2, "#5a8be0") +
    floorLamp(x + 46, y + 22);
}

// Indoor garden: plants, a small pond and a bench.
function gardenCorner(x, y) {
  return box(x + 14, y + 2, 28, 14, "#7fd0ef", "#5d6470") + rect(x + 16, y + 4, 10, 2, "#b9ecfb") +
    group("amb-fish", rect(x + 19, y + 9, 3, 2, "#ff8c42") + rect(x + 18, y + 9, 1, 2, "#e0662a")) +
    rect(x + 33, y + 6, 3, 2, "#5aa04a") + rect(x + 35, y + 5, 2, 1, "#ff8fb1") +
    plant(x + 1, y - 2, true) + plant(x + 46, y - 4, true) + cactus(x + 4, y + 22) +
    box(x + 16, y + 26, 28, 6, PX.wood) + rect(x + 18, y + 32, 2, 4, PX.woodDark) + rect(x + 40, y + 32, 2, 4, PX.woodDark) +
    plant(x + 48, y + 26);
}

function lounge(kind, x, y) {
  if (kind === "sofa") return sofaCorner(x + 8, y + 6);
  if (kind === "pingpong") return pingPong(x + 10, y + 14);
  if (kind === "round") return roundTable(x + 8, y + 12);
  if (kind === "kitchen") return kitchen(x + 3, y + 10);
  if (kind === "library") return libraryCorner(x + 3, y + 8);
  if (kind === "garden") return gardenCorner(x + 3, y + 8);
  return meetingTable(x + 12, y + 14);
}

// Where people stand when they visit the lounge (offsets from the lounge corner) and what they do there.
const LOUNGE_SPOTS = {
  meeting: [{ dx: 0, dy: 10, emote: "💬" }, { dx: 46, dy: 10, emote: "💬" }],
  sofa: [{ dx: 0, dy: 14, emote: "📺" }, { dx: 47, dy: 14, emote: "🍿" }],
  pingpong: [{ dx: 0, dy: 12, emote: "🏓" }, { dx: 47, dy: 12, emote: "🏓" }],
  round: [{ dx: 1, dy: 0, emote: "💬" }, { dx: 45, dy: 0, emote: "☕" }],
  kitchen: [{ dx: 8, dy: 18, emote: "☕", mug: true }, { dx: 30, dy: 18, emote: "🍪" }],
  library: [{ dx: 26, dy: 22, emote: "📖" }],
  garden: [{ dx: 20, dy: 16, emote: "🌿" }, { dx: 40, dy: 14, emote: "🐟" }],
};

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

const LAYOUTS = ["rows", "cubicles", "pods", "bench", "stagger", "duo"];
const LOUNGES = ["meeting", "sofa", "pingpong", "round", "kitchen", "library", "garden"];
const DESKS = ["wood", "white", "dark"];
const CHAIRS = ["office", "gaming", "stool"];
const WALL_DECOR = ["whiteboard", "posters", "screen", "map", "banner", "neon", "plantShelf", "clock", "kanban", "frames", "calendar", "aircon"];
const FLOOR_EXTRAS = ["coffee", "cooler", "vending", "aquarium", "arcade", "printer", "beanbags", "lamp", "bigPlant", "servers", "cat", "bins", "coats"];
const PM_SHELVES = ["bookshelf", "trophies", "plantShelf"];
const CAT_COLORS = ["#e8a25c", "#5d6470", "#f4f4f1", "#3a2f3f"];

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
    extras: pickMany(rnd, FLOOR_EXTRAS, 4),
    pmShelf: pickFrom(rnd, PM_SHELVES),
    teamRug: rnd() < 0.4,
    catColor: pickFrom(rnd, CAT_COLORS),
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

  // A desk facing the viewer. aisleY is where its owner stands after getting up.
  const front = (agent, x, y, extra = {}) => {
    seats.push({ agent, x, y, w: 44, h: 40, facing: "down", tagY: y + 38, sayY: y - 6, cx: x + 15, aisleY: y + 35, ...extra });
    bottom = Math.max(bottom, y + 46);
  };

  if (style.layout === "pods") {
    // Pods of four: two face the viewer, two sit opposite with their backs to the viewer.
    team.forEach((agent, i) => {
      const pod = Math.floor(i / 4);
      const k = i % 4;
      const px = teamX + (pod % 2) * 92 + (k % 2) * 44;
      const py = TEAM_Y + 12 + Math.floor(pod / 2) * 96;
      if (k < 2) seats.push({ agent, x: px, y: py, w: 44, h: 34, facing: "down", tagY: py - 17, sayY: py - 18, cx: px + 15, aisleY: py - 17 });
      else seats.push({ agent, x: px, y: py + 34, w: 44, h: 34, facing: "up", tagY: py + 66, sayY: py + 30, cx: px + 15, aisleY: py + 62 });
      bottom = Math.max(bottom, py + 74);
    });
  } else if (style.layout === "stagger") {
    // Rows of four and three, shifted like bricks.
    team.forEach((agent, i) => {
      const k = i % 7;
      const row = Math.floor(i / 7) * 2 + (k < 4 ? 0 : 1);
      front(agent, teamX + (k < 4 ? k * SLOT_W : 23 + (k - 4) * SLOT_W), TEAM_Y + row * SLOT_H);
    });
  } else if (style.layout === "duo") {
    // Pairs share one long desk; a plant stands between the pairs.
    team.forEach((agent, i) => {
      const k = i % 4;
      front(agent, teamX + Math.floor(k / 2) * 96 + (k % 2) * 44, TEAM_Y + Math.floor(i / 4) * 50, { pair: k % 2 });
    });
  } else {
    const gapY = style.layout === "bench" ? 50 : SLOT_H;
    team.forEach((agent, i) => front(agent, teamX + (i % 4) * SLOT_W, TEAM_Y + Math.floor(i / 4) * gapY));
  }
  if (pm) seats.unshift({ agent: pm, x: pmX, y: 42, w: 62, h: 40, facing: "down", wide: true, tagY: 80, sayY: 36, cx: pmX + 24, aisleY: 77 });
  const height = Math.max(160, bottom + 30);
  // The free strip between the team area and the manager's column: people walk along it.
  const corridorX = style.pmSide === "right" ? 185 : 59;
  return { width: ROOM_W, height, seats, pmX, teamX, corridorX, spots: [] };
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
  kanban: { w: 36, draw: (x) => kanbanBoard(x, 5) },
  frames: { w: 34, draw: (x) => pictureFrames(x, 5) },
  calendar: { w: 16, draw: (x) => wallCalendar(x, 6) },
  aircon: { w: 28, draw: (x) => airConditioner(x, 5) },
};

// Things along the bottom wall. Items with an emote are places people visit on a break.
const FLOOR_ITEMS = {
  coffee: { w: 18, emote: "☕", mug: true, draw: (x, H) => coffeeMachine(x, H - 16) },
  cooler: { w: 14, emote: "💧", draw: (x, H) => waterCooler(x, H - 22) },
  vending: { w: 18, emote: "🥤", draw: (x, H) => vendingMachine(x, H - 20) },
  aquarium: { w: 28, emote: "🐟", draw: (x, H) => aquarium(x, H - 20) },
  arcade: { w: 18, emote: "🎮", draw: (x, H) => arcade(x, H - 20) },
  printer: { w: 20, emote: "📄", draw: (x, H) => printer(x, H - 20) },
  beanbags: { w: 26, emote: "😌", draw: (x, H) => beanbags(x, H - 13) },
  lamp: { w: 11, draw: (x, H) => floorLamp(x, H - 18) },
  bigPlant: { w: 10, emote: "🌿", draw: (x, H) => plant(x, H - 18, true) },
  servers: { w: 16, emote: "🔧", draw: (x, H) => serverRack(x, H - 20) },
  cat: { w: 20, emote: "🐱", draw: (x, H, style) => officeCat(x + 1, H - 16, style.catColor) },
  bins: { w: 22, draw: (x, H) => recyclingBins(x, H - 19) },
  coats: { w: 12, draw: (x, H) => coatRack(x, H - 21) },
};

function roomSvg(agents, seed = 0, { sky = skyPhase() } = {}) {
  const style = roomStyle(seed);
  Object.assign(PX, BASE_PX, style.palette.colors);
  try {
    const layout = roomLayout(agents, style);
    const { width: W, height: H, pmX, teamX } = layout;
    const windowSky = style.palette.night ? "night" : sky;
    let s = floorSvg(style.palette.floor, W, H);

    // Rugs: manager corner, the lounge and sometimes the team area.
    s += box(pmX - 2, 36, 66, 56, PX.rug, PX.rugEdge);
    const loungeY = Math.max(98, H - 66);
    s += box(pmX + 2, loungeY, 58, H - loungeY - 8, PX.rug, PX.rugEdge);
    const teamSeats = layout.seats.filter((seat) => !seat.wide);
    if (style.teamRug && teamSeats.length) {
      const top = Math.min(...teamSeats.map((seat) => seat.y)) + 10;
      const bottomY = Math.max(...teamSeats.map((seat) => seat.y + seat.h)) + 2;
      s += box(teamX - 2, top, 188, bottomY - top, PX.rug, PX.rugEdge) + rect(teamX, top + 2, 184, 1, PX.rugEdge) + rect(teamX, bottomY - 3, 184, 1, PX.rugEdge);
    }
    // Door mat.
    s += box(119, H - 12, 24, 7, shade(PX.rug, -18), PX.rugEdge);

    // Back wall: windows and decoration over the team area, a shelf over the manager.
    s += rect(0, 0, W, 30, PX.wall) + rect(0, 26, W, 4, PX.wallDark) + rect(0, 0, W, 3, PX.wallTrim);
    let wx = teamX + 6;
    for (let i = 0; i < style.windows; i++) {
      s += style.roundWindows ? roundWindow(wx, 7, windowSky) : windowSvg(wx, 6, 34, 17, windowSky);
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
    (LOUNGE_SPOTS[style.lounge] || []).forEach((spot) => {
      layout.spots.push({ x: pmX + 2 + spot.dx, y: Math.min(loungeY + spot.dy, H - 30), zone: "lounge", emote: spot.emote, mug: spot.mug });
    });

    // Floor extras along the bottom wall of the team area (the door is in the middle).
    let ex = teamX + 2;
    for (const name of style.extras) {
      const item = FLOOR_ITEMS[name];
      if (ex + item.w > 112 && ex < 148) ex = 150;
      if (ex + item.w > teamX + 186) continue;
      s += item.draw(ex, H, style);
      if (item.emote) layout.spots.push({ x: ex + Math.floor(item.w / 2) - 7, y: H - 46, zone: "floor", emote: item.emote, mug: item.mug });
      ex += item.w + 6;
    }
    // Stepping out through the door.
    layout.spots.push({ x: 124, y: H - 24, zone: "door" });

    // Desks and staff. Bench desks join into one long table; cubicles get partitions.
    const deskOpts = { desk: style.desk, chair: style.chair };
    layout.seats.forEach((seat) => {
      if (seat.facing === "up") s += workstationBackSvg(seat.agent, seat.x, seat.y, deskOpts);
      else if (style.layout === "bench" && !seat.wide) s += workstationSvg(seat.agent, seat.x, seat.y, { ...deskOpts, deskX: seat.x - 1, deskW: 48 });
      else if (style.layout === "duo" && !seat.wide) {
        s += workstationSvg(seat.agent, seat.x, seat.y, { ...deskOpts, deskX: seat.pair ? seat.x - 1 : seat.x + 2, deskW: seat.pair ? 43 : 44 });
        if (seat.pair && seat.x + 52 < teamX + 150) s += plant(seat.x + 46, seat.y + 26);
      }
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
  s += rect(0, 0, W, 30, PX.wall) + rect(0, 26, W, 4, PX.wallDark) + windowSvg(110, 6, 40, 17, skyPhase());
  s += plant(20, 120, true) + plant(226, 120, true);
  return `<svg class="room-svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">${s}</svg>`;
}
