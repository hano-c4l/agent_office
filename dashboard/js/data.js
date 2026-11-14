// Model list, tool catalog, role labels and the sample staff used by demo mode (?demo).

const MODELS = ["opus", "sonnet", "haiku"];

const ALL_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "WebSearch", "WebFetch", "Agent", "NotebookEdit",
];

// Role presets: accessory drawn on the chibi + default shirt color.
const ROLES = {
  pm:     { label: "Project Manager",       accessory: "clipboard",  shirt: "#f59e8b" },
  ba:     { label: "Business Analyst",      accessory: "notepad",    shirt: "#f7c873" },
  sa:     { label: "Solution Architect",    accessory: "glasses",    shirt: "#8fb8f7" },
  leader: { label: "Tech Leader",           accessory: "tie",        shirt: "#7c8db5" },
  dev:    { label: "Developer",             accessory: "headphones", shirt: "#8fd6b4" },
  test:   { label: "Tester",                accessory: "magnifier",  shirt: "#c7a4f2" },
  devops: { label: "DevOps Engineer",       accessory: "hardhat",    shirt: "#f2a65a" },
  other:  { label: "Specialist",            accessory: "none",       shirt: "#b8c4cc" },
};

const DEFAULT_AGENTS = [
  {
    id: "pm", name: "Mira", role: "pm", title: "Project Manager", model: "opus",
    look: { skin: "#ffe0c7", hair: "#5b3a29", hairStyle: "bun" },
    skills: ["planning", "task-breakdown", "risk-tracking", "status-report"],
    tools: ["Read", "Write", "Agent"],
    prompt: "You are the PM. Turn customer requests into a plan, split it into tasks, assign each task to the right role and report progress to the customer.",
  },
  {
    id: "ba", name: "Bao", role: "ba", title: "Business Analyst", model: "sonnet",
    look: { skin: "#f8d5b5", hair: "#2b2b2b", hairStyle: "short" },
    skills: ["requirements-analysis", "user-stories", "acceptance-criteria"],
    tools: ["Read", "Write", "WebSearch"],
    prompt: "You are the BA. Find unclear business rules, ask the customer, and answer business questions from the team.",
  },
  {
    id: "sa", name: "Sora", role: "sa", title: "Solution Architect", model: "opus",
    look: { skin: "#ffe7d1", hair: "#6b4f9e", hairStyle: "long" },
    skills: ["system-design", "tech-selection", "api-contracts", "security-review"],
    tools: ["Read", "Write", "Grep", "Glob", "WebSearch", "WebFetch"],
    prompt: "You are the SA. Design the architecture, choose the tech stack and define API contracts.",
  },
  {
    id: "leader", name: "Leo", role: "leader", title: "Tech Leader", model: "opus",
    look: { skin: "#eac09c", hair: "#1f2a44", hairStyle: "spiky" },
    skills: ["code-review", "tech-decisions", "mentoring"],
    tools: ["Read", "Grep", "Glob", "Bash"],
    prompt: "You are the Tech Leader. Review designs and code, unblock developers and keep quality high.",
  },
  {
    id: "dev_be", name: "Kai", role: "dev", title: "Backend Developer", model: "sonnet",
    look: { skin: "#f6cfa8", hair: "#3d2b1f", hairStyle: "spiky" },
    skills: ["nodejs", "rest-api", "database"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    prompt: "You are a backend developer. Implement APIs and data models following the SA's contracts.",
  },
  {
    id: "dev_fe", name: "Nana", role: "dev", title: "Frontend Developer", model: "sonnet",
    look: { skin: "#ffe3cc", hair: "#e07a5f", hairStyle: "bob" },
    skills: ["react", "ui-components", "accessibility"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    prompt: "You are a frontend developer. Build the UI and connect it to the backend APIs.",
  },
  {
    id: "test", name: "Tina", role: "test", title: "QA Tester", model: "sonnet",
    look: { skin: "#f9dcc4", hair: "#7a4b2a", hairStyle: "long" },
    skills: ["test-planning", "e2e-testing", "bug-reporting"],
    tools: ["Read", "Write", "Bash", "Grep"],
    prompt: "You are the tester. Write test cases from the acceptance criteria, run them and report bugs.",
  },
  {
    id: "devops", name: "Duc", role: "devops", title: "DevOps Engineer", model: "sonnet",
    look: { skin: "#e8b98f", hair: "#222222", hairStyle: "short" },
    skills: ["ci-cd", "docker", "deploy-preview"],
    tools: ["Read", "Write", "Edit", "Bash"],
    prompt: "You are DevOps. Set up CI/CD, containers and deploy builds to the preview environment.",
  },
];
