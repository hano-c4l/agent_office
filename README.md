# agent_office
Agent simulate office

A virtual software team made of Claude Code agents (PM, BA, SA, Tech Leader, Developers, Tester, DevOps),
with a chibi-style dashboard to watch how they work together and manage the staff like HR.

## How it fits together

| Part | Where |
|---|---|
| Staff (role, model, tools, skills, responsibilities) | `.claude/agents/<id>.md` |
| Staff display data (name, title, chibi look) | `office/staff.json` |
| Role skills | `.claude/skills/<skill>/SKILL.md` (created automatically for every skill an agent lists) |
| PM workflow | `.claude/skills/office/SKILL.md`, run with `/office <request>` |
| Activity capture | Hooks in `.claude/settings.json` → `.claude/hooks/office-event.mjs` → `office/events.jsonl` |
| Team proposal / task board | `office/proposal.json`, `office/tasks.json` (written by the PM) |
| Dashboard + HR API + live stream | `server/office-server.mjs` serving `dashboard/` |
| Project output | `workspace/<project>/` (ignored by git) |

## Run a project

1. Start the dashboard server (Node 18+, no dependencies):

   ```bash
   node server/office-server.mjs
   ```

   Open http://localhost:5178. The badge shows **LIVE** when the server is connected.

2. Start the project in either place:
   - **From the dashboard**: type the request at the client desk and press **Start project**. The server runs
     the PM through the Claude CLI (`claude -p "/office ..."`) and resumes the same session for every reply.
   - **From Claude chat**: open a **new** Claude Code session in this folder (hooks and agents load when a
     session starts) and run `/office Build a TODO web app with login and shared lists`.
3. Mira (PM) proposes a team. Review it on the dashboard: untick members, change models, add roles, then
   **Approve team**. A dashboard run continues by itself; for a chat run, reply `ok` in chat.
4. The PM plans tasks and delegates them to the office agents. Answer the PM's questions in the dashboard
   box or in chat. A chat run can be taken over from the dashboard (**Take over & send**); after that, its
   messages no longer show in the chat window.

### Claude CLI for dashboard runs

- Install: `irm https://claude.ai/install.ps1 | iex` (Windows) and log in once with `claude auth login`.
  The server finds `~/.local/bin/claude(.exe)` even when it is not on PATH, or set `claudePath` in `office/runner.json`.
- Nobody can answer permission prompts in a dashboard run. `office/runner.json` lists the tools the team may use
  without asking (`allowedTools`, `permissionMode`); anything else is denied and the PM reports it.
- The dashboard shows the run cost reported by the CLI.

## Dashboard

- **Click a character**: progress, tasks, recent activity and files touched.
- **Details**: edit the employee (name, role, model, description, skills, tools, responsibilities).
  In live mode **Save** writes `.claude/agents/<id>.md`. **Dismiss** moves the file to `office/dismissed/`.
- **Hire agent**: create a new employee file.
- Hook events are only recorded while an office run is active (`office/active-run.json`) or when they come
  from an office agent, so normal coding sessions in this repo are not logged.

### Demo mode

Open http://localhost:5178/?demo (or serve `dashboard/` with any static server) to run the scripted demo
with mock data. HR edits in demo mode stay in the browser's localStorage.
