// Builds an inline SVG chibi character sitting at a desk.

const HAIR_PATHS = {
  short: "M26 56 Q24 18 60 17 Q96 18 94 56 Q88 40 74 36 Q60 44 44 36 Q32 42 26 56Z",
  spiky: "M25 58 L22 34 L34 38 L36 18 L48 30 L58 12 L66 28 L80 14 L82 32 L96 26 L94 58 Q84 40 60 38 Q36 40 25 58Z",
  long:  "M24 96 Q16 50 30 30 Q44 14 60 15 Q78 14 90 30 Q104 50 96 96 L86 96 Q90 60 84 44 Q70 36 60 38 Q48 36 36 44 Q30 60 34 96Z",
  bob:   "M22 78 Q16 36 40 22 Q60 12 80 22 Q104 36 98 78 L88 78 Q90 50 80 40 Q60 34 40 40 Q30 50 32 78Z",
  bun:   "M26 56 Q24 20 60 18 Q96 20 94 56 Q86 38 60 36 Q34 38 26 56Z",
};

function accessorySvg(kind) {
  switch (kind) {
    case "glasses":
      return `<g fill="none" stroke="#333" stroke-width="2.4">
        <circle cx="46" cy="60" r="8"/><circle cx="74" cy="60" r="8"/><path d="M54 60 L66 60"/></g>`;
    case "headphones":
      return `<path d="M28 58 Q28 18 60 18 Q92 18 92 58" fill="none" stroke="#444" stroke-width="5"/>
        <rect x="21" y="52" width="11" height="17" rx="5" fill="#ef6f6c"/>
        <rect x="88" y="52" width="11" height="17" rx="5" fill="#ef6f6c"/>`;
    case "hardhat":
      return `<path d="M26 44 Q28 12 60 12 Q92 12 94 44Z" fill="#ffd23f" stroke="#e0a800" stroke-width="2"/>
        <rect x="20" y="40" width="80" height="7" rx="3" fill="#ffc300"/>`;
    case "tie":
      return `<path d="M60 94 L55 100 L60 120 L65 100Z" fill="#d1495b"/>`;
    case "clipboard":
      return `<g class="prop"><rect x="88" y="98" width="18" height="22" rx="2" fill="#b07d4f"/>
        <rect x="91" y="102" width="12" height="15" fill="#fff"/><rect x="93" y="96" width="8" height="4" fill="#777"/></g>`;
    case "notepad":
      return `<g class="prop"><rect x="14" y="100" width="16" height="20" rx="2" fill="#fff8b5" stroke="#d9c75a"/>
        <path d="M17 106 H27 M17 110 H27 M17 114 H24" stroke="#999" stroke-width="1.2"/></g>`;
    case "magnifier":
      return `<g class="prop"><circle cx="98" cy="102" r="7" fill="#d7f0ff" stroke="#555" stroke-width="2.5"/>
        <path d="M103 107 L110 116" stroke="#555" stroke-width="3.5" stroke-linecap="round"/></g>`;
    default:
      return "";
  }
}

function chibiSvg(agent) {
  const look = agent.look || {};
  const role = ROLES[agent.role] || ROLES.other;
  const skin = look.skin || "#ffe0c7";
  const hair = look.hair || "#4a3426";
  const shirt = look.shirt || role.shirt;
  const style = HAIR_PATHS[look.hairStyle] ? look.hairStyle : "short";
  const acc = agent.id === "customer" ? "none" : role.accessory;
  const bun = style === "bun" ? `<circle cx="60" cy="16" r="11" fill="${hair}"/>` : "";
  const isBack = style === "long" || style === "bob";

  return `
<svg class="chibi" viewBox="0 0 120 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="60" cy="146" rx="44" ry="4" fill="rgba(0,0,0,.12)"/>
  <rect x="34" y="70" width="52" height="52" rx="10" fill="#6d5a4a"/>
  <g class="body-g">
    ${isBack ? `<path d="${HAIR_PATHS[style]}" fill="${hair}" opacity=".95"/>` : ""}
    <rect x="38" y="88" width="44" height="34" rx="14" fill="${shirt}"/>
    ${acc === "tie" ? accessorySvg("tie") : ""}
    <g class="head-g">
      ${bun}
      <circle cx="60" cy="58" r="33" fill="${skin}"/>
      <path d="${HAIR_PATHS[style]}" fill="${hair}"/>
      <g class="eyes">
        <ellipse cx="47" cy="61" rx="4.2" ry="5.2" fill="#2d2d2d"/>
        <ellipse cx="73" cy="61" rx="4.2" ry="5.2" fill="#2d2d2d"/>
        <circle cx="48.5" cy="59" r="1.5" fill="#fff"/><circle cx="74.5" cy="59" r="1.5" fill="#fff"/>
      </g>
      <ellipse cx="39" cy="71" rx="5" ry="3" fill="#ff9aa2" opacity=".55"/>
      <ellipse cx="81" cy="71" rx="5" ry="3" fill="#ff9aa2" opacity=".55"/>
      <path class="mouth" d="M55 74 Q60 78 65 74" fill="none" stroke="#7a3b3b" stroke-width="2" stroke-linecap="round"/>
      ${["glasses", "headphones", "hardhat"].includes(acc) ? accessorySvg(acc) : ""}
    </g>
    <g class="arm arm-l"><rect x="30" y="98" width="13" height="22" rx="6" fill="${shirt}"/><circle cx="36" cy="120" r="5" fill="${skin}"/></g>
    <g class="arm arm-r"><rect x="77" y="98" width="13" height="22" rx="6" fill="${shirt}"/><circle cx="83" cy="120" r="5" fill="${skin}"/></g>
  </g>
  <rect x="6" y="120" width="108" height="24" rx="4" fill="#c99a6b"/>
  <rect x="6" y="120" width="108" height="5" rx="2" fill="#dbb084"/>
  ${agent.id === "customer" ? `<rect x="46" y="110" width="28" height="12" rx="3" fill="#fff" opacity=".9"/>` :
    `<g class="laptop"><rect x="38" y="104" width="44" height="18" rx="2" fill="#4b5563"/>
     <rect class="screen" x="41" y="106" width="38" height="13" rx="1" fill="#9ad1ff"/></g>`}
  ${["clipboard", "notepad", "magnifier"].includes(acc) ? accessorySvg(acc) : ""}
</svg>`;
}
