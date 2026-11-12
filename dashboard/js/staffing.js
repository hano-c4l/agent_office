// Staffing proposal: the PM reads the customer request and proposes a team for approval.
// The mockup uses keyword rules. The real version will ask the PM agent (opus) to return
// the same structure as JSON.

const EXTRA_AGENTS = [
  {
    id: "designer", name: "Yuki", role: "other", title: "UI/UX Designer", model: "sonnet",
    look: { skin: "#ffe6d5", hair: "#e89cc0", hairStyle: "bun", shirt: "#f4b6c2" },
    skills: ["wireframing", "design-system", "usability"],
    tools: ["Read", "Write", "WebSearch"],
    prompt: "You are the UI/UX designer. Produce wireframes, a small design system and review the UI for usability.",
  },
  {
    id: "dev_mobile", name: "Minh", role: "dev", title: "Mobile Developer", model: "sonnet",
    look: { skin: "#f3c9a3", hair: "#1f1f1f", hairStyle: "short", shirt: "#7fd1c7" },
    skills: ["react-native", "mobile-ui", "push-notifications"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    prompt: "You are a mobile developer. Build the iOS/Android app and connect it to the backend APIs.",
  },
  {
    id: "data_eng", name: "Dara", role: "other", title: "Data Engineer", model: "sonnet",
    look: { skin: "#eac3a0", hair: "#4b3621", hairStyle: "bob", shirt: "#9fc5e8" },
    skills: ["sql", "etl", "analytics"],
    tools: ["Read", "Write", "Edit", "Bash"],
    prompt: "You are the data engineer. Design data pipelines, reports and analytics queries.",
  },
  {
    id: "security", name: "Shin", role: "other", title: "Security Engineer", model: "opus",
    look: { skin: "#f5d0b0", hair: "#3a3a5a", hairStyle: "spiky", shirt: "#8d99ae" },
    skills: ["threat-modeling", "owasp", "auth-hardening"],
    tools: ["Read", "Grep", "Glob", "Bash", "WebSearch"],
    prompt: "You are the security engineer. Threat-model the system and review code for security issues.",
  },
];

const ROLE_TEMPLATES = [...DEFAULT_AGENTS, ...EXTRA_AGENTS];

function proposeTeam(request, currentAgents) {
  const text = request.toLowerCase();
  const has = (...words) => words.some((w) => text.includes(w));

  const small = has("simple", "small", "prototype", "poc", "script", "landing page") ||
    text.split(/\s+/).filter(Boolean).length < 5;
  let needsUi = has("web", "ui", "app", "website", "dashboard", "page", "frontend", "site", "portal");
  let needsApi = has("api", "login", "auth", "database", "backend", "server", "payment",
    "shared", "sync", "account", "user", "booking", "order");
  if (!needsUi && !needsApi) needsUi = needsApi = true;
  const mobile = has("mobile", "ios", "android");
  const data = has("data", "report", "analytics", "etl", "chart", "statistic");
  const security = has("payment", "bank", "security", "personal data", "gdpr", "medical", "wallet");
  const deploy = !small || has("deploy", "cloud", "production", "ci", "docker", "hosting");

  const picks = [];
  const pick = (id, reason, overrides = {}) => picks.push({ id, reason, overrides });

  pick("pm", "Plans the work, splits tasks and reports to you.");
  pick("ba", "Clarifies business rules and confirms open questions with you.");
  if (small) {
    pick("sa", "Light design work for a small project, so sonnet is enough.", { model: "sonnet" });
  } else {
    pick("sa", "Designs the architecture and API contracts; needs strong reasoning (opus).");
    pick("leader", "Reviews design and code to keep quality high on a multi-developer project.");
  }
  if (needsUi && !small) pick("designer", "The request has a user interface, so wireframes and UX review help.");
  if (needsApi) pick("dev_be", "Backend work detected (accounts, data, APIs).");
  if (needsUi) pick("dev_fe", "A web UI is needed.");
  if (mobile) pick("dev_mobile", "A mobile app is requested.");
  if (data) pick("data_eng", "Reports or data processing are requested.");
  if (security) pick("security", "Sensitive data or payments: a dedicated security review is needed.");
  pick("test", "Writes test cases from the acceptance criteria and runs them.");
  if (deploy) pick("devops", "Sets up CI/CD and deploys builds to preview.");

  const byId = (id) => currentAgents.find((a) => a.id === id) || ROLE_TEMPLATES.find((a) => a.id === id);
  const members = picks.map(({ id, reason, overrides }) => {
    const base = byId(id);
    const config = structuredClone({
      id: base.id, name: base.name, role: base.role, title: base.title, model: base.model,
      look: base.look, skills: base.skills, tools: base.tools, prompt: base.prompt,
    });
    Object.assign(config, overrides);
    if (id === "sa" && needsApi && !config.skills.includes("security-review")) config.skills.push("security-review");
    return { config, reason, included: true, locked: id === "pm" };
  });

  return {
    request,
    complexity: small ? "Small" : "Medium / Large",
    members,
  };
}

// Roles that are not in the proposal yet and can be added by the customer.
function availableRoles(proposal, currentAgents) {
  const used = new Set(proposal.members.map((m) => m.config.id));
  const seen = new Set();
  return [...currentAgents, ...ROLE_TEMPLATES].filter((a) => {
    if (used.has(a.id) || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
