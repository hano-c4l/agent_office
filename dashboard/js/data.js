// Default staff roster, tool catalog and the demo scenario.
// Demo mode uses this mock data. Live mode (live.js) loads staff from .claude/agents/*.md via the server.

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

const DEFAULT_REQUEST = "Build a TODO web app with login and shared lists";

const CORE_IDS = ["pm", "ba", "sa", "leader", "dev_be", "dev_fe", "test", "devops"];

// Builds the demo timeline for the approved team. Each step is processed by app.js runStep().
// Steps for core roles that are not on the team are skipped at run time;
// extra roles (designer, mobile, data, security, custom hires) get generic tasks.
function buildScenario(agents = []) {
  const s = [];
  const teamIds = new Set(agents.map((a) => a.id));
  const extras = agents.filter((a) => !CORE_IDS.includes(a.id) && a.id !== "customer");
  const extraTasks = extras.map((a, i) => ({ id: `T${8 + i}`, title: `${a.title} deliverables`, owner: a.id }));
  const say = (who, to, text, extra = {}) => s.push({ who, to, text, status: "talking", ...extra });
  const act = (who, status, log, extra = {}) => s.push({ who, status, log, ...extra });
  const work = (who, task, points, logs = [], files = []) => {
    points.forEach((p, i) => s.push({
      who, status: "working", progress: { task, value: p },
      log: logs[i], file: files[i],
    }));
  };

  say("customer", "pm", "Hi team! " + "{request}");
  act("pm", "thinking", "Reading the customer request");
  act("pm", "thinking", "Drafting the project plan", {
    createTasks: [
      { id: "T1", title: "Clarify requirements", owner: "ba" },
      { id: "T2", title: "Design architecture", owner: "sa" },
      { id: "T3", title: "Review architecture", owner: "leader" },
      { id: "T4", title: "Implement REST API", owner: "dev_be" },
      { id: "T5", title: "Implement web UI", owner: "dev_fe" },
      { id: "T6", title: "Test plan & E2E tests", owner: "test" },
      { id: "T7", title: "CI/CD & preview deploy", owner: "devops" },
      ...extraTasks,
    ].filter((t) => teamIds.has(t.owner)),
    file: "docs/plan.md",
  });
  say("pm", "ba", "Bao, please clarify the business rules first.", { start: "T1" });
  act("ba", "thinking", "Reviewing the request for unclear points");
  work("ba", "T1", [30], ["Wrote first user stories"], ["docs/user-stories.md"]);
  s.push({
    who: "ba", status: "waiting",
    ask: {
      question: "Can a shared list be edited by everyone, or only viewed?",
      options: ["Everyone can edit", "View only", "Owner decides per member"],
    },
  });
  work("ba", "T1", [70, 100], ["Updated acceptance criteria with your answer", "Requirements confirmed"], ["docs/acceptance-criteria.md"]);
  say("ba", "pm", "Requirements are clear. Acceptance criteria are ready.", { setStatus: { ba: "idle" } });

  say("pm", "sa", "Sora, please design the architecture.", { start: "T2" });
  work("sa", "T2", [25, 55, 85, 100],
    ["Compared stacks: Node + Postgres vs Supabase", "Drew system diagram", "Defined API contracts", "Architecture doc done"],
    ["docs/tech-options.md", "docs/architecture.md", "docs/api-contract.yaml"]);
  say("sa", "leader", "Leo, architecture draft is ready for review.", { start: "T3", setStatus: { sa: "idle" } });
  work("leader", "T3", [50], ["Reviewing auth flow and data model"]);
  say("leader", "sa", "Please add rate limiting to the login API.", { setStatus: { sa: "working" } });
  say("sa", "leader", "Added. Contract updated.", { file: "docs/api-contract.yaml", setStatus: { sa: "idle" } });
  work("leader", "T3", [100], ["Architecture approved"]);
  say("leader", "pm", "Architecture approved. Devs can start.", { setStatus: { leader: "idle" } });

  say("pm", "dev_be", "Kai, start the REST API.", { start: "T4" });
  say("pm", "dev_fe", "Nana, start the web UI.", { start: "T5" });
  say("pm", "test", "Tina, prepare the test plan.", { start: "T6" });
  extras.forEach((a, i) => {
    const task = extraTasks[i];
    say("pm", a.id, `${a.name}, please start on ${task.title.toLowerCase()}.`, { start: task.id });
    work(a.id, task.id, [35, 70, 100],
      [`Started ${task.title.toLowerCase()}`, "Shared progress with the team", "Finished and handed over"],
      [`docs/${a.id}/notes.md`]);
    say(a.id, "pm", "My part is done.", { setStatus: { [a.id]: "idle" } });
  });
  work("dev_be", "T4", [15], ["Scaffolded Express project"], ["api/src/server.ts"]);
  work("dev_fe", "T5", [15], ["Scaffolded React app"], ["web/src/App.tsx"]);
  work("test", "T6", [20], ["Wrote test cases from acceptance criteria"], ["tests/test-plan.md"]);
  say("dev_be", "ba", "What is the max length of a todo title?");
  say("ba", "dev_be", "200 characters, trimmed. Empty titles are not allowed.", { setStatus: { ba: "idle" } });
  work("dev_be", "T4", [40, 65], ["Built auth endpoints", "Built list & todo endpoints"], ["api/src/auth.ts", "api/src/todos.ts"]);
  work("dev_fe", "T5", [40, 65], ["Built login screen", "Built list view"], ["web/src/Login.tsx", "web/src/ListView.tsx"]);
  say("pm", "devops", "Duc, please set up CI and the preview environment.", { start: "T7" });
  work("devops", "T7", [30, 60], ["Wrote Dockerfiles", "Configured CI pipeline"], ["Dockerfile", ".github/workflows/ci.yml"]);
  work("dev_be", "T4", [90], ["Added rate limiting"], ["api/src/rateLimit.ts"]);
  work("dev_fe", "T5", [90], ["Connected UI to API"], ["web/src/api.ts"]);
  work("test", "T6", [50], ["Ran E2E suite: 1 failure"], ["tests/e2e/lists.spec.ts"]);
  say("test", "dev_fe", "Bug: shared list does not refresh after a member edits it.", { status: "talking" });
  act("dev_fe", "thinking", "Investigating refresh bug");
  work("dev_fe", "T5", [100], ["Fixed refresh with polling"], ["web/src/ListView.tsx"]);
  say("dev_fe", "test", "Fixed, please re-test.", { setStatus: { dev_fe: "idle" } });
  work("dev_be", "T4", [100], ["API complete, docs generated"], ["api/README.md"]);
  work("test", "T6", [80, 100], ["Re-ran E2E suite", "All 42 tests pass"]);
  say("test", "pm", "All tests pass.", { setStatus: { test: "idle", dev_be: "idle" } });
  work("devops", "T7", [100], ["Deployed to preview"], ["deploy/preview.yaml"]);
  say("devops", "pm", "Build is live on preview.", { setStatus: { devops: "idle" } });
  say("pm", "customer", "Your project is ready on preview! Please review.", { setStatus: { pm: "idle" }, done: true });
  return s;
}
