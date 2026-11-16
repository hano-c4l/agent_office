# agent_office
Agent simulate office

A virtual software company made of Claude Code agents. Every **department** is one project with its own
workspace folder, git repository and team. A pixel-art dashboard shows the whole company floor, lets you walk
into each department's room, talk to its PM and manage the staff like HR.

## How it fits together

| Part | Where |
|---|---|
| Company dashboard + API + live stream | `server/office-server.mjs` serving `dashboard/` |
| Registered departments (local paths, repos) | `office/departments.json` (ignored by git) |
| Runner settings (CLI path, allowed tools, parallel runs) | `office/runner.json` |
| Role catalog (reference only, never copied) | `templates/roles.json` |
| Office infrastructure installed into every workspace | `templates/workspace/` (hooks, `/office` skill, settings, CLAUDE.md section) |

Inside a department workspace:

| Part | Where |
|---|---|
| Staff and skills, written by the PM | `.claude/agents/<id>.md`, `.claude/skills/<name>/SKILL.md` |
| PM workflow | `.claude/skills/office/SKILL.md`, run with `/office <request>` |
| Activity capture | hooks in `.claude/settings.json` → `.claude/hooks/office-event.mjs` → `.office/events.jsonl` |
| Department info (name, PM model, repo) | `.office/department.json` |
| Staff names and looks (random, set by the dashboard) | `.office/staff.json` |
| Live state (tasks, team proposal, run) | `.office/` (ignored by git) |
| Team rules (language, git flow) | the Agent Office section of `CLAUDE.md` |

The Agent Office repository itself has no agents or hooks, so working on Agent Office is never logged as office activity.

### Agents are written by the PM

Agent Office does not ship agent or skill files. The PM, running with the model you chose, writes every agent and
skill in the current Claude Code format, using `templates/roles.json` only as a reference (responsibilities,
suggested models, tools and skills). Claude Code does not let a headless session write into `.claude/`, so the PM
writes them to `.office/team/` and the server installs them into `.claude/` right away. After the PM creates new
agents it ends the turn with `[[office:reload]]`; the dashboard then starts the next turn so the new agents load.

## Run

1. Start the server (Node 18+, no dependencies):

   ```bash
   node server/office-server.mjs
   ```

   Open http://localhost:5178. The badge shows **LIVE** when the server is connected.

2. Add a department with **+ Department** (tabs: New project, Open department, Migrate project). **Browse…** opens a folder picker.
   - **New project**: an empty or new folder. Agent Office creates the git repository with `main` and `preview`
     (pushed when you give an empty repository) and installs the office infrastructure.
   - **Open department**: a folder that already has Agent Office files, for example one you removed from the
     dashboard. Team, tasks and history come back.
   - **Migrate project**: an existing project. Its current code is the latest: uncommitted work is committed on the
     current branch, that branch is merged into `main` (its version wins on conflicts) and `preview` is created or
     updated from `main`. The office config goes to a separate `feature_office_migration` branch; press
     **Confirm migration** in the room to merge it into `preview` (and `main` only gets it with **Release to main**).
     - **Documentation folders** (default `docs`): the PM and the analyst read these and the README first. When they
       explain the project well enough, the PM writes `docs/office-overview.md` from them without reading the whole source;
       otherwise an analyst agent reads only what the documents do not answer.
     - **Existing agents** in `.claude/agents` are listed: tick the ones that become staff. The others stay
       **assistants** (helper agents such as web search) that the team may call but that never get tasks; **Move to staff** promotes one later.
     - Then the PM proposes the team from the overview and waits for your request.
3. The PM proposes a team. Every new member gets a random name, gender and look. Review it in the room
   (untick members, change models, add catalog roles), then **Approve team**. The PM writes the agents and continues.
   The PM never starts work you did not ask for: without a request it asks you what to build.
4. The PM plans, creates a `feature_<name>` branch from `preview`, delegates tasks, commits each finished task and,
   when the work is tested, merges it into `preview` and pushes. Answer questions at the client desk.
5. **Release to main** in the room merges `preview` into `main` and pushes it. The team never touches `main`.

You can also open Claude Code in a workspace and run `/office <request>` there (keep the server running so new agents
are installed). The dashboard shows that run too and can take it over (**Take over & send**).

## Dashboard

- **Company floor**: every department is a room with its staff at their desks. Badges show who needs you.
- **Room look**: generated from a seed: desk layout (rows, cubicles, facing pods, long bench), manager corner on the
  left or right, lounge (meeting table, sofa and TV, ping-pong, round table), desk and chair models, wall decoration,
  floor items (vending machine, aquarium, arcade, printer, beanbags...) and one of eight color palettes.
  **🎲 Room** (top left of the room) picks a new look.
- **Characters**: random gender, hair style, headwear, eyewear, eyes, mouth, outfit and face details, plus role
  accessories. **🎲** next to the avatar in the details panel gives a new random name and look.
- **Make assistant** in Details moves a staff member to the assistants (helper agents that get no tasks).
- **+ Hire staff** opens a dialog; nobody joins until you confirm.
  - **Auto**: describe who you need; the PM designs the role and sends a hire proposal. Press **Hire** to approve, then
    the PM writes the agent file and skills (shown as a setup task on the board).
  - **Manual**: fill in the profile yourself; the agent is created when you press **Hire**.
- Setup work by the PM (writing the PM agent, creating the team, writing skills) shows on the task board as `S` tasks.
- **Messages / Activity**: Messages holds what you read or answer (your messages, the PM's replies, approvals,
  errors) with "Needs your reply" on the PM's open question; Activity holds the team's work (tools, delegation, reports).
- **Room**: click a character for progress, tasks (open first, finished ones collapsed), recent activity and files.
  **Details** edits the employee; skills shown dashed do not exist yet and the PM writes them on its next turn.
  **Dismiss** moves the agent file to `.office/dismissed/`.
- **Task board**: search, filter by owner, scrolling columns; Done shows the latest five until you expand it.
- Character states: typing (working), thought bubble (reading/thinking), speech bubble (delegating),
  raised hand with **!** (needs your answer), mug with steam (idle), check mark (project delivered),
  faded with "joining" (approved, agent file not written yet).
- **Close department** takes it off the dashboard; its folder and repository stay on disk, so you can open it again.

## Claude CLI for dashboard runs

- Install: `irm https://claude.ai/install.ps1 | iex` (Windows) and log in once with `claude auth login`.
  The server finds `~/.local/bin/claude(.exe)` even when it is not on PATH, or set `claudePath` in `office/runner.json`.
- Nobody can answer permission prompts in a dashboard run. `office/runner.json` lists the tools the team may use
  (`allowedTools`) and the ones that are always blocked (`disallowedTools`, for example pushing to `main`).
  Anything else is denied and the PM reports it.
- `maxParallelRuns` (default 2) limits how many departments run at the same time; others wait in a queue.
- Git pushes use the git credentials already set up on this machine.

### Demo mode

Open http://localhost:5178/?demo (or serve `dashboard/` with any static server) to see sample departments
with simulated activity. Nothing is saved in demo mode.
