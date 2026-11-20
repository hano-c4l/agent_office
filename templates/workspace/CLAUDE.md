<!-- agent-office:start -->
# {{DEPARTMENT}} (Agent Office department)

This repository is a department of Agent Office. A virtual team of Claude Code agents builds the product here:
the PM runs the `/office` skill, proposes a team, and delegates work to the agents in `.claude/agents/`.
The Agent Office dashboard watches this folder and lets the customer follow and steer the work.

## Office files
- `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`, `.claude/settings.json`: the team and its tools.
  Only the PM and the dashboard change them.
- `.office/`: live office state (events, tasks, team proposal, staff names and looks). Ignored by git.

## Subagents
- Use `{{TOOL_search}}` for repo maps, `{{TOOL_grep}}` for call sites, and `{{TOOL_docs}}` for API documentation. All three are read-only Haiku agents.
- They are assistants, not staff: they never get tasks on the board. Any team member may call them instead of reading
  many files with a bigger model.

## Language
- Talk to the customer in Vietnamese.
- Everything in the repository (code, comments, docs, commit messages, logs) is in English.

## Git
- `main` is production. Code reaches `main` only when the customer releases it from the dashboard.
  Never commit to, merge into or push `main` yourself.
- `preview` is the testing branch. Finished, tested work is merged here and pushed.
- For each request, the PM creates one `feature_<short-name>` branch from `preview`; the whole team works on it.
- Only the PM runs git commands that change the repository (commit, checkout, merge, push). Other agents only edit files.
- The PM commits after each finished task with a clear English message, for example `T3: Add login API`.
- When the work is done and tested: merge the feature branch into `preview` with `--no-ff` and push `preview`{{REMOTE_NOTE}}.
- Never force-push, rewrite history or delete branches.
<!-- agent-office:end -->
