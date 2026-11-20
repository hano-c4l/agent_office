# agent_office
Agent simulate office

A virtual software company made of Claude Code agents. Every **department** is one project with its own
workspace folder, git repository and team. A pixel-art dashboard shows the whole company floor, lets you walk
into each department's room, talk to its PM and manage the staff like HR.

For the current state of the project (what works, what was tested, known limits, next steps) see
[docs/status.md](docs/status.md).

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

Server modules:

| Module | Job |
|---|---|
| `server/office-server.mjs` | HTTP server: static dashboard, REST API, SSE stream, folder picker API |
| `server/departments.mjs` | Department registry, file polling, team and hire proposals, migration confirm, release |
| `server/workspace-setup.mjs` | New, open and migrate setup, git branches and remote, office files, folder listing |
| `server/run-controller.mjs` | Runs the PM through the Claude CLI, queues messages, limits parallel runs, auto-reload |
| `server/staff-store.mjs` | Agent files and staff display data, assistants, installing staged agents and skills |
| `server/people.mjs` | Random names and looks |
| `server/http-guard.mjs` | Refuses API requests that do not come from the dashboard (other sites, rebound host names) |

Dashboard scripts: `dashboard/js/pixel.js` draws rooms and characters, `scenes.js` plays the scenes in the open room
(break walks, tasks flying between desks, confetti) and `app.js` holds the state, the API calls and the rest of the UI.

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

   `npm start` does the same; `npm test` runs the server tests (they need git and work in temporary folders).

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

### Company floor
- Every department is a room with its staff at their desks. Badges and the top bar show who needs you.
- **+ Department** adds a department (see Run). **Close department** takes one off the dashboard; its folder and
  repository stay on disk, so you can open it again.

### Room
- **Room look**: generated from a seed: desk layout (rows, cubicles, facing pods, long bench, staggered rows, shared
  desks for two), manager corner on the left or right, one of 10 lounges (meeting table, sofa and TV, ping-pong,
  round table, kitchen, reading corner, indoor garden, gaming corner, nap pods, band corner), up to five of 40 wall
  decorations (eight paintings, pin board, roadmap, dartboard, string lights, world clocks, guitar, mirror...), four
  of 23 floor items (coffee machine, aquarium, arcade, table football, treadmill, massage chair, speaker, snack shelf,
  the office cat or dog, a bird cage...), a shelf and a cabinet in the manager's corner, a cleaning robot, chair models
  and one of eight color palettes. The floor is one open space: no rugs mark the areas. **🎲 Room** (top left of the
  room) picks a new look.
- **Click any decoration** (a picture, the lounge, a floor item, the manager's shelf or cabinet, the pet or the
  cleaning robot) to see it in the side panel: what it is, what staff do there, and who is there now. Its **🎲**
  swaps it for another item that fits the same place; what staff do there changes with it (a sofa to sit on becomes
  a band corner to play in). Swapped items are saved with the department; **🎲 Room** starts over without them.
- **Desks differ from person to person**: shape (panel, open legs, trestle, rounded, curved, L-shape on either side,
  with drawers, two pedestals, hairpin legs, wave front, round end, on wheels, on crates), width, material (the room's,
  birch or a glass top), computer (laptop, monitor, side screen, two screens, tablet), drink (mug, tea, takeaway cup,
  glass, bottle, can, bubble tea, or none) and a personal thing (photo, lamp, plant, books, rubber duck, robot, fan,
  sticky notes, globe) or the role's own prop. The staff panel says what is on the desk; the desk button next to
  **🎲** gives that person a new random desk.
- **The PM stands out**: a navy blazer with a gold tie and pin, a headset, an executive desk (panelled, glass on
  chrome, curved, white lacquer, antique or with a side wing) with a name plate and two screens, a high-backed chair
  (brown or black leather, a wing chair, white and gold), and a gold star on the name tag.
- The windows show the real time of day (day, sunset, night), and the furniture moves: fish swim, screens update, the
  coffee machine steams, the cat flicks its tail.
- **Character states**, each a small scene. People have habits, so the same state looks different from desk to desk:
  - **Working**: fast typing and a glowing screen, with sparks, code in a bubble or a keyboard on fire; a desk lamp lights up.
  - **Thinking**: thought bubble and a light bulb, floating question marks, or reading a document held up.
  - **Talking** (delegating): moving mouth, sound waves and a speech bubble; the task flies as a note to the person
    who gets it, and their report flies back to the PM.
  - **Needs you**: raised, waving hand with **!**, a red beacon on the desk and a blinking name tag.
  - **Idle**: coffee (with a sip now and then), a nap, music, the phone, stretching or daydreaming.
  - **Queued**: hourglass, while the department waits for a free run slot.
  - **Error**: red screen, smoke from the computer, a worried face and a drop of sweat.
  - **Delivered**: the whole team cheers under confetti with a grin and a trophy; the PM keeps the check mark.
  - **Joining**: faded, with a moving box on the desk (approved, profile not written yet).
  - **What they do right now** flashes over the head for a moment: terminal, search, pencil, book or globe for the
    tool in use, a red cross for a failed command, a star for a finished task.
- **Breaks use the room**: idle people walk to a place and use it. They sit on the sofa (the TV turns on), at the
  meeting or round table, on the kitchen stools, the garden bench, the armchair or the beanbags; play ping-pong (a
  ball flies over the table) or the arcade; wait at the coffee machine and come back with a mug; pet the cat; or step
  out through the sliding door. Sometimes two to four people take the break together and chat in the lounge.
  Everybody comes straight back when work arrives.
- **The room has a life of its own**: a cleaning robot (vacuum, mop or drone) crosses the floor, the office pet leaves
  its bed for a walk, and a courier brings a parcel to the PM's desk now and then.
- The line under the room counts who is doing what. Scenes stop when your system asks for reduced motion.
- **Client desk**: send a request or reply to the PM. **Messages** holds what you read or answer (your messages, the
  PM's replies, approvals, errors) with "Needs your reply" on the PM's open question; **Activity** holds the team's
  work (tools, delegation, reports). The messages are saved in the workspace (`.office/messages.jsonl`), so they are
  still there after the server restarts.
- **⚙ Settings** (room header): options per department.
  - **Auto continue after the usage limit resets** (default OFF): when the PM stops on a usage limit such as the 5-hour
    limit, the server reads the reset time from the Claude CLI, waits until a minute after it and tells the PM to
    continue in the same session. Messages you sent meanwhile follow. The planned time survives a server restart, a
    message from you or **Stop** replaces it, and without a known reset time it tries again every 30 minutes (12
    tries, six hours, longer than a 5-hour window). The server must keep running; the room shows "Usage limit, continues HH:MM".
- **Task board**: search, filter by owner, scrolling columns; Done shows the latest five until you expand it.
  Setup work by the PM (writing the PM profile, creating the team, writing skills) shows as `S` tasks.
- **Release to main** merges `preview` into `main`; **Confirm migration** appears while a migrated project waits.
- **Update office files** appears when a department still has the hooks, `/office` skill or CLAUDE.md section of an
  older Agent Office version. It installs the current ones and commits only those files on the current branch (not on
  `main`); your agents and their skills are not touched.

### Staff (HR)
- Click a character for progress, tasks (open first, finished ones collapsed), recent activity and files.
- **🎲** next to the avatar gives a new random name and look. Characters have a random gender, hair style, headwear,
  eyewear, eyes, mouth, outfit and face details, plus a role accessory.
- **Details** edits the profile (name, title, role, model, description, skills, tools, responsibilities). Skills shown
  dashed do not exist yet; the PM writes them on its next turn. **Make assistant** moves the person to the assistants
  (helper agents that get no tasks; they keep their name and look if they come back); **Dismiss** moves the profile to
  `.office/dismissed/`.
- **+ Hire staff**: nobody joins until you confirm.
  - **Auto**: describe who you need; the PM designs the role and sends a hire proposal. Press **Hire** to approve,
    then the PM writes the profile and skills.
  - **Manual**: fill in the profile yourself; the person joins when you press **Hire**.

## Claude CLI for dashboard runs

- Install: `irm https://claude.ai/install.ps1 | iex` (Windows) and log in once with `claude auth login`.
  The server finds `~/.local/bin/claude(.exe)` even when it is not on PATH, or set `claudePath` in `office/runner.json`.
- Nobody can answer permission prompts in a dashboard run. `office/runner.json` lists the tools the team may use
  (`allowedTools`) and the ones that are always blocked (`disallowedTools`, for example pushing to `main`).
  Anything else is denied and the PM reports it.
- `maxParallelRuns` (default 2) limits how many departments run at the same time; others wait in a queue.
- Git pushes use the git credentials already set up on this machine.
- The server listens on `127.0.0.1` only and answers API calls only from the dashboard itself: requests from other
  web sites, or through a host name that is not localhost, are refused. Stopping the server stops running PM turns.

### Remote access (Cloudflare Tunnel)

The server still listens on `127.0.0.1` only; a tunnel running on the same machine forwards to it. List the public
host name in `office/server.json` (`{"allowedHosts": ["office.hanowl.com"]}`) or set `ALLOWED_HOSTS` (comma separated), then
restart the server. The API has no login of its own: keep **Cloudflare Access** in front of the host name, and never
expose the port directly. Point the tunnel at `http://127.0.0.1:5178` and keep the original Host header (the default).

The live stream (`/api/stream`) is sent uncompressed and unbuffered (`Cache-Control: no-transform`,
`X-Accel-Buffering: no`) with a ping every 15 seconds. A dashboard that hears nothing for 40 seconds reconnects and
reloads the whole state, history included, and shows **RECONNECTING…** meanwhile. Opened through the tunnel, the
dashboard never falls back to demo mode; when the Cloudflare Access sign-in expires, reload the page to sign in again.

### Demo mode

Open http://localhost:5178/?demo (or serve `dashboard/` with any static server) to see sample departments
with simulated activity: four rooms with different looks (working, waiting for you, delivered, somebody joining).
Nothing is saved in demo mode.
