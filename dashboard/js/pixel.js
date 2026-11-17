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
  headphones: "#5cc28f", visor: "#f2a65a",
};
const PM_BLAZER = "#2f3a5f";
const PANTS = "#4a5670";

function lookParts(agent) {
  const look = agent.look || {};
  const role = agent.role || "other";
  return {
    look, role,
    skin: look.skin || "#ffe0c7",
    hair: look.hair || "#4a3426",
    hair2: look.hair2 || null,
    shirt: look.shirt || ROLE_SHIRTS[role] || ROLE_SHIRTS.other,
    style: look.hairStyle || "short",
    // Role accessories win over random headwear and eyewear.
    headwear: role === "devops" ? "hardhat" : (look.headwear || "none"),
    eyewear: role === "sa" ? "round" : (look.eyewear || "none"),
    eyes: look.eyes || "tall",
    mouth: look.mouth || "small",
    outfit: role === "leader" && (!look.outfit || look.outfit === "tshirt") ? "suit" : (look.outfit || "tshirt"),
    detail: look.detail || (look.beard ? "beard" : "none"),
    accessory: look.accessory || "none",
    build: look.build || "normal",
  };
}

// The colour of the sleeves, for arms drawn apart from the body.
function sleeveColor(parts) {
  if (parts.role === "pm") return PM_BLAZER;
  return { suit: "#3b3f52", blazer: "#6b7280", labcoat: "#f4f4f1" }[parts.outfit] || parts.shirt;
}

// An open jacket over the shirt (the PM's blazer, or anybody's grey one).
function drawJacket(p, color, back, { tie = null, pin = false } = {}) {
  fill(p, 1, 12, 1, 14, shade(color, -14));
  fill(p, 12, 12, 12, 14, shade(color, -14));
  if (back) { fill(p, 2, 11, 11, 14, color); return; }
  fill(p, 2, 11, 4, 14, color);
  fill(p, 9, 11, 11, 14, color);
  dots(p, [[5, 13], [5, 14], [8, 13], [8, 14]], color);
  if (tie) { dots(p, [[5, 11], [8, 11]], PX.paper); fill(p, 6, 12, 7, 14, tie); }
  if (pin) p.set("3,12", "#f5c242");
}

function drawAccessory(p, parts) {
  switch (parts.accessory) {
    case "tie": fill(p, 6, 12, 7, 13, "#3d6fb0"); break;
    case "bowtie": dots(p, [[5, 12], [8, 12]], "#c0392b"); dots(p, [[6, 12], [7, 12]], "#8a2a20"); break;
    case "necklace": dots(p, [[5, 12], [8, 12], [6, 13], [7, 13]], "#f5c242"); break;
    case "lanyard": dots(p, [[5, 12], [8, 12], [6, 13]], "#5a8be0"); dots(p, [[6, 14], [7, 14], [7, 13]], PX.paper); break;
    case "pin": p.set("9,12", "#ff6fb5"); break;
    default: break;
  }
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
    case "stripes":
      fill(p, 2, 12, 11, 12, PX.paper);
      fill(p, 2, 14, 11, 14, PX.paper);
      dots(p, [[1, 13], [12, 13]], PX.paper);
      break;
    case "plaid": {
      const check = shade(shirt, -45);
      for (let x = 2; x <= 11; x++) for (let y = 12; y <= 14; y++) if ((x + y) % 2 === 0) p.set(`${x},${y}`, check);
      break;
    }
    case "polo": {
      const trim = shade(shirt, 42);
      if (back) fill(p, 4, 11, 9, 11, trim);
      else { dots(p, [[4, 11], [5, 11], [8, 11], [9, 11]], trim); dots(p, [[6, 12], [6, 13]], PX.paper); }
      dots(p, [[1, 14], [12, 14]], trim);
      break;
    }
    case "labcoat": {
      const coat = "#f4f4f1";
      fill(p, 1, 12, 1, 14, "#d7dbdf");
      fill(p, 12, 12, 12, 14, "#d7dbdf");
      if (back) fill(p, 2, 11, 11, 14, coat);
      else { fill(p, 2, 11, 4, 14, coat); fill(p, 9, 11, 11, 14, coat); dots(p, [[10, 12], [10, 13]], "#5a8be0"); }
      break;
    }
    case "blazer":
      drawJacket(p, "#6b7280", back);
      break;
    default:
      break;
  }
  if (role === "leader" && !back) { fill(p, 6, 12, 7, 13, "#c0392b"); dots(p, [[6, 14], [7, 14]], "#c0392b"); }
  // The PM always wears a navy blazer with a gold tie and a pin: the boss is easy to spot.
  if (role === "pm") drawJacket(p, PM_BLAZER, back, { tie: "#d9a441", pin: true });
  else if (!back && role !== "leader") drawAccessory(p, parts);
}

// Hair that hangs behind the head and shoulders (drawn before the head).
// Dyed tips: hair pixels from a row downwards take the second colour.
function tintTips(p, parts, fromRow) {
  if (!parts.hair2) return;
  for (const [key, color] of p) {
    if (color === parts.hair && Number(key.split(",")[1]) >= fromRow) p.set(key, parts.hair2);
  }
}

function drawBackHair(p, parts) {
  const { style, hair } = parts;
  if (style === "long" || style === "hime") { fill(p, 1, 4, 2, 13, hair); fill(p, 11, 4, 12, 13, hair); }
  if (style === "bob") { fill(p, 1, 4, 2, 9, hair); fill(p, 11, 4, 12, 9, hair); }
  if (style === "ponytail") { fill(p, 12, 3, 13, 4, hair); fill(p, 13, 5, 13, 10, hair); }
  if (style === "sidetail") { fill(p, 12, 4, 13, 9, hair); p.set("13,10", hair); }
  if (style === "twintails") { fill(p, 0, 4, 1, 10, hair); fill(p, 12, 4, 13, 10, hair); }
  if (style === "braid") { fill(p, 11, 5, 12, 12, hair); dots(p, [[11, 7], [12, 9], [11, 11]], shade(hair, 30)); }
  if (style === "afro") { fill(p, 0, 2, 1, 8, hair); fill(p, 12, 2, 13, 8, hair); }
  if (style === "wavy") {
    fill(p, 1, 4, 2, 12, hair); fill(p, 11, 4, 12, 12, hair);
    dots(p, [[0, 6], [13, 6], [0, 9], [13, 9], [0, 12], [13, 12]], hair);
  }
  if (style === "dreads") {
    fill(p, 1, 4, 2, 11, hair); fill(p, 11, 4, 12, 11, hair);
    dots(p, [[1, 6], [2, 9], [12, 6], [11, 9]], shade(hair, 35));
  }
  tintTips(p, parts, 9);
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
  if (style === "bun" || style === "topknot") fill(p, style === "bun" ? 5 : 6, 0, style === "bun" ? 8 : 7, 1, hair);
  if (style === "buns") { fill(p, 2, 0, 4, 1, hair); fill(p, 9, 0, 11, 1, hair); }
  if (style === "spiky") [3, 5, 8, 10].forEach((x) => p.set(`${x},1`, hair));
  if (style === "curly") { [3, 5, 7, 9].forEach((x) => p.set(`${x},1`, hair)); }
  if (style === "dreads") fill(p, 3, 1, 10, 1, hair);
  fill(p, 3, 2, 10, 2, hair);
  fill(p, 2, 3, 11, 3, hair);
  if (style === "short" || style === "spiky") { fill(p, 2, 4, 5, 4, hair); p.set("2,5", hair); p.set("11,4", hair); p.set("11,5", hair); }
  if (style === "curly") { dots(p, [[2, 4], [4, 4], [9, 4], [11, 4], [2, 5], [11, 5]], hair); }
  if (["bun", "buns", "ponytail", "twintails"].includes(style)) { fill(p, 2, 4, 4, 4, hair); fill(p, 10, 4, 11, 4, hair); }
  if (style === "long" || style === "wavy") { fill(p, 2, 4, 4, 4, hair); fill(p, 9, 4, 11, 4, hair); }
  if (style === "quiff" || style === "topknot") dots(p, [[2, 4], [11, 4]], hair);
  if (style === "slick") { dots(p, [[2, 4], [11, 4]], hair); dots(p, [[4, 2], [6, 2], [8, 2], [5, 3], [7, 3]], shade(hair, 45)); }
  if (style === "pixie") { fill(p, 2, 4, 9, 4, hair); dots(p, [[2, 5], [2, 6], [11, 4], [11, 5]], hair); }
  if (style === "bob" || style === "hime" || style === "bowl") fill(p, 2, 4, 11, 4, hair);
  if (style === "hime") { fill(p, 2, 5, 2, 8, hair); fill(p, 11, 5, 11, 8, hair); }
  if (style === "bowl") dots(p, [[2, 5], [11, 5]], hair);
  if (style === "dreads") dots(p, [[2, 4], [3, 4], [5, 4], [8, 4], [10, 4], [11, 4]], hair);
  if (style === "side" || style === "braid" || style === "sidetail") { fill(p, 2, 4, 8, 4, hair); fill(p, 2, 5, 3, 5, hair); p.set("11,4", hair); }
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
  if (headwear === "visor") { fill(p, 2, 3, 11, 3, c); if (!back) fill(p, 1, 4, 8, 4, shade(c, -30)); }
  if (headwear === "catears") {
    dots(p, [[2, 0], [2, 1], [3, 1], [11, 0], [11, 1], [10, 1]], parts.hair);
    dots(p, [[2, 1], [11, 1]], "#ff8fb1");
  }
  if (headwear === "bow") { dots(p, [[9, 1], [10, 2], [12, 1], [11, 2], [9, 2], [12, 2]], c); dots(p, [[10, 1], [11, 1]], shade(c, -30)); }
  if (headwear === "headphones") { fill(p, 3, 1, 10, 1, "#3b3b4f"); fill(p, 1, 5, 1, 7, c); fill(p, 12, 5, 12, 7, c); }
  if (role === "dev") { fill(p, 3, 1, 10, 1, "#3b3b4f"); fill(p, 1, 5, 1, 7, "#e05a5a"); fill(p, 12, 5, 12, 7, "#e05a5a"); }
  // The PM is always on a call: a headset with a microphone.
  if (role === "pm") {
    if (headwear === "none") fill(p, 3, 1, 10, 1, "#2a2433");
    fill(p, 1, 5, 1, 7, "#2a2433");
    if (!back) { dots(p, [[2, 8], [3, 9]], "#2a2433"); p.set("4,9", "#f5c242"); }
  }
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
// A tall person gets one more row of body (the desk hides the rest).
function stretchBody(p, parts) {
  if (parts.build !== "tall") return;
  for (let x = 0; x <= 13; x++) if (p.has(`${x},14`)) p.set(`${x},15`, p.get(`${x},14`));
}

function characterPixels(agent) {
  const parts = lookParts(agent);
  const p = new Map();
  drawBackHair(p, parts);
  drawOutfit(p, parts);
  stretchBody(p, parts);
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
  if (style === "sidetail") fill(p, 12, 4, 13, 10, hair);
  if (style === "afro") { fill(p, 0, 2, 13, 8, hair); }
  drawOutfit(p, parts, true);
  stretchBody(p, parts);
  drawHead(p, skin);
  dots(p, [[2, 6], [11, 6], [2, 7], [11, 7]], shade(skin, -15));
  const covered = !["bald", "buzz", "mohawk", "undercut"].includes(style);
  if (style === "undercut") { fill(p, 3, 1, 10, 4, hair); fill(p, 2, 5, 11, 7, shade(skin, -24)); }
  if (style === "wavy") { fill(p, 1, 4, 12, 12, hair); dots(p, [[0, 6], [13, 6], [0, 9], [13, 9], [0, 12], [13, 12]], hair); }
  if (style === "dreads") { fill(p, 1, 4, 12, 11, hair); dots(p, [[2, 7], [5, 10], [8, 8], [11, 10]], shade(hair, 35)); }
  if (covered) { fill(p, 3, 1, 10, 2, hair); fill(p, 2, 3, 11, 8, hair); fill(p, 3, 9, 10, 9, hair); }
  if (style === "buzz") fill(p, 2, 2, 11, 7, shade(hair, 20));
  if (style === "mohawk") fill(p, 6, 0, 7, 8, hair);
  if (style === "bald") p.set("5,3", shade(skin, 25));
  if (style === "afro") fill(p, 1, 0, 12, 9, hair);
  if (style === "curly") [3, 5, 7, 9].forEach((x) => p.set(`${x},0`, hair));
  if (style === "bun") fill(p, 5, 0, 8, 1, hair);
  if (style === "topknot") fill(p, 6, 0, 7, 1, hair);
  if (style === "buns") { fill(p, 2, 0, 4, 1, hair); fill(p, 9, 0, 11, 1, hair); }
  if (style === "long" || style === "hime") fill(p, 2, 9, 11, 13, hair);
  if (style === "bob" || style === "bowl") fill(p, 2, 9, 11, 10, hair);
  if (style === "ponytail") fill(p, 6, 8, 7, 13, hair);
  if (style === "braid") { fill(p, 6, 8, 7, 14, hair); dots(p, [[6, 10], [7, 12]], shade(hair, 30)); }
  tintTips(p, parts, 10);
  drawHeadwear(p, parts, true);
  return p;
}

// A character sprite as SVG; eyelids and the raised arm are separate groups for CSS animation.
// Mouths for moods (a grin, a frown, a surprised "oh"); CSS shows the one that fits the state.
function moodSvg(parts, ox, oy) {
  if (parts.detail === "beard") return "";
  const base = parts.detail === "stubble" ? shade(parts.skin, -28) : parts.skin;
  const face = (cls, list, color) => {
    const m = new Map();
    fill(m, 5, 9, 8, 10, base);
    dots(m, list, color);
    return group(`mood ${cls}`, pixelsToRects(m, ox, oy));
  };
  return face("mood-happy", [[5, 9], [6, 9], [7, 9], [8, 9], [6, 10], [7, 10]], "#7a3b3b") +
    face("mood-worry", [[5, 10], [6, 9], [7, 9], [8, 10]], "#b5535b") +
    face("mood-oh", [[6, 9], [7, 9], [6, 10], [7, 10]], "#7a3b3b");
}

// How far a person sits above or below the usual height.
function buildShift(agent) {
  return { short: 1, tall: -1 }[(agent.look || {}).build] || 0;
}

// A character sprite as SVG; eyelids and the raised arm are separate groups for CSS animation.
function characterSvg(agent, ox, oy, { back = false } = {}) {
  const parts = lookParts(agent);
  oy += buildShift(agent);
  const arm = new Map();
  fill(arm, 12, 5, 13, 11, sleeveColor(parts));
  fill(arm, 12, 3, 13, 4, parts.skin);
  if (back) {
    return `<g class="body">${pixelsToRects(withOutline(characterBackPixels(agent)), ox, oy)}
      <g class="arm-up">${pixelsToRects(withOutline(arm), ox, oy)}</g></g>`;
  }
  const pixels = withOutline(characterPixels(agent));
  const lids = new Map(eyePixels(parts).map(([x, y]) => [`${x},${y}`, parts.skin]));
  // An open mouth that flaps while the character talks.
  const talk = new Map();
  fill(talk, 6, 9, 7, 10, "#7a3b3b");
  return `<g class="body">${pixelsToRects(pixels, ox, oy)}
    <g class="lids">${pixelsToRects(lids, ox, oy)}</g>
    ${moodSvg(parts, ox, oy)}
    <g class="talk-mouth">${pixelsToRects(talk, ox, oy)}</g>
    <g class="arm-up">${pixelsToRects(withOutline(arm), ox, oy)}</g></g>`;
}

// A standing character with legs, used when somebody leaves the desk and walks through the room.
// The two leg groups alternate in CSS while the sprite moves.
function walkerSvg(agent, { carry = "" } = {}) {
  const parts = lookParts(agent);
  const pants = agent.role === "leader" || agent.role === "pm" || parts.outfit === "suit" ? "#3b3f52" : PANTS;
  // Tall people have longer legs, short people shorter ones.
  const top = 15 + (parts.build === "tall" ? 1 : 0);
  const len = parts.build === "short" ? -1 : 0;
  const legs = (left, right) => {
    const p = new Map();
    fill(p, 3, top, 6, top - 1 + left + len, pants);
    fill(p, 7, top, 10, top - 1 + right + len, pants);
    fill(p, 3, top + left + len, 6, top + left + len, "#2a2433");
    fill(p, 7, top + right + len, 10, top + right + len, "#2a2433");
    return pixelsToRects(withOutline(p));
  };
  const mug = box(11, 9, 5, 5, PX.paper) + rect(13, 10, 2, 1, "#b07d4f");
  const paddle = box(12, 6, 5, 5, "#e05a5a") + rect(14, 11, 1, 3, PX.woodDark);
  const parcel = box(3, 9, 9, 7, "#c9955c") + rect(7, 10, 1, 5, "#e8d3a8");
  return `<svg class="walker-svg" viewBox="-1 -1 18 22" shape-rendering="crispEdges" aria-hidden="true">
    <g class="legs"><g class="leg-s">${legs(3, 3)}</g><g class="leg-a">${legs(3, 2)}</g><g class="leg-b">${legs(2, 3)}</g></g>
    <g class="walker-body wb-front">${pixelsToRects(withOutline(characterPixels(agent)))}</g>
    <g class="walker-body wb-back">${pixelsToRects(withOutline(characterBackPixels(agent)))}</g>
    <g class="walker-mug">${mug}</g><g class="walker-paddle">${paddle}</g>${carry === "parcel" ? `<g class="walker-parcel">${parcel}</g>` : ""}</svg>`;
}

// The office cat on its feet (two leg frames alternate while it walks).
const CAT_COLORS = ["#e8a25c", "#5d6470", "#f4f4f1", "#3a2f3f"];
const DOG_COLORS = ["#c98a5a", "#f3e2c7", "#6b4129", "#9aa3ad"];

// The office pet on its feet (two leg frames alternate while it walks).
function petSpriteSvg(kind = "cat", variant = 0) {
  const dog = kind === "dog";
  const color = (dog ? DOG_COLORS : CAT_COLORS)[variant % 4];
  const dark = shade(color, -45);
  const frame = (legs) => {
    const p = new Map();
    fill(p, 1, 2, 9, 5, color); fill(p, 8, 0, 11, 3, color);
    if (dog) { fill(p, 11, 2, 12, 3, color); p.set("12,2", PX.outline); dots(p, [[8, 0], [8, 1], [8, 2]], dark); dots(p, [[0, 1], [0, 2]], color); }
    else { dots(p, [[8, 0], [11, 0]], dark); dots(p, [[0, 0], [0, 1], [0, 2]], dark); }
    p.set("10,2", PX.outline);
    dots(p, legs, color);
    return pixelsToRects(withOutline(p));
  };
  return `<svg class="walker-svg" viewBox="-1 -1 15 9" shape-rendering="crispEdges" aria-hidden="true">
    <g class="leg-s">${frame([[2, 6], [8, 6]])}</g><g class="leg-a">${frame([[2, 6], [7, 6]])}</g><g class="leg-b">${frame([[3, 6], [8, 6]])}</g></svg>`;
}

// A robot vacuum that wanders over the free floor.
// Cleaning robots that wander over the free floor: a disc, a square mop and a small drone.
function vacuumSvg(kind = "disc", variant = 0) {
  const body = ["#3d424e", "#f4f4f1", "#e05a5a", "#5a8be0"][variant % 4];
  let inner;
  if (kind === "mop") inner = box(0, 0, 10, 6, body) + rect(1, 5, 8, 1, "#7fd0ef") + rect(4, 2, 2, 1, "#f5c242", "amb-blink");
  else if (kind === "drone") {
    inner = rect(1, 5, 8, 1, "rgba(58,47,63,.25)") + box(2, 1, 6, 3, body) + rect(0, 0, 3, 1, "#9aa3ad", "amb-fan") + rect(7, 0, 3, 1, "#9aa3ad", "amb-fan") +
      rect(4, 2, 2, 1, "#5cc28f", "amb-blink");
  } else inner = box(0, 1, 10, 5, body) + rect(1, 0, 8, 1, shade(body, 30)) + rect(4, 2, 2, 1, "#5cc28f", "amb-blink");
  return `<svg class="walker-svg" viewBox="0 0 10 6" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
}

function parcelSvg() {
  return `<svg class="walker-svg" viewBox="0 0 9 7" shape-rendering="crispEdges" aria-hidden="true">
    ${box(0, 0, 9, 7, "#c9955c")}${rect(4, 1, 1, 5, "#e8d3a8")}</svg>`;
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
  return `<svg class="portrait" viewBox="-1 -1 16 18" shape-rendering="crispEdges" aria-hidden="true">
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

// Framed pictures. The scene is drawn inside the frame (iw x ih pixels).
const ART = {
  sea: (x, y, w, h) => rect(x, y, w, h, "#bfe3f2") + rect(x, y + h - 5, w, 5, "#5a8be0") + rect(x + w - 5, y + 2, 3, 3, "#fff3a6") +
    rect(x + 4, y + h - 9, 1, 5, PX.outline) + rect(x + 5, y + h - 9, 3, 3, PX.paper) + rect(x + 2, y + h - 4, 7, 1, "#8a5a2b"),
  mountain: (x, y, w, h) => rect(x, y, w, h, "#dff4fc") + rect(x + 5, y + 3, 2, 2, "#9aa3ad") + rect(x + 4, y + 5, 4, 2, "#9aa3ad") + rect(x + 2, y + 7, 8, h - 7, "#9aa3ad") +
    rect(x + 5, y + 3, 2, 1, PX.paper) + rect(x + w - 7, y + 6, 5, h - 6, "#76828c") + rect(x + w - 5, y + 5, 2, 1, PX.paper) + rect(x, y + h - 3, w, 3, "#7cc35a"),
  abstract: (x, y, w, h) => rect(x, y, w, h, PX.paper) + rect(x + 1, y + 1, 6, 5, "#e05a5a") + rect(x + 8, y + 2, w - 9, 3, "#f5c242") +
    rect(x + 3, y + 7, 4, h - 8, "#5a8be0") + rect(x + 9, y + 6, 5, 5, PX.outline) + rect(x + 10, y + 7, 3, 3, "#5cc28f"),
  cat: (x, y, w, h) => rect(x, y, w, h, "#ffd0d9") + rect(x + 4, y + 4, w - 8, h - 5, "#e8a25c") + rect(x + 4, y + 2, 2, 2, "#e8a25c") + rect(x + w - 6, y + 2, 2, 2, "#e8a25c") +
    rect(x + 6, y + 6, 1, 2, PX.outline) + rect(x + w - 7, y + 6, 1, 2, PX.outline) + rect(x + Math.floor(w / 2) - 1, y + 9, 2, 1, "#f4a3a3"),
  sunset: (x, y, w, h) => rect(x, y, w, h, "#6b4f9e") + rect(x, y + 3, w, 3, "#e8738a") + rect(x, y + 6, w, 3, "#f2a65a") + rect(x + Math.floor(w / 2) - 3, y + 5, 6, 4, "#fff3a6") +
    rect(x, y + 9, w, h - 9, "#3d2b4f") + rect(x + 3, y + 10, w - 6, 1, "#f2a65a"),
  flower: (x, y, w, h) => rect(x, y, w, h, "#d8f5e5") + rect(x + Math.floor(w / 2), y + 6, 1, h - 7, "#3d7a36") + rect(x + Math.floor(w / 2) - 2, y + 2, 5, 5, "#ff8fb1") +
    rect(x + Math.floor(w / 2) - 1, y + 3, 3, 3, "#f5c242") + rect(x + Math.floor(w / 2) + 1, y + 8, 3, 1, "#5aa04a") + rect(x + 2, y + h - 3, w - 4, 2, "#b9663a"),
  city: (x, y, w, h) => rect(x, y, w, h, "#1d2547") + rect(x + 1, y + 5, 4, h - 5, "#3d4452") + rect(x + 6, y + 2, 4, h - 2, "#4b5563") + rect(x + 11, y + 6, w - 12, h - 6, "#3d4452") +
    rect(x + 2, y + 7, 1, 1, "#fff3a6") + rect(x + 7, y + 4, 1, 1, "#fff3a6", "amb-blink slow") + rect(x + 8, y + 8, 1, 1, "#fff3a6") + rect(x + 12, y + 8, 1, 1, "#fff3a6") + rect(x + w - 4, y + 2, 2, 2, "#fff3a6"),
  space: (x, y, w, h) => rect(x, y, w, h, "#1f2633") + rect(x + 5, y + 4, 6, 6, "#a98ae6") + rect(x + 6, y + 3, 4, 8, "#a98ae6") + rect(x + 3, y + 7, 10, 1, "#f5c242") +
    rect(x + 2, y + 2, 1, 1, "#ffffff", "amb-star") + rect(x + w - 3, y + 3, 1, 1, "#ffffff", "amb-star s2") + rect(x + w - 5, y + h - 3, 1, 1, "#fff3a6", "amb-star s3"),
};

function painting(x, y, w, h, scene, frame) {
  return box(x, y, w, h, frame) + rect(x + 1, y + 1, w - 2, h - 2, shade(frame, 20)) + ART[scene](x + 2, y + 2, w - 4, h - 4);
}

function dartboard(x, y) {
  return box(x, y, 14, 14, "#2a2433") + box(x + 2, y + 2, 10, 10, "#e05a5a") + box(x + 4, y + 4, 6, 6, PX.paper) + rect(x + 6, y + 6, 2, 2, "#e05a5a") +
    rect(x + 9, y + 3, 3, 1, "#f5c242") + rect(x + 8, y + 4, 1, 1, PX.outline);
}

function corkboard(x, y) {
  return box(x, y, 30, 18, "#c9955c") + box(x + 3, y + 3, 7, 6, PX.paper) + rect(x + 6, y + 3, 1, 1, "#e05a5a") + box(x + 12, y + 2, 6, 8, "#fff36f") +
    rect(x + 14, y + 2, 1, 1, "#5a8be0") + box(x + 20, y + 4, 7, 6, "#bfe3f2") + rect(x + 22, y + 7, 3, 2, "#7cc35a") + rect(x + 23, y + 4, 1, 1, "#e05a5a") +
    box(x + 5, y + 11, 8, 5, "#ffd0d9") + box(x + 16, y + 12, 9, 4, PX.paper, "#9aa3ad");
}

function roadmap(x, y) {
  let s = box(x, y, 38, 18, "#fbfdff") + rect(x + 3, y + 9, 32, 1, PX.metalDark);
  ["#5cc28f", "#5cc28f", "#f5c242", "#9aa3ad", "#9aa3ad"].forEach((c, i) => {
    s += box(x + 4 + i * 7, y + 7, 5, 5, c) + rect(x + 6 + i * 7, y + (i % 2 ? 13 : 3), 1, 3, PX.metal) + rect(x + 4 + i * 7, y + (i % 2 ? 15 : 2), 5, 1, c);
  });
  return s;
}

function lineChart(x, y) {
  let s = box(x, y, 28, 18, "#fbfdff") + rect(x + 3, y + 3, 1, 12, PX.metalDark) + rect(x + 3, y + 14, 22, 1, PX.metalDark);
  [[6, 12], [9, 11], [12, 12], [15, 9], [18, 7], [21, 5]].forEach(([dx, dy], i, all) => {
    s += rect(x + dx, y + dy, 3, 1, "#5cc28f") + (i === all.length - 1 ? rect(x + dx + 2, y + dy - 1, 2, 2, "#22744c", "amb-blink") : "");
  });
  return s;
}

function stringLights(x, y) {
  let s = rect(x, y + 1, 40, 1, PX.outline);
  ["#e05a5a", "#f5c242", "#5cc28f", "#6fa3ef", "#ff6fb5", "#f5c242", "#5cc28f"].forEach((c, i) => {
    s += rect(x + 2 + i * 6, y + 2, 1, 2 + (i % 2), PX.outline) + rect(x + 1 + i * 6, y + 4 + (i % 2), 3, 3, c, i % 2 ? "amb-blink" : "amb-blink slow");
  });
  return s;
}

function exitSign(x, y) {
  return box(x, y, 16, 8, "#2f8a5b") + rect(x + 2, y + 2, 3, 4, PX.paper) + rect(x + 6, y + 2, 1, 4, PX.paper) + rect(x + 8, y + 2, 1, 4, PX.paper) +
    rect(x + 10, y + 2, 4, 1, PX.paper) + rect(x + 11, y + 3, 2, 3, PX.paper) + rect(x + 1, y + 8, 14, 1, "#b9ecfb", "amb-blink slow");
}

function wallGuitar(x, y) {
  return rect(x + 4, y, 2, 12, "#8a5a2b") + box(x + 3, y - 1, 4, 3, "#3d2b1f") + box(x + 1, y + 9, 8, 9, "#e07a5f") + rect(x + 4, y + 12, 2, 2, PX.outline) + rect(x + 4, y + 2, 1, 14, PX.paper);
}

function wallMirror(x, y) {
  return box(x, y, 14, 18, "#d9a441") + rect(x + 2, y + 2, 10, 14, "#dff4fc") + rect(x + 3, y + 3, 2, 5, "#ffffff") + rect(x + 6, y + 4, 1, 3, "#ffffff");
}

function cuckooClock(x, y) {
  return box(x + 3, y - 1, 6, 3, PX.woodDark) + box(x, y + 2, 12, 11, PX.woodFront) + box(x + 3, y + 4, 6, 6, PX.paper) + rect(x + 6, y + 5, 1, 2, PX.outline) + rect(x + 6, y + 7, 2, 1, PX.outline) +
    group("amb-wiggle", rect(x + 5, y + 13, 1, 5, PX.metalDark) + rect(x + 4, y + 18, 3, 2, "#d9a441"));
}

function bookLedge(x, y) {
  const books = ["#e05a5a", "#5a8be0", "#f5c242", "#5cc28f", "#a98ae6", "#ee9a48", "#e8738a"];
  let s = rect(x, y + 13, 30, 2, PX.woodFront) + rect(x + 1, y + 15, 2, 2, PX.woodDark) + rect(x + 27, y + 15, 2, 2, PX.woodDark);
  books.forEach((c, i) => { s += rect(x + 2 + i * 3, y + 5 + (i % 3), 2, 8 - (i % 3), c); });
  return s + plant(x + 24, y + 6);
}

function hangingPlants(x, y) {
  let s = "";
  [[2, 8], [11, 12], [20, 6]].forEach(([dx, len]) => {
    s += rect(x + dx + 2, y - 2, 1, 4, PX.metalDark) + box(x + dx, y + 2, 6, 4, PX.pot) + rect(x + dx + 1, y + 6, 1, len, PX.leaf) + rect(x + dx + 4, y + 6, 1, len - 3, PX.leafLight) +
      rect(x + dx, y + 7, 1, 2, PX.leafDark) + rect(x + dx + 5, y + 8, 1, 2, PX.leaf);
  });
  return s;
}

function wallTv(x, y) {
  return box(x, y, 34, 18, "#1f2633") + rect(x + 2, y + 2, 30, 11, "#3f6fb0") + rect(x + 4, y + 4, 8, 7, "#f4a3a3") + rect(x + 6, y + 5, 4, 3, "#ffe0c7") +
    rect(x + 14, y + 5, 14, 1, PX.paper) + rect(x + 14, y + 8, 10, 1, PX.paper) + rect(x + 2, y + 14, 30, 2, "#e05a5a") + rect(x + 4, y + 14, 12, 2, PX.paper, "amb-blink slow");
}

function certificates(x, y) {
  const one = (cx, cy) => box(cx, cy, 12, 9, "#d9a441") + rect(cx + 2, cy + 2, 8, 5, PX.paper) + rect(cx + 3, cy + 3, 5, 1, PX.metal) + rect(cx + 7, cy + 5, 2, 2, "#e05a5a");
  return one(x, y) + one(x + 14, y + 2) + one(x + 4, y + 11);
}

function skateboard(x, y) {
  return box(x, y + 6, 26, 4, "#e8738a") + rect(x + 2, y + 7, 22, 1, "#f5c242") + box(x + 3, y + 10, 4, 3, PX.metalDark) + box(x + 19, y + 10, 4, 3, PX.metalDark) +
    rect(x + 12, y + 3, 2, 3, PX.metalDark);
}

function worldClocks(x, y) {
  let s = "";
  [0, 12, 24].forEach((dx, i) => {
    s += box(x + dx, y + 2, 10, 10, "#fbfdff") + rect(x + dx + 4, y + 4 + i, 1, 3, PX.outline) + rect(x + dx + 5, y + 6, 2 + (i % 2), 1, PX.outline) + rect(x + dx + 2, y + 14, 6, 2, ["#e05a5a", "#5a8be0", "#5cc28f"][i]);
  });
  return s;
}

function quotePoster(x, y) {
  return box(x, y, 18, 19, "#2a2433") + rect(x + 3, y + 3, 12, 3, "#f5c242") + rect(x + 3, y + 8, 8, 2, PX.paper) + rect(x + 3, y + 11, 11, 2, PX.paper) + rect(x + 3, y + 14, 6, 2, "#ff6fb5");
}

function smallBoxes(x, y, kind) {
  if (kind === "thermostat") return box(x, y + 4, 8, 9, "#f4f4f1") + rect(x + 2, y + 6, 4, 3, "#9fe7ff") + rect(x + 3, y + 10, 2, 1, "#e05a5a", "amb-blink slow");
  if (kind === "fireExt") return box(x + 1, y + 3, 6, 14, "#e05a5a") + rect(x + 3, y, 2, 3, PX.metalDark) + rect(x + 5, y + 1, 3, 1, PX.outline) + rect(x + 2, y + 8, 4, 3, PX.paper);
  if (kind === "firstAid") return box(x, y + 4, 12, 11, "#f4f4f1") + rect(x + 5, y + 6, 2, 7, "#e05a5a") + rect(x + 3, y + 8, 6, 3, "#e05a5a");
  return box(x, y + 2, 10, 15, "#3d424e") + box(x + 2, y + 4, 6, 5, "#1f2633") + box(x + 3, y + 11, 4, 4, "#1f2633") + rect(x + 4, y + 6, 2, 1, "#9aa3ad", "amb-blink");
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
  // (the sleeping body is in the "pet-body" group: it is hidden while the pet walks around)
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
    group("pet-body", pixelsToRects(withOutline(p), x, y) + group("amb-tail", pixelsToRects(withOutline(tail), x, y)) +
      group("amb-zzz", glyph([[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]], x + 2, y - 7, "#ffffff")));
}

// The office dog asleep in its basket.
function officeDog(x, y, color = "#c98a5a") {
  const dark = shade(color, -45);
  const p = new Map();
  fill(p, 2, 3, 12, 7, color); fill(p, 0, 4, 3, 7, color); dots(p, [[1, 3], [2, 3]], dark);
  dots(p, [[1, 5]], PX.outline); p.set("0,6", PX.outline);
  dots(p, [[8, 4], [10, 5]], dark);
  const tail = new Map();
  fill(tail, 13, 4, 14, 5, color);
  return box(x - 2, y + 5, 20, 6, "#8a5a2b") + rect(x - 1, y + 6, 18, 1, "#b4793a") +
    group("pet-body", pixelsToRects(withOutline(p), x, y) + group("amb-tail", pixelsToRects(withOutline(tail), x, y)) +
      group("amb-zzz", glyph([[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]], x + 2, y - 7, "#ffffff")));
}

function birdCage(x, y) {
  return rect(x + 6, y + 6, 2, 12, PX.metalDark) + box(x + 3, y + 17, 8, 2, PX.metalDark) + box(x + 1, y - 8, 12, 15, "#fff8d6", "#a77b00") +
    [3, 6, 9].map((dx) => rect(x + dx, y - 7, 1, 13, "#d9a441")).join("") + rect(x + 2, y + 2, 10, 1, "#8a5a2b") +
    group("amb-wiggle", rect(x + 5, y - 2, 4, 4, "#f5c242") + rect(x + 9, y - 1, 1, 1, "#ee9a48") + rect(x + 7, y - 1, 1, 1, PX.outline));
}

function treadmill(x, y) {
  return box(x, y + 10, 22, 5, "#3d424e") + rect(x + 1, y + 11, 20, 1, "#5d6470", "amb-blink") + rect(x + 18, y - 6, 2, 16, PX.metalDark) +
    box(x + 14, y - 9, 8, 5, "#2a2433") + rect(x + 16, y - 7, 4, 1, "#5cc28f", "amb-blink slow") + rect(x + 2, y + 15, 2, 2, PX.outline) + rect(x + 18, y + 15, 2, 2, PX.outline);
}

function floorSpeaker(x, y) {
  return box(x, y - 8, 12, 24, "#2a2433") + box(x + 2, y - 5, 8, 8, "#3d424e") + rect(x + 4, y - 3, 4, 4, "#9aa3ad", "amb-blink") +
    box(x + 3, y + 6, 6, 6, "#3d424e") + rect(x + 5, y + 8, 2, 2, "#9aa3ad", "amb-blink slow");
}

function snackShelf(x, y) {
  let s = box(x, y - 8, 18, 24, PX.woodFront) + rect(x + 1, y, 16, 1, PX.woodDark) + rect(x + 1, y + 8, 16, 1, PX.woodDark);
  [["#e05a5a", 2, -6], ["#f5c242", 7, -5], ["#5cc28f", 12, -6], ["#6fa3ef", 2, 2], ["#ff8fb1", 8, 3], ["#ee9a48", 13, 2], ["#a98ae6", 3, 10], ["#f3e2c7", 9, 10]]
    .forEach(([c, dx, dy]) => { s += rect(x + dx, y + dy, 4, 5, c); });
  return s;
}

function bikeStand(x, y) {
  return box(x, y + 6, 9, 9, "#3d424e") + rect(x + 2, y + 8, 5, 5, PX.floor) + box(x + 15, y + 6, 9, 9, "#3d424e") + rect(x + 17, y + 8, 5, 5, PX.floor) +
    rect(x + 4, y + 4, 16, 2, "#e05a5a") + rect(x + 8, y, 2, 5, "#e05a5a") + rect(x + 6, y - 1, 6, 2, PX.outline) + rect(x + 18, y, 2, 5, "#e05a5a") + rect(x + 17, y - 1, 5, 1, PX.outline);
}

function sketchEasel(x, y) {
  return rect(x + 2, y + 8, 1, 9, PX.woodDark) + rect(x + 15, y + 8, 1, 9, PX.woodDark) + box(x, y - 8, 18, 17, "#fbfdff") +
    rect(x + 3, y - 5, 8, 1, "#5a8be0") + rect(x + 3, y - 2, 11, 1, "#e05a5a") + box(x + 4, y + 1, 5, 5, "#fff36f") + rect(x + 11, y + 2, 4, 3, "#5cc28f");
}

function foosball(x, y) {
  let s = box(x, y + 2, 30, 10, "#2f7d4f") + rect(x + 14, y + 3, 2, 8, PX.paper) + rect(x + 2, y + 12, 3, 5, PX.woodDark) + rect(x + 25, y + 12, 3, 5, PX.woodDark);
  [5, 11, 18, 24].forEach((dx, i) => { s += rect(x + dx, y, 1, 14, PX.metal) + rect(x + dx - 1, y + 4 + (i % 2) * 3, 3, 3, i % 2 ? "#e05a5a" : "#5a8be0", "amb-wiggle"); });
  return s;
}

function massageChair(x, y) {
  return box(x + 1, y - 8, 16, 16, "#3d2b1f") + rect(x + 3, y - 6, 12, 5, "#5b3a29") + box(x, y + 2, 4, 12, "#2a2433") + box(x + 14, y + 2, 4, 12, "#2a2433") +
    box(x + 3, y + 7, 12, 8, "#5b3a29") + rect(x + 15, y + 4, 2, 1, "#5cc28f", "amb-blink slow");
}

function telescope(x, y) {
  return rect(x + 6, y + 2, 1, 14, PX.metalDark) + rect(x + 3, y + 8, 1, 8, PX.metalDark) + rect(x + 9, y + 8, 1, 8, PX.metalDark) +
    box(x, y - 4, 13, 5, "#f4f4f1") + box(x + 11, y - 6, 4, 9, "#9aa3ad") + rect(x - 1, y - 2, 2, 2, PX.outline);
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
  birch: () => ({ top: "#ecd9b0", front: "#cdb382", edge: "#a68c5b" }),
  walnut: () => ({ top: "#8a5a3c", front: "#6b4129", edge: "#4a2c1a" }),
  glass: () => ({ top: "#cfeaf5", front: "#9aa9b4", edge: "#76828c" }),
};
// What can differ from desk to desk in one room. Each person's set comes from their id and the room seed.
const DESK_SHAPES = ["panel", "legs", "rounded", "curved", "lshape", "drawer", "trestle", "lshapeLeft", "pedestal", "hairpin", "wave", "dshape", "cart", "crate"];
// The manager's desks are wider and deeper.
const EXEC_SHAPES = ["executive", "execGlass", "execCurved", "execWhite", "execAntique", "execL"];
const EXEC_CHAIRS = ["exec", "execBlack", "execWing", "execWhite"];
const GEAR_LABELS = {
  panel: "panel desk", legs: "open desk", rounded: "rounded desk", curved: "curved desk", lshape: "L-shaped desk", drawer: "desk with drawers",
  trestle: "trestle desk", lshapeLeft: "L-shaped desk", pedestal: "pedestal desk", hairpin: "hairpin-leg desk", wave: "wave desk", dshape: "round-end desk",
  cart: "rolling desk", crate: "crate desk", executive: "panelled executive desk", execGlass: "glass executive desk", execCurved: "curved executive desk",
  execWhite: "white executive desk", execAntique: "antique executive desk", execL: "executive desk with a side wing",
  laptop: "laptop", laptopDark: "dark laptop", screen: "monitor", side: "side screen and keyboard", dual: "laptop and second screen", tablet: "tablet",
  mug: "mug", mugColor: "coloured mug", tea: "tea", takeaway: "takeaway coffee", glass: "juice", bottle: "water bottle", can: "soda can", boba: "bubble tea", none: "nothing to drink",
  role: "the tools of the job", photo: "a framed photo", lamp: "a desk lamp", plant: "a plant", cactus: "a cactus", books: "a pile of books", duck: "a rubber duck",
  robot: "a toy robot", fan: "a fan", stickies: "sticky notes", globe: "a globe",
};
const DESK_WIDTHS = [34, 38, 40, 42];
const COMPUTERS = ["laptop", "laptop", "laptopDark", "screen", "side", "dual", "tablet"];
const DRINKS = ["mug", "mugColor", "tea", "takeaway", "glass", "bottle", "can", "boba", "none"];
const DESK_ITEMS = ["role", "role", "photo", "lamp", "plant", "cactus", "books", "duck", "robot", "fan", "stickies", "globe"];
const LID_COLORS = ["#8d96a3", "#cfd6de", "#3d424e", "#e8c7a0"];
const CUP_COLORS = ["#e8738a", "#5fb3b3", "#f5c242", "#7d8fe0"];

// A person's desk and gear. deskSeed changes when the customer rolls a new desk for them.
function gearFor(agent, seed = 0) {
  const h = hashOf(`${agent.id}#${seed}#${agent.deskSeed || 0}`);
  const at = (list, shift) => list[(h >>> shift) % list.length];
  return {
    shape: at(DESK_SHAPES, 0), width: at(DESK_WIDTHS, 4), computer: at(COMPUTERS, 8), drink: at(DRINKS, 12),
    item: at(DESK_ITEMS, 16), tint: (h >>> 21) % 4, exec: at(EXEC_SHAPES, 3), execChair: at(EXEC_CHAIRS, 7),
  };
}

// The same in words, for the staff panel.
function gearSummary(agent, seed = 0) {
  const gear = gearFor(agent, seed);
  const boss = agent.id === "pm";
  const drink = gear.drink === "none" && boss ? "mug" : gear.drink;
  return [GEAR_LABELS[boss ? gear.exec : gear.shape], GEAR_LABELS[boss ? "dual" : gear.computer], GEAR_LABELS[drink],
    GEAR_LABELS[boss ? "role" : gear.item]];
}

// A desk of the given shape. Returns the drawing and whether the space under the top is open
// (then the legs of whoever sits there are drawn too).
function deskShape(x, y, w, model, shape) {
  const c = (DESK_MODELS[model] || DESK_MODELS.wood)();
  const hi = shade(c.top, 22);
  const top = box(x, y, w, 7, c.top) + rect(x + 1, y + 1, w - 2, 1, hi);
  const rounded = (rows) => {
    const p = new Map();
    rows.forEach(([x0, x1, y0, y1, color]) => fill(p, x0, y0, x1, y1, color));
    return pixelsToRects(withOutline(p), x + 1, y + 1);
  };
  const W = w - 3;
  // The gold name plate on the front of a manager's desk.
  const plate = (dy, shift = 0) => box(x + Math.floor(w / 2) - 7 + shift, y + dy, 14, 5, "#f5c242", "#a77b00") + rect(x + Math.floor(w / 2) - 4 + shift, y + dy + 2, 8, 1, "#8a5a2b");
  switch (shape) {
    case "legs":
      return { open: true, svg: box(x + 1, y + 6, 4, 8, c.front) + box(x + w - 5, y + 6, 4, 8, c.front) + rect(x + 5, y + 9, w - 10, 1, c.edge) + top };
    case "trestle":
      return { open: true, svg: [x + 2, x + w - 9].map((lx) =>
        rect(lx, y + 7, 1, 7, c.edge) + rect(lx + 6, y + 7, 1, 7, c.edge) + rect(lx, y + 10, 7, 1, c.edge)).join("") + top };
    case "drawer":
      return { open: true, svg: box(x + 1, y + 6, 4, 8, c.front) + box(x + w - 14, y + 6, 13, 8, c.front) +
        rect(x + w - 11, y + 8, 7, 1, c.edge) + rect(x + w - 11, y + 11, 7, 1, c.edge) + top };
    case "rounded":
      return { open: false, svg: rounded([[1, W - 1, 0, 0, c.top], [0, W, 1, 4, c.top], [1, W - 1, 1, 1, hi], [0, W, 5, 9, c.front], [1, W - 1, 10, 10, c.front], [1, W - 1, 8, 8, c.edge]]) };
    case "curved":
      return { open: false, svg: rounded([[1, W - 1, 0, 0, c.top], [0, W, 1, 4, c.top], [1, W - 1, 1, 1, hi], [0, W, 5, 6, c.front], [2, W - 2, 7, 8, c.front], [5, W - 5, 9, 10, c.front], [5, W - 5, 10, 10, c.edge]]) };
    case "lshape":
      return { open: false, svg: top + box(x, y + 6, w, 6, c.front) + rect(x + 1, y + 10, w - 2, 1, c.edge) +
        box(x + w - 12, y + 6, 12, 8, c.top) + rect(x + w - 11, y + 6, 10, 1, c.top) + rect(x + w - 11, y + 7, 10, 1, hi) +
        box(x + w - 12, y + 13, 12, 4, c.front) };
    case "lshapeLeft":
      return { open: false, svg: top + box(x, y + 6, w, 6, c.front) + rect(x + 1, y + 10, w - 2, 1, c.edge) +
        box(x, y + 6, 12, 8, c.top) + rect(x + 1, y + 6, 10, 1, c.top) + rect(x + 1, y + 7, 10, 1, hi) + box(x, y + 13, 12, 4, c.front) };
    case "pedestal":
      return { open: true, svg: [x + 1, x + w - 11].map((px) => box(px, y + 6, 10, 8, c.front) + rect(px + 2, y + 8, 6, 1, c.edge) + rect(px + 2, y + 11, 6, 1, c.edge)).join("") + top };
    case "hairpin":
      return { open: true, svg: [x + 2, x + w - 6].map((px) => rect(px, y + 7, 1, 7, PX.metalDark) + rect(px + 3, y + 7, 1, 7, PX.metalDark) + rect(px + 1, y + 13, 2, 1, PX.metalDark)).join("") +
        box(x, y, w, 6, c.top) + rect(x + 1, y + 1, w - 2, 1, hi) };
    case "wave": {
      const rows = [[1, W - 1, 0, 0, c.top], [0, W, 1, 4, c.top], [1, W - 1, 1, 1, hi], [0, W, 5, 8, c.front]];
      for (let i = 1; i < W - 2; i += 6) rows.push([i, i + 3, 9, 10, c.front]);
      return { open: false, svg: rounded(rows) };
    }
    case "dshape":
      return { open: false, svg: box(x + Math.floor(w / 2) - 4, y + 6, 8, 7, c.front) + box(x + Math.floor(w / 2) - 8, y + 12, 16, 2, c.edge) +
        rounded([[2, W - 2, 0, 0, c.top], [0, W, 1, 3, c.top], [2, W - 2, 4, 4, c.top], [2, W - 2, 1, 1, hi]]) };
    case "cart":
      return { open: false, svg: top + box(x + 2, y + 6, w - 4, 6, c.front) + rect(x + 4, y + 8, w - 8, 2, c.edge) + box(x + 3, y + 11, 4, 4, "#2a2433") + box(x + w - 7, y + 11, 4, 4, "#2a2433") };
    case "crate":
      return { open: true, svg: [x + 1, x + w - 11].map((px) => box(px, y + 6, 10, 8, "#c9955c") + rect(px + 1, y + 8, 8, 1, "#a8743d") + rect(px + 1, y + 11, 8, 1, "#a8743d") + rect(px + 4, y + 7, 1, 6, "#a8743d")).join("") +
        top + [x + Math.floor(w / 3), x + Math.floor((2 * w) / 3)].map((px) => rect(px, y + 2, 1, 4, c.edge)).join("") };
    case "executive":
      // The manager's desk: deep, panelled front, gold trim and a name plate.
      return { open: false, h: 17, svg: box(x, y, w, 8, c.top) + rect(x + 1, y + 1, w - 2, 1, hi) + box(x, y + 7, w, 10, c.front) +
        rect(x + 1, y + 8, w - 2, 1, "#d9a441") + [x + 3, x + w - 17].map((px) => box(px, y + 10, 14, 5, shade(c.front, -14), c.edge)).join("") + plate(10) };
    case "execGlass":
      // Glass on a chrome frame, with a smoked panel in front.
      return { open: true, h: 16, svg: box(x + 2, y + 6, 4, 11, "#9aa3ad") + box(x + w - 6, y + 6, 4, 11, "#9aa3ad") + rect(x + 6, y + 14, w - 12, 1, "#76828c") +
        rect(x + 8, y + 7, w - 16, 6, "rgba(60,80,100,.4)") + box(x, y, w, 7, "#cfeaf5") + rect(x + 1, y + 1, w - 2, 1, "#ffffff") + rect(x + 6, y + 3, 10, 1, "#ffffff") + plate(8) };
    case "execCurved":
      return { open: false, h: 17, svg: rounded([[2, W - 2, 0, 0, c.top], [0, W, 1, 5, c.top], [2, W - 2, 1, 1, hi], [0, W, 6, 9, c.front], [0, W, 6, 6, "#d9a441"],
        [3, W - 3, 10, 12, c.front], [8, W - 8, 13, 14, c.front]]) + plate(10) };
    case "execWhite":
      // White lacquer with a wooden side and a gold line.
      return { open: false, h: 17, svg: box(x, y, w, 8, "#f4f4f1") + rect(x + 1, y + 1, w - 2, 1, "#ffffff") + box(x, y + 7, w, 10, "#e3e5e8") + rect(x + 1, y + 8, w - 2, 1, "#d9a441") +
        box(x + w - 18, y + 7, 18, 10, PX.wood) + rect(x + w - 16, y + 11, 14, 1, PX.woodDark) + plate(10, -8) };
    case "execAntique":
      // Two carved pedestals with gold knobs and an arch between them.
      return { open: true, h: 17, svg: [x, x + w - 18].map((px) => box(px, y + 7, 18, 10, c.front) + box(px + 2, y + 9, 14, 3, shade(c.front, -14), c.edge) + box(px + 2, y + 13, 14, 3, shade(c.front, -14), c.edge) +
        rect(px + 8, y + 10, 2, 1, "#f5c242") + rect(px + 8, y + 14, 2, 1, "#f5c242")).join("") + rect(x + 18, y + 7, w - 36, 3, c.front) + rect(x + 18, y + 10, w - 36, 1, c.edge) +
        box(x, y, w, 8, c.top) + rect(x + 1, y + 1, w - 2, 1, hi) + rect(x + 1, y + 6, w - 2, 1, "#d9a441") };
    case "execL":
      return { open: false, h: 20, svg: box(x, y, w, 8, c.top) + rect(x + 1, y + 1, w - 2, 1, hi) + box(x, y + 7, w, 9, c.front) + rect(x + 1, y + 8, w - 2, 1, "#d9a441") +
        box(x + w - 18, y + 7, 18, 9, c.top) + rect(x + w - 17, y + 7, 16, 1, c.top) + rect(x + w - 17, y + 8, 16, 1, hi) + box(x + w - 18, y + 15, 18, 5, c.front) + plate(10, -9) };
    default:
      return { open: false, svg: top + box(x, y + 6, w, 6, c.front) + rect(x + 1, y + 10, w - 2, 1, c.edge) };
  }
}

// Knees, shoes and the chair seat under an open desk.
function underDesk(cx, deskY) {
  return rect(cx, deskY + 6, 14, 2, PX.chairDark) + rect(cx + 3, deskY + 7, 3, 5, PANTS) + rect(cx + 8, deskY + 7, 3, 5, PANTS) +
    rect(cx + 2, deskY + 12, 4, 1, "#2a2433") + rect(cx + 8, deskY + 12, 4, 1, "#2a2433");
}

function sideMonitor(x, deskY) {
  return box(x - 1, deskY - 10, 12, 9, "#2a2f3a") + rect(x, deskY - 9, 10, 6, "#17202e") +
    group("code", rect(x + 1, deskY - 8, 5, 1, "#5cc28f", "k0") + rect(x + 1, deskY - 6, 7, 1, "#6fa3ef", "k1") + rect(x + 1, deskY - 4, 4, 1, "#f5c242", "k0")) +
    rect(x + 3, deskY - 1, 3, 2, PX.metalDark) + rect(x + 1, deskY + 1, 7, 1, PX.metalDark);
}

// What stands in front of the person. Everything is in the "laptop" group so an empty (joining) desk can hide it.
function computerSvg(kind, cx, deskY, tint) {
  const lid = LID_COLORS[tint % LID_COLORS.length];
  const sticker = ["#5cc28f", "#f5c242", "#ff6fb5", "#6fa3ef"][tint % 4];
  const laptop = box(cx + 2, deskY - 3, 10, 5, kind === "laptopDark" ? "#3d424e" : lid) +
    rect(cx + 6, deskY - 2, 2, 2, kind === "laptopDark" ? "#dff4fc" : sticker);
  if (kind === "screen") return box(cx, deskY - 5, 14, 6, "#2a2f3a") + rect(cx + 6, deskY - 3, 2, 2, "#5d6470") + rect(cx + 4, deskY + 1, 6, 1, "#5d6470");
  if (kind === "side") return box(cx + 2, deskY - 2, 10, 3, "#cfd6de") + rect(cx + 3, deskY - 1, 8, 1, "#9aa3ad");
  if (kind === "tablet") return box(cx + 3, deskY - 3, 8, 5, "#2a2f3a") + rect(cx + 12, deskY - 2, 1, 3, PX.paper);
  return laptop;
}

// Something to drink, in the "mug" group; hot drinks steam while their owner is idle.
function drinkSvg(kind, mx, deskY, tint) {
  const steam = (top) => group("steam", rect(mx + 1, top - 3, 1, 2, "#ffffff") + rect(mx + 3, top - 5, 1, 2, "#ffffff"));
  switch (kind) {
    case "none": return "";
    case "mugColor": return box(mx, deskY - 3, 5, 5, CUP_COLORS[tint]) + rect(mx + 5, deskY - 2, 1, 2, PX.outline) + steam(deskY - 3);
    case "tea": return rect(mx - 1, deskY + 1, 7, 1, "#cfd6de") + box(mx, deskY - 2, 5, 4, PX.paper) + rect(mx + 1, deskY - 1, 3, 1, "#b5651d") + steam(deskY - 2);
    case "takeaway": return box(mx + 1, deskY - 6, 4, 8, PX.paper) + rect(mx + 1, deskY - 6, 4, 1, "#5b3a29") + rect(mx + 2, deskY - 3, 2, 2, "#b07d4f") + steam(deskY - 6);
    case "glass": return rect(mx + 3, deskY - 8, 1, 4, "#e05a5a") + box(mx + 1, deskY - 5, 4, 7, "#dff4fc") + rect(mx + 2, deskY - 2, 2, 3, "#f2a65a");
    case "bottle": return box(mx + 1, deskY - 7, 4, 9, "#7fd0ef") + rect(mx + 2, deskY - 9, 2, 2, "#2b6ca3") + rect(mx + 2, deskY - 4, 2, 1, PX.paper);
    case "can": return box(mx + 1, deskY - 4, 4, 6, "#e05a5a") + rect(mx + 2, deskY - 2, 2, 1, PX.paper);
    case "boba": return rect(mx + 2, deskY - 8, 1, 4, "#c27ac9") + box(mx + 1, deskY - 5, 4, 7, "#f3e2c7") + rect(mx + 2, deskY, 1, 1, "#5b3a29") + rect(mx + 3, deskY - 1, 1, 1, "#5b3a29");
    default: return box(mx, deskY - 3, 5, 5, PX.paper) + rect(mx + 5, deskY - 2, 1, 2, PX.outline) + steam(deskY - 3);
  }
}

// A personal thing on the desk (or the role's own prop).
function deskItemSvg(kind, role, x, deskY) {
  switch (kind) {
    case "photo": return box(x + 1, deskY - 6, 6, 7, PX.woodFront) + rect(x + 2, deskY - 5, 4, 4, "#bfe3f2") + rect(x + 3, deskY - 3, 2, 2, "#f4a3a3");
    case "lamp": return rect(x + 2, deskY - 5, 5, 5, "#fff3a6", "desklamp") + rect(x + 1, deskY, 5, 1, PX.metalDark) + rect(x + 3, deskY - 6, 1, 6, PX.metalDark) + box(x + 2, deskY - 9, 6, 4, PX.accent);
    case "plant": return plant(x, deskY - 7);
    case "cactus": return rect(x + 2, deskY - 8, 2, 6, "#4f9a5a") + rect(x, deskY - 6, 2, 2, "#4f9a5a") + rect(x + 4, deskY - 5, 2, 2, "#4f9a5a") + box(x, deskY - 3, 6, 4, "#c98a5a");
    case "books": return box(x, deskY - 2, 8, 3, "#5a8be0") + box(x + 1, deskY - 4, 7, 3, "#e05a5a") + box(x, deskY - 6, 6, 3, "#f5c242");
    case "duck": {
      const p = new Map();
      fill(p, 0, 2, 5, 4, "#f5c242"); fill(p, 3, 0, 5, 2, "#f5c242"); p.set("6,1", "#ee9a48"); p.set("4,1", PX.outline);
      return pixelsToRects(withOutline(p), x + 1, deskY - 5);
    }
    case "robot": return box(x + 1, deskY - 9, 6, 5, "#9aa3ad") + rect(x + 2, deskY - 7, 1, 1, "#5cc28f", "amb-blink") + rect(x + 5, deskY - 7, 1, 1, "#5cc28f", "amb-blink") + box(x + 2, deskY - 5, 4, 5, "#6fa3ef");
    case "fan": return rect(x + 2, deskY, 4, 1, PX.metalDark) + rect(x + 3, deskY - 3, 2, 3, PX.metalDark) + box(x, deskY - 10, 8, 8, "#dff4fc") +
      group("amb-fan", rect(x + 3, deskY - 9, 2, 6, PX.metal) + rect(x + 1, deskY - 7, 6, 2, PX.metal)) + rect(x + 3, deskY - 7, 2, 2, PX.metalDark);
    case "stickies": return box(x, deskY - 3, 5, 5, "#fff36f") + box(x + 3, deskY - 5, 5, 5, "#ff8fb1") + rect(x + 5, deskY - 3, 2, 1, PX.outline);
    case "globe": return box(x + 1, deskY - 9, 6, 6, "#6fa3ef") + rect(x + 2, deskY - 7, 2, 2, "#7cc35a") + rect(x + 5, deskY - 6, 1, 2, "#7cc35a") + rect(x + 3, deskY - 3, 2, 3, PX.metalDark) + rect(x + 2, deskY, 4, 1, PX.metalDark);
    default: return deskProp(role, x, deskY - 8);
  }
}

// Chair behind a character that faces the viewer.
function chairBackSvg(cx, y, model) {
  if (model === "stool") return "";
  if (model.startsWith("exec")) {
    // The manager's high-backed chairs with arm rests: brown leather, black, a wing chair, white and gold.
    const [leather, light, arm, stud] = {
      exec: ["#5b3a29", "#7a4f38", "#3d2b1f", "#d9a441"], execBlack: ["#2a2433", "#4b4458", "#9aa3ad", "#cfd6de"],
      execWing: ["#7a2e3a", "#9c4553", "#5b1f29", "#f5c242"], execWhite: ["#f4f4f1", "#ffffff", "#d9a441", "#d9a441"],
    }[model] || ["#5b3a29", "#7a4f38", "#3d2b1f", "#d9a441"];
    const wings = model === "execWing" ? box(cx - 5, y + 2, 4, 12, leather) + box(cx + 15, y + 2, 4, 12, leather) : "";
    return box(cx - 3, y + 1, 20, 23, leather) + rect(cx - 2, y + 2, 18, 2, light) + wings +
      [[1, 6], [12, 6], [1, 11], [12, 11]].map(([dx, dy]) => rect(cx + dx, y + dy, 1, 1, stud)).join("") +
      box(cx - 6, y + 13, 4, 9, arm) + box(cx + 16, y + 13, 4, 9, arm);
  }
  if (model === "gaming") {
    return box(cx - 2, y + 5, 18, 19, "#2a2433") + rect(cx + 5, y + 6, 4, 17, PX.accent) + box(cx + 2, y + 2, 10, 5, "#2a2433");
  }
  if (model === "mesh") {
    let s = box(cx - 1, y + 7, 16, 17, "#5d6470");
    for (let i = 0; i < 4; i++) s += rect(cx + 1, y + 9 + i * 3, 12, 1, "#8d96a3");
    return s;
  }
  if (model === "wood") {
    return box(cx - 1, y + 8, 16, 16, PX.woodFront) + [2, 6, 10].map((dx) => rect(cx + dx, y + 10, 2, 13, PX.wood)).join("");
  }
  return box(cx - 2, y + 9, 18, 15, PX.chair) + rect(cx - 1, y + 10, 16, 2, shade(PX.chair, 25));
}

// Chair in front of a character that sits with the back to the viewer.
function chairFrontSvg(cx, y, model) {
  if (model === "stool") return box(cx + 2, y + 10, 10, 4, PX.metal);
  if (model === "gaming") return box(cx - 2, y, 18, 14, "#2a2433") + rect(cx + 5, y + 1, 4, 12, PX.accent);
  if (model === "mesh") return box(cx - 1, y, 16, 12, "#5d6470") + [2, 5, 8].map((dy) => rect(cx + 1, y + dy, 12, 1, "#8d96a3")).join("") + rect(cx + 5, y + 12, 4, 3, PX.metalDark);
  if (model === "wood") return box(cx - 1, y, 16, 12, PX.woodFront) + [2, 6, 10].map((dx) => rect(cx + dx, y + 2, 2, 9, PX.wood)).join("");
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
  // Single pixels inside (or next to) the bubble.
  const px = (list, color) => list.map(([dx, dy]) => rect(x + dx, y + dy, 1, 1, color)).join("");
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
      .map(([c, dx, dy], i) => rect(x + dx, y + dy, 2, 2, c, `c${i % 3}`)).join("")}</g>
    <g class="icon icon-ask">${group("z1", glyph([[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]], x + 2, y + 2, "#f5a623"))}
      ${group("z2", glyph([[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]], x + 8, y - 1, "#f5a623"))}</g>
    <g class="icon icon-code">${bubble(px([[4, 3], [3, 4], [4, 5], [6, 5], [7, 3], [9, 3], [10, 4], [9, 5]], "#5cc28f"), "#3d4452", "#1f2633")}</g>
    <g class="icon icon-wave">${group("z1", px([[3, 19], [4, 20], [3, 21]], "#6fa3ef"))}${group("z2", px([[6, 18], [7, 19], [7, 20], [7, 21], [6, 22]], "#6fa3ef"))}</g>
    <g class="icon icon-dream">${bubble(px([[4, 2], [5, 2], [7, 2], [8, 2], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [5, 5], [6, 5], [7, 5], [6, 6]], "#ff8fb1"))}</g>
    <g class="icon fx fx-term">${bubble(px([[3, 3], [4, 4], [3, 5]], "#5cc28f") + rect(x + 6, y + 5, 3, 1, "#5cc28f", "amb-blink"), "#3d4452", "#1f2633")}</g>
    <g class="icon fx fx-search">${bubble(px([[4, 2], [5, 2], [6, 2], [3, 3], [7, 3], [3, 4], [7, 4], [4, 5], [5, 5], [6, 5], [8, 6], [9, 7]], "#2b5ea7"))}</g>
    <g class="icon fx fx-write">${bubble(px([[8, 2], [7, 3], [6, 4], [5, 5]], "#f5a623") + px([[4, 6]], PX.outline) + rect(x + 3, y + 7, 7, 1, PX.metal))}</g>
    <g class="icon fx fx-read">${bubble(rect(x + 3, y + 2, 7, 6, "#d7f0ff") + rect(x + 6, y + 2, 1, 6, "#9aa3ad") + rect(x + 4, y + 4, 1, 1, "#2b5ea7") + rect(x + 8, y + 4, 1, 1, "#2b5ea7") + rect(x + 4, y + 6, 1, 1, "#2b5ea7"))}</g>
    <g class="icon fx fx-web">${bubble(rect(x + 4, y + 2, 5, 6, "#6fa3ef") + rect(x + 3, y + 3, 7, 4, "#6fa3ef") + px([[4, 3], [5, 3], [5, 4], [8, 5], [7, 6]], "#7cc35a"))}</g>
    <g class="icon fx fx-fail">${bubble(px([[4, 2], [5, 3], [6, 4], [7, 5], [8, 6], [8, 2], [7, 3], [5, 5], [4, 6]], "#c0392b"), "#c2405a", "#ffe3e8")}</g>
    <g class="icon fx fx-star">${glyph([[2, 0], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [1, 4], [3, 4]], x + 4, y + 1, "#f5c242")}</g>`;
}

// A desk with its chair, the agent, a laptop and a role prop, facing the viewer. Slot: 44 x 40 (wide: 62 x 40).
function workstationSvg(agent, x, y, { wide = false, desk = "wood", chair = "office", deskX, deskW, seed = 0 } = {}) {
  const w = wide ? 58 : 40;
  const gear = gearFor(agent, seed);
  const joined = deskX !== undefined; // part of a long shared desk
  const cx = x + 2 + Math.floor(w / 2) - 7; // character left edge
  const deskY = y + 22;
  const dw = joined ? deskW : wide ? w : gear.width;
  const dx = joined ? deskX : wide ? x + 2 : cx + 7 - Math.floor(dw / 2);
  const shape = joined ? "panel" : wide ? gear.exec : gear.shape;
  const open = ["legs", "trestle", "drawer", "pedestal", "hairpin", "crate"].includes(shape);
  // Most desks follow the room; some people brought their own, and open frames may carry a glass top.
  const model = wide ? (gear.tint === 1 ? "dark" : "walnut") : joined ? desk : open && gear.tint === 2 ? "glass" : gear.tint === 3 ? "birch" : desk;
  const d = deskShape(dx, deskY, dw, model, shape);
  const leftX = joined || wide ? x + 4 : dx + 2;
  const rightX = (joined || wide ? x + w : dx + dw) - 7;
  const computer = wide ? "dual" : gear.computer;
  const sideScreen = computer === "side" || computer === "dual";
  const skin = (agent.look && agent.look.skin) || "#ffe0c7";
  const height = d.h || 12;
  // data-idle picks this person's habits: what they do without work and how they look when busy.
  return `
  <g class="ws st-idle${wide ? " boss" : ""}" data-agent="${escAttr(agent.id)}" data-idle="${hashOf(agent.id) % 6}">
    ${rect(dx + 2, deskY + height, dw - 4, 2, "rgba(90,60,30,.18)")}
    ${chairBackSvg(cx, y, wide ? gear.execChair : chair)}
    ${characterSvg(agent, cx, y + 6)}
    <rect class="glow" x="${cx + 2}" y="${y + 9}" width="10" height="7" fill="#9fe7ff"/>
    <g class="phone">${box(cx + 5, y + 16, 4, 6, "#2a2433")}${rect(cx + 6, y + 17, 2, 3, "#9fe7ff")}</g>
    <g class="readdoc">${box(cx + 3, y + 14, 8, 8, PX.paper)}${rect(cx + 5, y + 16, 4, 1, PX.metal)}${rect(cx + 5, y + 18, 3, 1, PX.metal)}</g>
    ${d.open ? underDesk(cx, deskY) : ""}
    ${d.svg}
    <g class="laptop">${computerSvg(computer, cx, deskY, gear.tint)}${sideScreen ? sideMonitor(wide ? x + 40 : leftX, deskY) : ""}</g>
    <g class="sparks">${rect(cx + 3, deskY - 5, 1, 1, "#5cc28f", "k0")}${rect(cx + 7, deskY - 6, 1, 1, "#6fa3ef", "k1")}${rect(cx + 10, deskY - 5, 1, 1, "#f5c242", "k2")}</g>
    <g class="flame">${rect(cx + 5, deskY - 6, 4, 3, "#ff8c42")}${rect(cx + 6, deskY - 8, 2, 3, "#f5c242")}${rect(cx + 6, deskY - 5, 2, 2, "#fff3a6")}</g>
    <g class="smoke">${rect(cx + 4, deskY - 7, 2, 2, "#9aa3ad", "k0")}${rect(cx + 8, deskY - 9, 3, 2, "#c9d0d6", "k1")}${rect(cx + 6, deskY - 12, 2, 2, "#9aa3ad", "k2")}</g>
    <g class="hands">${rect(cx, deskY + 1, 2, 1, skin)}${rect(cx + 12, deskY + 1, 2, 1, skin)}</g>
    <g class="mug" style="--sip-x:${cx + 9 - rightX}px">${drinkSvg(gear.drink === "none" && wide ? "mug" : gear.drink, rightX, deskY, gear.tint)}</g>
    <g class="prop">${sideScreen && !wide ? "" : deskItemSvg(wide ? "role" : gear.item, agent.role, leftX, deskY)}</g>
    <g class="movebox">${box(leftX - 1, deskY - 9, 10, 10, "#c9955c")}${rect(leftX, deskY - 5, 8, 1, "#a8743d")}${rect(leftX + 3, deskY - 8, 2, 8, "#e8d3a8")}</g>
    ${wide ? `<g class="prop">${deskItemSvg("books", agent.role, x + 15, deskY)}</g>` : ""}
    <g class="beacon">${box(rightX - 4, deskY - 6, 4, 6, "#e05a5a")}${rect(rightX - 3, deskY - 5, 2, 2, "#ffd0d9")}</g>
    <g class="trophy">${box(rightX - 5, deskY - 8, 6, 5, "#f5c242", "#a77b00")}${rect(rightX - 3, deskY - 3, 2, 2, "#a77b00")}${rect(rightX - 4, deskY - 1, 4, 1, "#a77b00")}</g>
    ${statusIcons(cx + 9, y - 6)}
  </g>`;
}

// The same, but the agent sits with the back to the viewer: desk first, then the agent, then the chair.
function workstationBackSvg(agent, x, y, { desk = "wood", chair = "office" } = {}) {
  const w = 40;
  const cx = x + 2 + Math.floor(w / 2) - 7;
  return `
  <g class="ws st-idle back" data-agent="${escAttr(agent.id)}" data-idle="${hashOf(agent.id) % 6}">
    ${deskShape(x + 2, y, w, desk, "panel").svg}
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
  return box(x + 6, y - 6, 26, 14, "#2a2433") + rect(x + 8, y - 4, 22, 10, "#3f6fb0", "tv-screen") +
    rect(x + 10, y - 2, 8, 1, "#9fe7ff", "tv-line") + rect(x + 10, y + 1, 13, 1, "#9fe7ff", "tv-line") + rect(x + 17, y + 8, 4, 3, PX.metalDark) +
    box(x + 9, y + 16, 20, 8, PX.wood) +
    box(x, y + 28, 38, 12, sofa) + rect(x + 1, y + 29, 36, 3, shade(sofa, 25)) + rect(x + 12, y + 32, 1, 7, shade(sofa, -30)) + rect(x + 25, y + 32, 1, 7, shade(sofa, -30));
}

function pingPong(x, y) {
  return box(x, y, 36, 22, "#2f7d4f") + rect(x + 1, y + 10, 34, 2, PX.paper) + rect(x + 17, y + 1, 1, 20, PX.paper) +
    rect(x + 2, y + 22, 2, 4, PX.metalDark) + rect(x + 32, y + 22, 2, 4, PX.metalDark) +
    box(x + 6, y + 4, 5, 5, "#e05a5a") + box(x + 26, y + 14, 5, 5, "#e05a5a") + rect(x + 20, y + 6, 2, 2, "#ffffff", "pp-ball");
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

function beanbag(x, y, c) {
  const p = new Map();
  fill(p, 2, 0, 7, 1, c); fill(p, 0, 2, 9, 6, c); fill(p, 1, 7, 8, 7, shade(c, -30)); fill(p, 3, 2, 6, 3, shade(c, 25));
  return pixelsToRects(withOutline(p), x, y);
}

// Gaming corner: a big screen with a console and two beanbags.
function gamingCorner(x, y) {
  return box(x + 14, y + 2, 32, 15, "#2a2433") + rect(x + 16, y + 4, 28, 11, "#3f6fb0", "tv-screen") + rect(x + 19, y + 7, 9, 1, "#9fe7ff", "tv-line") +
    rect(x + 19, y + 11, 15, 1, "#9fe7ff", "tv-line") + box(x + 24, y + 19, 12, 4, "#f4f4f1") + rect(x + 26, y + 20, 2, 1, "#5cc28f", "amb-blink slow") +
    beanbag(x + 12, y + 36, "#e8738a") + beanbag(x + 38, y + 36, "#5fb3b3");
}

// Nap corner: two sleeping pods and a moon lamp.
function napCorner(x, y) {
  const pod = (px, py, c) => box(px, py, 34, 15, "#e9eef2") + rect(px + 2, py + 2, 30, 11, "#d7dbdf") + box(px + 3, py + 3, 9, 9, PX.paper) + box(px + 13, py + 3, 19, 9, c) + rect(px + 14, py + 4, 17, 2, shade(c, 28));
  return pod(x + 6, y + 6, "#7d8fe0") + pod(x + 6, y + 30, "#c27ac9") + box(x + 46, y + 14, 8, 8, "#fff3a6", "#a77b00") + rect(x + 48, y + 16, 3, 3, "#f5c242", "amb-blink slow") +
    rect(x + 49, y + 22, 2, 6, PX.metalDark);
}

// Band corner: drums, a keyboard and a microphone.
function bandCorner(x, y) {
  return box(x + 6, y + 16, 12, 9, "#e05a5a") + rect(x + 7, y + 17, 10, 2, "#f4f4f1") + box(x + 2, y + 10, 8, 4, "#d9a441") + box(x + 15, y + 9, 8, 4, "#d9a441") +
    rect(x + 5, y + 14, 1, 10, PX.metalDark) + rect(x + 19, y + 13, 1, 11, PX.metalDark) +
    box(x + 30, y + 12, 26, 6, "#2a2433") + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => rect(x + 32 + i * 3, y + 14, 2, 3, PX.paper)).join("") +
    rect(x + 33, y + 18, 1, 8, PX.metalDark) + rect(x + 52, y + 18, 1, 8, PX.metalDark) +
    rect(x + 27, y + 30, 1, 14, PX.metalDark) + box(x + 25, y + 27, 5, 4, "#9aa3ad") + box(x + 24, y + 44, 7, 2, PX.metalDark) +
    group("amb-zzz", glyph([[2, 0], [3, 0], [2, 1], [2, 2], [2, 3], [0, 3], [1, 3], [0, 4], [1, 4]], x + 40, y + 1, "#ff6fb5"));
}

function lounge(kind, x, y) {
  if (kind === "gaming") return gamingCorner(x, y);
  if (kind === "nap") return napCorner(x, y);
  if (kind === "band") return bandCorner(x, y);
  if (kind === "sofa") return sofaCorner(x + 8, y + 6);
  if (kind === "pingpong") return pingPong(x + 14, y + 14);
  if (kind === "round") return roundTable(x + 8, y + 12);
  if (kind === "kitchen") return kitchen(x + 3, y + 10);
  if (kind === "library") return libraryCorner(x + 3, y + 8);
  if (kind === "garden") return gardenCorner(x + 3, y + 8);
  return meetingTable(x + 12, y + 14);
}

// Where people stand when they visit the lounge (offsets from the lounge corner) and what they do there.
// Places in the lounge, as offsets from the lounge corner. A spot says how somebody uses it:
// sit (legs hidden), back (seen from behind), show (sprite rows left visible, when furniture hides more),
// use (a class on the room while somebody is there, so the furniture reacts), play (a game pose).
const SEAT = { sit: true, show: 15 };
const LOUNGE_SPOTS = {
  meeting: [
    { dx: 14, dy: -1, ...SEAT, emotes: ["💬", "📝", "👍"] }, { dx: 30, dy: -1, ...SEAT, emotes: ["💡", "💬", "😄"] },
    { dx: 14, dy: 26, ...SEAT, back: true, emotes: ["💬", "🤔"] }, { dx: 30, dy: 26, ...SEAT, back: true, emotes: ["👍", "💬"] },
  ],
  sofa: [
    { dx: 11, dy: 24, sit: true, back: true, show: 12, use: "tv", emotes: ["📺", "😄"] },
    { dx: 30, dy: 24, sit: true, back: true, show: 12, use: "tv", emotes: ["🍿", "📺"] },
  ],
  pingpong: [
    { dx: 1, dy: 15, play: "pingpong", use: "pingpong", emotes: ["🏓"] },
    { dx: 48, dy: 15, play: "pingpong", use: "pingpong", emotes: ["🏓", "😤"] },
  ],
  round: [
    { dx: 19, dy: 5, ...SEAT, emotes: ["💬", "☕"] }, { dx: 6, dy: 11, ...SEAT, emotes: ["😄", "💬"] },
    { dx: 33, dy: 11, ...SEAT, emotes: ["💬", "🍪"] }, { dx: 19, dy: 25, ...SEAT, back: true, emotes: ["💬"] },
  ],
  kitchen: [
    { dx: 7, dy: 23, ...SEAT, back: true, use: "coffee", mug: true, emotes: ["⏳", "☕"] },
    { dx: 25, dy: 23, ...SEAT, back: true, emotes: ["🍪", "💬"] },
    { dx: 45, dy: 20, emotes: ["🧃"] },
  ],
  library: [{ dx: 10, dy: 28, ...SEAT, emotes: ["📖", "🤓"] }, { dx: 33, dy: 10, emotes: ["📚"] }],
  garden: [
    { dx: 20, dy: 23, ...SEAT, back: true, use: "pond", emotes: ["🌿", "😌"] },
    { dx: 32, dy: 23, ...SEAT, back: true, use: "pond", emotes: ["🐟", "💬"] },
  ],
  gaming: [
    { dx: 10, dy: 27, sit: true, back: true, show: 13, use: "tv", emotes: ["🎮", "😆"] },
    { dx: 36, dy: 27, sit: true, back: true, show: 13, use: "tv", emotes: ["🕹️", "🏆"] },
  ],
  nap: [{ dx: 7, dy: 6, sit: true, show: 9, emotes: ["💤", "😴"] }, { dx: 7, dy: 30, sit: true, show: 9, emotes: ["😴", "💤"] }],
  band: [
    { dx: 5, dy: 0, play: "dance", use: "band", emotes: ["🥁", "🎶"] },
    { dx: 37, dy: 18, back: true, play: "dance", use: "band", emotes: ["🎹", "🎵"] },
    { dx: 20, dy: 30, play: "dance", use: "band", emotes: ["🎤", "🎶"] },
  ],
};

const LOUNGE_INFO = {
  meeting: { name: "Meeting table", about: "Four chairs and yesterday's notes.", does: "Up to four people sit down and talk." },
  sofa: { name: "Sofa and TV", about: "The quiet end of the room.", does: "Two people sit on the sofa; the TV turns on for them." },
  pingpong: { name: "Ping-pong table", about: "Best of three decides who writes the tests.", does: "Two people play a match; the ball flies over the net." },
  round: { name: "Round table", about: "Small talks and coffee.", does: "Up to four people sit around the table and chat." },
  kitchen: { name: "Kitchen", about: "Counter, coffee machine and a fridge.", does: "People sit on the stools with a coffee or look into the fridge." },
  library: { name: "Reading corner", about: "Two bookshelves and a comfortable armchair.", does: "One person reads in the armchair, another browses the shelves." },
  garden: { name: "Indoor garden", about: "Plants, a pond and a bench.", does: "Two people sit on the bench and watch the fish." },
  gaming: { name: "Gaming corner", about: "A big screen, a console and two beanbags.", does: "Two people play on the beanbags; the screen turns on." },
  nap: { name: "Nap pods", about: "Twenty minutes of sleep count as work here.", does: "Two people lie down for a nap." },
  band: { name: "Band corner", about: "Drums, a keyboard and a microphone.", does: "Up to three people play a song together." },
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
const CHAIRS = ["office", "gaming", "stool", "mesh", "wood"];
const LOUNGES_ALL = [...LOUNGES, "gaming", "nap", "band"];
const VACUUMS = ["disc", "mop", "drone"];
const SHELF_INFO = {
  bookshelf: { name: "Bookshelf", about: "The manager's books, sorted by colour." },
  trophies: { name: "Trophy shelf", about: "Gold, silver and bronze from old projects." },
  plantShelf: { name: "Plant shelf", about: "Two plants and a cactus that needs no care." },
};
const CABINET_INFO = {
  cabinet: { name: "Filing cabinet", about: "Contracts in the top drawer, snacks in the bottom one." },
  safe: { name: "Safe", about: "Nobody remembers the combination." },
  minifridge: { name: "Mini fridge", about: "Cold drinks for long calls." },
};
const VACUUM_INFO = {
  disc: { name: "Robot vacuum", about: "Crosses the floor all day and never complains." },
  mop: { name: "Mopping robot", about: "Leaves the floor shiny." },
  drone: { name: "Cleaning drone", about: "Hovers over the floor and dusts as it goes." },
};

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
// Wall items that fit side by side in the given width (8 pixels between them).
function fitWall(names, space) {
  const placed = [];
  let used = 0;
  for (const name of names) {
    const w = WALL_ITEMS[name].w;
    if (placed.length < 5 && used + w <= space) { placed.push(name); used += w + 8; }
  }
  return placed;
}

// Where the floor items stand along the bottom wall (null when one does not fit). The door is in the middle.
function placeFloor(names, teamX) {
  let ex = teamX + 2;
  return names.map((name) => {
    const w = FLOOR_ITEMS[name].w;
    if (ex + w > 112 && ex < 148) ex = 150;
    if (ex + w > teamX + 186) return null;
    const x = ex;
    ex += w + 6;
    return x;
  });
}

// Everything that makes a room look the way it does, derived from one number. Each decoration is a slot
// ("wall.0", "floor.2", "lounge", "shelf", "cabinet", "vacuum"); `items` holds the slots the customer changed:
// { slot: { kind, v } } where v picks a variant (a colour) of the kind.
function roomStyle(seed, items = {}) {
  const rnd = seededRandom(seed);
  const style = {
    seed,
    palette: pickFrom(rnd, PALETTES),
    layout: pickFrom(rnd, LAYOUTS),
    pmSide: rnd() < 0.5 ? "right" : "left",
    lounge: pickFrom(rnd, LOUNGES_ALL),
    desk: pickFrom(rnd, DESKS),
    chair: pickFrom(rnd, CHAIRS),
    windows: 1 + Math.floor(rnd() * 2),
    roundWindows: rnd() < 0.25,
    extras: pickMany(rnd, Object.keys(FLOOR_ITEMS), 4),
    shelf: pickFrom(rnd, Object.keys(SHELF_INFO)),
    cabinet: pickFrom(rnd, Object.keys(CABINET_INFO)),
    vacuum: pickFrom(rnd, VACUUMS),
  };
  style.teamX = style.pmSide === "right" ? 6 : 72;
  style.wallSpace = 180 - style.windows * (style.roundWindows ? 22 : 42);
  style.wallDecor = fitWall(pickMany(rnd, Object.keys(WALL_ITEMS), Object.keys(WALL_ITEMS).length), style.wallSpace);

  // The customer's own choices, when they still fit.
  const chosen = (slot, known) => (items[slot] && known.includes(items[slot].kind) ? items[slot].kind : null);
  style.lounge = chosen("lounge", LOUNGES_ALL) || style.lounge;
  style.shelf = chosen("shelf", Object.keys(SHELF_INFO)) || style.shelf;
  style.cabinet = chosen("cabinet", Object.keys(CABINET_INFO)) || style.cabinet;
  style.vacuum = chosen("vacuum", VACUUMS) || style.vacuum;
  style.wallDecor.forEach((_, i) => {
    const kind = chosen(`wall.${i}`, Object.keys(WALL_ITEMS));
    if (!kind || style.wallDecor.includes(kind)) return;
    const next = style.wallDecor.map((name, k) => (k === i ? kind : name));
    if (fitWall(next, style.wallSpace).length === next.length) style.wallDecor = next;
  });
  style.extras.forEach((_, i) => {
    const kind = chosen(`floor.${i}`, Object.keys(FLOOR_ITEMS));
    if (kind && !style.extras.includes(kind)) style.extras = style.extras.map((name, k) => (k === i ? kind : name));
  });
  style.variant = (slot) => (items[slot] && Number.isInteger(items[slot].v) ? items[slot].v : hashOf(`${seed}:${slot}`)) % 1000;
  return style;
}

// What a slot holds: its kind, name and description, and what staff do there.
function describeItem(style, slot) {
  const [type, index] = slot.split(".");
  if (type === "wall") { const kind = style.wallDecor[index]; return kind ? { kind, type: "Wall decoration", ...WALL_ITEMS[kind] } : null; }
  if (type === "floor") { const kind = style.extras[index]; return kind ? { kind, type: FLOOR_ITEMS[kind].pet ? "Office pet" : "Furniture", ...FLOOR_ITEMS[kind] } : null; }
  if (type === "lounge") return { kind: style.lounge, type: "Lounge", ...LOUNGE_INFO[style.lounge] };
  if (type === "shelf") return { kind: style.shelf, type: "Manager's wall", ...SHELF_INFO[style.shelf] };
  if (type === "cabinet") return { kind: style.cabinet, type: "Manager's corner", ...CABINET_INFO[style.cabinet] };
  if (type === "vacuum") return { kind: style.vacuum, type: "Cleaning robot", ...VACUUM_INFO[style.vacuum], does: "It works on its own; people just step aside." };
  return null;
}

// The kinds a slot can change to without pushing another item off the wall or the floor.
function swapChoices(style, slot) {
  const [type, index] = slot.split(".");
  const i = Number(index);
  if (type === "wall") {
    return Object.keys(WALL_ITEMS).filter((kind) => !style.wallDecor.includes(kind) &&
      fitWall(style.wallDecor.map((name, k) => (k === i ? kind : name)), style.wallSpace).length === style.wallDecor.length);
  }
  if (type === "floor") {
    const before = placeFloor(style.extras, style.teamX);
    return Object.keys(FLOOR_ITEMS).filter((kind) => {
      if (style.extras.includes(kind)) return false;
      const after = placeFloor(style.extras.map((name, k) => (k === i ? kind : name)), style.teamX);
      return after.every((x, k) => x !== null || before[k] === null);
    });
  }
  const all = { lounge: LOUNGES_ALL, shelf: Object.keys(SHELF_INFO), cabinet: Object.keys(CABINET_INFO), vacuum: VACUUMS }[type] || [];
  return all.filter((kind) => kind !== style[type]);
}

// A picture of one item for its panel.
function itemPreviewSvg(seed, items, slot) {
  const style = roomStyle(seed, items);
  const info = describeItem(style, slot);
  if (!info) return "";
  Object.assign(PX, BASE_PX, style.palette.colors);
  try {
    const [type] = slot.split(".");
    const v = style.variant(slot);
    let inner;
    let viewBox;
    if (type === "wall") { inner = rect(-4, 0, info.w + 8, 30, PX.wall) + rect(-4, 26, info.w + 8, 4, PX.wallDark) + info.draw(0); viewBox = `-4 0 ${info.w + 8} 30`; }
    else if (type === "floor") { inner = rect(-4, 4, info.w + 8, 40, PX.floor) + info.draw(0, 40, v); viewBox = `-4 4 ${info.w + 8} 40`; }
    else if (type === "lounge") { inner = rect(0, -10, 64, 70, PX.floor) + lounge(style.lounge, 0, 0); viewBox = "0 -10 64 70"; }
    else if (type === "shelf") { inner = rect(-2, 0, 38, 30, PX.wall) + rect(-2, 26, 38, 4, PX.wallDark) + shelfSvg(style.shelf, 0); viewBox = "-2 0 38 30"; }
    else if (type === "cabinet") { inner = rect(-2, 8, 26, 24, PX.wall) + rect(-2, 28, 26, 4, PX.wallDark) + cabinetSvg(style.cabinet, 1, 15); viewBox = "-2 8 26 24"; }
    else return vacuumSvg(style.vacuum, v).replace('class="walker-svg"', 'class="item-preview"');
    return `<svg class="item-preview" viewBox="${viewBox}" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
  } finally {
    Object.assign(PX, BASE_PX);
  }
}

// What stands or hangs in the manager's corner.
function shelfSvg(kind, x) {
  return { bookshelf: bookshelf(x + 2, 6), trophies: trophyShelf(x + 2, 8), plantShelf: plantShelf(x, 6) }[kind];
}

function cabinetSvg(kind, x, y) {
  if (kind === "safe") return box(x, y, 14, 14, "#5d6470") + box(x + 2, y + 2, 10, 10, "#76828c") + box(x + 5, y + 5, 4, 4, "#3d424e") + rect(x + 10, y + 6, 1, 3, "#f5c242");
  if (kind === "minifridge") return box(x, y, 12, 14, "#f4f4f1") + rect(x + 1, y + 5, 10, 1, "#aab2bb") + rect(x + 9, y + 2, 1, 2, PX.metalDark) + rect(x + 9, y + 7, 1, 4, PX.metalDark) + rect(x + 2, y + 2, 3, 1, "#5cc28f", "amb-blink slow");
  return cabinet(x, y);
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
  if (pm) seats.unshift({ agent: pm, x: pmX, y: 42, w: 62, h: 44, facing: "down", wide: true, tagY: 84, sayY: 36, cx: pmX + 24, aisleY: 82 });
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

// Everything that can hang on the back wall: its width, how to draw it, and what the dashboard says about it.
const WALL_ITEMS = {
  whiteboard: { w: 34, name: "Whiteboard", about: "Yesterday's architecture sketch, never wiped.", draw: (x) => whiteboard(x, 5) },
  posters: { w: 30, name: "Posters", about: "Two posters somebody brought from home.", draw: (x) => posters(x, 6) },
  screen: { w: 40, name: "Status screen", about: "Build status and charts, updated all day.", draw: (x) => wallScreen(x, 4) },
  map: { w: 32, name: "World map", about: "Where the customers are.", draw: (x) => worldMap(x, 5) },
  banner: { w: 38, name: "Party flags", about: "Left over from the last release party.", draw: (x) => banner(x, 4) },
  neon: { w: 30, name: "Neon sign", about: "Flickers a little. Nobody minds.", draw: (x) => neonSign(x, 8) },
  plantShelf: { w: 32, name: "Plant shelf", about: "Two plants and a cactus that needs no care.", draw: (x) => plantShelf(x, 6) },
  clock: { w: 9, name: "Wall clock", about: "Ticks along with the day.", draw: (x) => clock(x, 8) },
  kanban: { w: 36, name: "Kanban board", about: "Sticky notes for what the team is doing.", draw: (x) => kanbanBoard(x, 5) },
  frames: { w: 34, name: "Picture frames", about: "Team photos and a holiday picture.", draw: (x) => pictureFrames(x, 5) },
  calendar: { w: 16, name: "Calendar", about: "The release date is circled in red.", draw: (x) => wallCalendar(x, 6) },
  aircon: { w: 28, name: "Air conditioner", about: "Keeps the room cool.", draw: (x) => airConditioner(x, 5) },
  artSea: { w: 22, name: "Painting: Sailing boat", about: "A calm sea for busy days.", draw: (x) => painting(x, 5, 22, 17, "sea", "#b4793a") },
  artMountain: { w: 22, name: "Painting: Mountains", about: "Snow on the peaks.", draw: (x) => painting(x, 5, 22, 17, "mountain", "#e9eef2") },
  artAbstract: { w: 20, name: "Painting: Abstract", about: "Everybody sees something else in it.", draw: (x) => painting(x, 6, 20, 16, "abstract", "#2a2433") },
  artCat: { w: 18, name: "Portrait of a cat", about: "The founder of the company, they say.", draw: (x) => painting(x, 5, 18, 17, "cat", "#d9a441") },
  artSunset: { w: 26, name: "Painting: Sunset", about: "Bought at a flea market.", draw: (x) => painting(x, 6, 26, 15, "sunset", "#8a5a2b") },
  artFlower: { w: 16, name: "Painting: Flower", about: "A single flower in a pot.", draw: (x) => painting(x, 5, 16, 17, "flower", "#e9eef2") },
  artCity: { w: 24, name: "Painting: City at night", about: "One window is always lit.", draw: (x) => painting(x, 6, 24, 16, "city", "#3d424e") },
  artSpace: { w: 20, name: "Painting: Planet", about: "A ringed planet and a few stars.", draw: (x) => painting(x, 5, 20, 17, "space", "#d9a441") },
  dartboard: { w: 14, name: "Dartboard", about: "For decisions nobody wants to make.", draw: (x) => dartboard(x, 7) },
  corkboard: { w: 30, name: "Pin board", about: "Notes, photos and a lunch menu.", draw: (x) => corkboard(x, 5) },
  roadmap: { w: 38, name: "Roadmap", about: "Milestones: two done, one in progress.", draw: (x) => roadmap(x, 5) },
  lineChart: { w: 28, name: "Growth chart", about: "Up and to the right.", draw: (x) => lineChart(x, 5) },
  stringLights: { w: 40, name: "String lights", about: "Cosy light all year round.", draw: (x) => stringLights(x, 4) },
  exitSign: { w: 16, name: "Exit sign", about: "This way out.", draw: (x) => exitSign(x, 9) },
  guitar: { w: 10, name: "Guitar", about: "Hangs here until Friday afternoon.", draw: (x) => wallGuitar(x, 5) },
  mirror: { w: 14, name: "Mirror", about: "A quick look before the meeting.", draw: (x) => wallMirror(x, 5) },
  cuckoo: { w: 12, name: "Cuckoo clock", about: "The pendulum never stops.", draw: (x) => cuckooClock(x, 5) },
  bookLedge: { w: 30, name: "Book ledge", about: "Technical books and a small plant.", draw: (x) => bookLedge(x, 5) },
  hangingPlants: { w: 26, name: "Hanging plants", about: "Vines growing towards the windows.", draw: (x) => hangingPlants(x, 5) },
  wallTv: { w: 34, name: "News TV", about: "The news runs without sound.", draw: (x) => wallTv(x, 5) },
  certificates: { w: 26, name: "Certificates", about: "Awards the team is proud of.", draw: (x) => certificates(x, 4) },
  skateboard: { w: 26, name: "Skateboard", about: "Somebody rides it to work.", draw: (x) => skateboard(x, 7) },
  worldClocks: { w: 34, name: "World clocks", about: "Three time zones at a glance.", draw: (x) => worldClocks(x, 6) },
  quotePoster: { w: 18, name: "Motto poster", about: "Ship it.", draw: (x) => quotePoster(x, 5) },
  thermostat: { w: 8, name: "Thermostat", about: "Always one degree too warm for somebody.", draw: (x) => smallBoxes(x, 6, "thermostat") },
  fireExt: { w: 8, name: "Fire extinguisher", about: "Checked every year.", draw: (x) => smallBoxes(x, 6, "fireExt") },
  firstAid: { w: 12, name: "First aid kit", about: "Plasters for paper cuts.", draw: (x) => smallBoxes(x, 5, "firstAid") },
  speaker: { w: 10, name: "Wall speaker", about: "Quiet background music.", draw: (x) => smallBoxes(x, 5, "speaker") },
};

// Things along the bottom wall. Items with an emote are places people visit on a break.
// Things along the bottom wall. Items with emotes are places people visit on a break;
// "use" names the class the room gets while somebody is there, so the item reacts.
// Things along the bottom wall. Items with emotes are places people visit on a break ("does" says what
// happens there). The item's own class (item-<name>) lets it react while somebody is there.
const FLOOR_ITEMS = {
  coffee: { w: 18, name: "Coffee machine", about: "The most visited place in the room.", does: "People wait for a coffee and take the mug back to the desk.", emotes: ["⏳", "☕"], mug: true, draw: (x, H) => coffeeMachine(x, H - 16) },
  cooler: { w: 14, name: "Water cooler", about: "Where the office news travels.", does: "People stop for a glass of water.", emotes: ["💧"], draw: (x, H) => waterCooler(x, H - 22) },
  vending: { w: 18, name: "Vending machine", about: "Takes coins, sometimes gives drinks.", does: "People buy a drink.", emotes: ["🪙", "🥤"], draw: (x, H) => vendingMachine(x, H - 20) },
  aquarium: { w: 28, name: "Aquarium", about: "Two fish that have seen every release.", does: "People feed the fish and watch them.", emotes: ["🐟", "🫧"], draw: (x, H) => aquarium(x, H - 20) },
  arcade: { w: 18, name: "Arcade machine", about: "High score: held by the PM.", does: "People play a round.", emotes: ["🎮", "🕹️", "⭐"], play: "arcade", draw: (x, H) => arcade(x, H - 20) },
  printer: { w: 20, name: "Printer", about: "Works on the second try.", does: "People pick up their printouts.", emotes: ["🖨️", "📄"], draw: (x, H) => printer(x, H - 20) },
  beanbags: { w: 26, name: "Beanbags", about: "Hard to get out of.", does: "Up to two people sink in and rest.", seats: [-2, 11], emotes: ["😌", "📱"], draw: (x, H) => beanbags(x, H - 13) },
  lamp: { w: 11, name: "Floor lamp", about: "Warm light for late evenings.", draw: (x, H) => floorLamp(x, H - 18) },
  bigPlant: { w: 10, name: "Big plant", about: "Grows a new leaf every sprint.", does: "People water it.", emotes: ["💧", "🌿"], draw: (x, H) => plant(x, H - 18, true) },
  servers: { w: 16, name: "Server rack", about: "Hums quietly. Please do not unplug.", does: "People check the lights and fix things.", emotes: ["🔧", "✅"], draw: (x, H) => serverRack(x, H - 20) },
  cat: { w: 20, pet: "cat", name: "Office cat", about: "Sleeps most of the day and takes a walk now and then.", does: "People come to pet it; it wakes up and purrs.", emotes: ["🐱", "💕"], draw: (x, H, v) => officeCat(x + 1, H - 16, CAT_COLORS[v % 4]) },
  dog: { w: 22, pet: "dog", name: "Office dog", about: "Guards the basket and greets everybody.", does: "People come to pet it; it wags its tail.", emotes: ["🐶", "💕"], draw: (x, H, v) => officeDog(x + 3, H - 16, DOG_COLORS[v % 4]) },
  bird: { w: 14, name: "Bird cage", about: "Sings when the build is green.", does: "People whistle a tune with the bird.", emotes: ["🐦", "🎶"], draw: (x, H) => birdCage(x, H - 21) },
  treadmill: { w: 22, name: "Treadmill", about: "For walking meetings without leaving.", does: "People walk a few minutes on it.", emotes: ["🏃", "💦"], play: "treadmill", stand: -4, draw: (x, H) => treadmill(x, H - 20) },
  speaker: { w: 12, name: "Speaker", about: "Friday playlist, all week.", does: "People dance for a moment.", emotes: ["🎵", "🕺"], play: "dance", draw: (x, H) => floorSpeaker(x, H - 20) },
  snacks: { w: 18, name: "Snack shelf", about: "Refilled on Mondays, empty by Wednesday.", does: "People grab a snack.", emotes: ["🍫", "😋"], draw: (x, H) => snackShelf(x, H - 20) },
  bike: { w: 24, name: "Bike", about: "Somebody cycles to work in any weather.", does: "People check the tyres.", emotes: ["🚲"], draw: (x, H) => bikeStand(x, H - 19) },
  easel: { w: 18, name: "Sketch board", about: "Ideas that did not fit on the wall.", does: "People sketch an idea.", emotes: ["✏️", "💡"], draw: (x, H) => sketchEasel(x, H - 21) },
  foosball: { w: 30, name: "Table football", about: "Blue against red since day one.", does: "People play a quick match.", emotes: ["⚽", "🥅"], play: "arcade", draw: (x, H) => foosball(x, H - 21) },
  massage: { w: 18, name: "Massage chair", about: "Ten minutes fix any deadline.", does: "One person sits down and relaxes.", seats: [1], emotes: ["😌", "💤"], draw: (x, H) => massageChair(x, H - 19) },
  telescope: { w: 15, name: "Telescope", about: "Points at the office across the street.", does: "People take a look through it.", emotes: ["🔭", "✨"], draw: (x, H) => telescope(x, H - 20) },
  bins: { w: 22, name: "Recycling bins", about: "Paper left, plastic right.", draw: (x, H) => recyclingBins(x, H - 19) },
  coats: { w: 12, name: "Coat rack", about: "Two coats and a forgotten umbrella.", draw: (x, H) => coatRack(x, H - 21) },
};

function roomSvg(agents, seed = 0, { sky = skyPhase(), items = {} } = {}) {
  const style = roomStyle(seed, items);
  Object.assign(PX, BASE_PX, style.palette.colors);
  try {
    const layout = roomLayout(agents, style);
    const { width: W, height: H, pmX, teamX } = layout;
    const windowSky = style.palette.night ? "night" : sky;
    // One open floor: no rugs marking the manager's corner, the team or the lounge. Only a door mat.
    let s = floorSvg(style.palette.floor, W, H);
    s += box(119, H - 12, 24, 7, shade(PX.rug, -18), PX.rugEdge);

    // Back wall: windows and decoration over the team area, a shelf over the manager.
    s += rect(0, 0, W, 30, PX.wall) + rect(0, 26, W, 4, PX.wallDark) + rect(0, 0, W, 3, PX.wallTrim);
    let wx = teamX + 6;
    for (let i = 0; i < style.windows; i++) {
      s += style.roundWindows ? roundWindow(wx, 7, windowSky) : windowSvg(wx, 6, 34, 17, windowSky);
      wx += style.roundWindows ? 22 : 42;
    }
    // layout.items lists what can be clicked: the slot and its rectangle in room pixels.
    layout.items = [];
    style.wallDecor.forEach((name, i) => {
      const item = WALL_ITEMS[name];
      s += group(`item wall-${name}`, item.draw(wx));
      layout.items.push({ slot: `wall.${i}`, name: item.name, x: wx - 1, y: 2, w: item.w + 2, h: 25 });
      wx += item.w + 8;
    });
    s += shelfSvg(style.shelf, pmX + 26) + cabinetSvg(style.cabinet, pmX + 6, 15) + plant(pmX + 20, 16);
    layout.items.push({ slot: "shelf", name: SHELF_INFO[style.shelf].name, x: pmX + 26, y: 3, w: 34, h: 26 });
    layout.items.push({ slot: "cabinet", name: CABINET_INFO[style.cabinet].name, x: pmX + 5, y: 14, w: 15, h: 16 });

    // Lounge under the manager's desk, with the places where people sit, play or gather.
    const loungeY = Math.max(102, H - 66);
    s += group(`item lounge-${style.lounge}`, lounge(style.lounge, pmX, loungeY));
    (LOUNGE_SPOTS[style.lounge] || []).forEach(({ dx, dy, ...how }) => {
      layout.spots.push({ ...how, x: pmX + dx, y: loungeY + dy, zone: "lounge", slot: "lounge" });
    });
    if (style.lounge === "pingpong") layout.pingpong = { x: pmX + 14, y: loungeY + 14, w: 36, h: 22 };
    layout.items.push({ slot: "lounge", name: LOUNGE_INFO[style.lounge].name, x: pmX + 2, y: loungeY - 6, w: 60, h: H - loungeY - 2 });

    // Floor extras along the bottom wall of the team area (the door is in the middle).
    placeFloor(style.extras, teamX).forEach((ex, i) => {
      if (ex === null) return;
      const name = style.extras[i];
      const slot = `floor.${i}`;
      const item = FLOOR_ITEMS[name];
      const v = style.variant(slot);
      s += group(`item item-${name}`, item.draw(ex, H, v));
      const how = { zone: "floor", emotes: item.emotes, mug: item.mug, play: item.play, use: name, slot };
      if (item.seats) item.seats.forEach((dx) => layout.spots.push({ ...how, x: ex + dx, y: H - 24, sit: true, show: 15 }));
      else if (item.emotes) layout.spots.push({ ...how, x: ex + Math.floor(item.w / 2) - 7, y: H - 46 + (item.stand || 0) });
      if (item.pet) layout.pet = { kind: item.pet, x: ex + 1, y: H - 16, v, slot, use: name };
      layout.items.push({ slot, name: item.name, x: ex - 1, y: H - 33, w: item.w + 2, h: 29 });
    });
    layout.vacuum = { kind: style.vacuum, v: style.variant("vacuum"), name: VACUUM_INFO[style.vacuum].name };
    // Stepping out through the door.
    layout.door = { x: 124, y: H - 24 };
    layout.spots.push({ ...layout.door, zone: "door" });

    // The free floor between the desks and the bottom wall: the vacuum, the cat and visitors move here.
    const teamSeats = layout.seats.filter((seat) => !seat.wide);
    const lowest = teamSeats.length ? Math.max(...teamSeats.map((seat) => seat.y + seat.h)) + 14 : TEAM_Y + 10;
    layout.openFloor = { x0: teamX + 4, x1: teamX + 172, y0: Math.min(lowest, H - 42), y1: H - 42 };

    // Desks and staff. Bench desks join into one long table; cubicles get partitions.
    const deskOpts = { desk: style.desk, chair: style.chair, seed };
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

    // Walls and corner posts, with a sliding glass door at the bottom.
    const wallColor = PX.post;
    s += rect(0, 0, 3, H, wallColor) + rect(W - 3, 0, 3, H, wallColor) + rect(0, 0, W, 2, wallColor);
    s += rect(0, H - 3, 116, 3, wallColor) + rect(146, H - 3, W - 146, 3, wallColor);
    s += rect(116, H - 2, 30, 2, PX.woodDark);
    s += rect(117, H - 4, 14, 3, "#bfe6f2", "door-l") + rect(131, H - 4, 14, 3, "#bfe6f2", "door-r");
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
