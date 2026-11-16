// Random identities for new staff: a name (Vietnamese or international), a gender and a pixel look.

const NAMES = {
  female: [
    "Linh", "Mai", "Thao", "Ngoc", "Trang", "Vy", "Lan", "Hoa", "Nhi", "Quynh", "Yen", "Anh",
    "Emma", "Sofia", "Aiko", "Mia", "Chloe", "Hana", "Lena", "Nora", "Ava", "Yuna", "Isla", "Zara",
  ],
  male: [
    "Khoa", "Huy", "Tuan", "Minh", "Bao", "Duc", "Long", "Nam", "Phuc", "Quang", "Son", "Vinh",
    "Liam", "Noah", "Kenji", "Leo", "Lucas", "Ethan", "Ravi", "Omar", "Felix", "Hugo", "Kai", "Theo",
  ],
};

// Shapes, not colors: hair, headwear, eyewear, eyes, mouth, outfit and face details.
const HAIR_STYLES = {
  female: ["long", "bob", "bun", "ponytail", "twintails", "braid", "curly", "afro", "short"],
  male: ["short", "spiky", "side", "buzz", "mohawk", "curly", "afro", "bald", "long"],
};
const HEADWEAR = { female: ["none", "none", "none", "beanie", "headband", "bow", "cap"], male: ["none", "none", "none", "cap", "beanie", "bandana"] };
const EYEWEAR = ["none", "none", "none", "round", "square", "sunglasses"];
const EYES = ["tall", "dot", "happy", "sleepy", "wide"];
const MOUTHS = ["small", "smile", "open", "flat"];
const OUTFITS = ["tshirt", "collar", "hoodie", "sweater", "suit", "overalls", "scarf"];
const DETAILS = { female: ["none", "none", "freckles", "earrings", "blush"], male: ["none", "none", "beard", "mustache", "freckles", "stubble"] };
const SKINS = ["#ffe0c7", "#f8d5b5", "#eac09c", "#f6cfa8", "#ffe7d1", "#d9a57c", "#c68a5e", "#a8704a"];
const HAIRS = ["#2b2b2b", "#3d2b1f", "#5b3a29", "#8a5a2b", "#b5651d", "#d9a441", "#6b4f9e", "#e07a5f", "#1f2a44", "#9aa3ad"];
const SHIRTS = [null, null, null, "#e8738a", "#5fb3b3", "#d9b24c", "#7d8fe0", "#c27ac9"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Creates a random person whose name is not in `taken` (case-insensitive) when possible.
export function randomPerson(taken = []) {
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  const gender = Math.random() < 0.5 ? "female" : "male";
  const free = NAMES[gender].filter((n) => !used.has(n.toLowerCase()));
  const name = free.length ? pick(free) : `${pick(NAMES[gender])} ${used.size + 1}`;
  const shirt = pick(SHIRTS);
  return { name, look: randomLook(gender, shirt) };
}

export function randomLook(gender = Math.random() < 0.5 ? "female" : "male", shirt = pick(SHIRTS)) {
  const hairStyle = pick(HAIR_STYLES[gender]);
  return {
    gender,
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle,
    headwear: hairStyle === "afro" || hairStyle === "mohawk" ? "none" : pick(HEADWEAR[gender]),
    eyewear: pick(EYEWEAR),
    eyes: pick(EYES),
    mouth: pick(MOUTHS),
    outfit: pick(OUTFITS),
    detail: pick(DETAILS[gender]),
    ...(shirt ? { shirt } : {}),
  };
}

// Guesses the accessory role from an agent id or title, for agents the PM creates on its own.
export function guessRole(text) {
  const s = String(text || "").toLowerCase();
  if (/\bpm\b|project.?manager/.test(s)) return "pm";
  if (/test|qa|quality/.test(s)) return "test";
  if (/ops|deploy|infra|sre/.test(s)) return "devops";
  if (/lead/.test(s)) return "leader";
  if (/archit|\bsa\b/.test(s)) return "sa";
  if (/code.?analyst|research|onboard/.test(s)) return "other";
  if (/\bba\b|business|analyst/.test(s)) return "ba";
  if (/dev|engineer|program|coder|frontend|backend|mobile/.test(s)) return "dev";
  return "other";
}

export function titleFromId(id) {
  return String(id || "").split(/[_-]+/).filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
}
