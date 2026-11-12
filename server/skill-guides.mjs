// Starter guidance for role skills. A missing skill folder is created from this map
// (or a generic template) so every skill listed in an agent file exists in .claude/skills/.

export const SKILL_GUIDES = {
  "planning": "Restate the goal in one sentence.\n- Break the work into phases: clarify, design, build, test, deliver.\n- Identify dependencies so independent tasks can run in parallel.",
  "task-breakdown": "Each task has one owner, a clear output (a file or a passing test) and fits in one agent run.\n- Name tasks with a verb: \"Implement login API\".\n- Split anything that needs two roles into two tasks.",
  "risk-tracking": "Keep a short list of risks: unclear requirements, new technology, external services, security.\n- For each risk note the impact and the mitigation.",
  "status-report": "Report in this order: done, in progress, blocked, next.\n- Mention what the customer needs to decide.",
  "requirements-analysis": "List actors, goals and main flows.\n- For each flow list business rules and edge cases.\n- Every unclear rule becomes an open question with options and a recommended default.",
  "user-stories": "Format: As a <actor>, I want <goal>, so that <value>.\n- Keep each story small enough to build and test in one task.",
  "acceptance-criteria": "Use Given / When / Then.\n- Cover the happy path, validation errors and permission rules.\n- Every criterion must be testable.",
  "system-design": "Start from requirements and constraints, then pick the simplest architecture.\n- Describe components, data flow and storage.\n- Note scaling and failure points only where they matter.",
  "tech-selection": "Compare at most 3 options on fit, simplicity, team familiarity and cost.\n- Prefer boring, well-documented technology.",
  "api-contracts": "For each endpoint: method, path, request body, response body, error codes, auth.\n- Use consistent naming and pagination.",
  "security-review": "Check authentication, authorization, input validation, secrets handling and rate limiting.\n- Reference OWASP Top 10 categories when you report.",
  "code-review": "Prioritize findings: must fix, should fix, nice to have.\n- Give file and line references and a concrete suggestion.",
  "tech-decisions": "Write decisions as short ADRs: context, decision, consequences.",
  "mentoring": "Explain the why behind feedback so the developer can apply it next time.",
  "nodejs": "Use modern ESM syntax, async/await and clear error handling.\n- Keep configuration in environment variables.",
  "rest-api": "Validate every input, return proper status codes and a consistent error shape.\n- Write tests for business rules.",
  "database": "Design tables from the data model, add indexes for frequent queries, and use migrations.",
  "react": "Use function components and hooks.\n- Keep state close to where it is used.\n- Handle loading, empty and error states.",
  "ui-components": "Build small reusable components with clear props.\n- Keep spacing and typography consistent.",
  "accessibility": "Use semantic HTML, labels for inputs, keyboard navigation and sufficient color contrast.",
  "test-planning": "Map every acceptance criterion to at least one test case.\n- Include edge cases and negative tests.",
  "e2e-testing": "Automate the main user flows end to end.\n- Keep tests independent and data self-contained.",
  "bug-reporting": "Title, steps to reproduce, expected, actual, severity, evidence.",
  "ci-cd": "Pipeline: install, lint, test, build. Fail fast. Cache dependencies.",
  "docker": "Small images, multi-stage builds, non-root user, explicit versions.",
  "deploy-preview": "Prepare preview deploy configuration and document the steps.\n- Never use real credentials without customer approval.",
};

export function skillMarkdown(name) {
  const guide = SKILL_GUIDES[name] ||
    "Describe how to apply this skill here: steps, checklists and examples.\n- This file was created automatically by Agent Office; edit it to add real guidance.";
  return [
    "---",
    `name: ${name}`,
    `description: Agent Office role skill "${name}". Preloaded into office agents that list it; not meant for direct use.`,
    "user-invocable: false",
    "---",
    `# ${name}`,
    "",
    `- ${guide}`,
    "",
  ].join("\n");
}
