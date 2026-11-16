# Agent Office: project status

Last updated: 2026-11-17. Production (`main`) contains PR #1, #2 and the release PR #3.

## What works

| Area | State |
|---|---|
| Company dashboard | Floor plan of departments, room view, live updates over SSE, demo mode (`?demo`) |
| Departments | New project, Open department, Migrate project, Close department, folder picker |
| Git per department | `main` and `preview` created and pushed; the team works on `feature_<name>` branches from `preview`; **Release to main** from the dashboard |
| Migration | Latest code goes to `main` and `preview`; office config waits on `feature_office_migration` until **Confirm migration**; existing Claude agents become staff or assistants; documentation folders are read first |
| PM workflow (`/office`) | Team proposal and approval, planning, delegation, commits per task, merge into `preview`, onboarding of existing projects |
| Agents and skills | Written by the PM in the current Claude Code format (`templates/roles.json` is a reference); staged in `.office/team/` and installed by the server; automatic session reload after new agents |
| HR | Edit profiles, dismiss, assistants, **+ Hire staff** in Manual or Auto (PM designs the role, hire proposal to approve) |
| Looks | Random names (Vietnamese and international), genders and pixel looks; room looks generated from a seed (layouts, furniture, lounges, decoration, palettes) |
| Customer channel | Client desk, Messages and Activity tabs, "Needs your reply" markers, chat runs can be taken over from the dashboard |
| Runner | Claude CLI in print mode, allowed and blocked tools in `office/runner.json`, up to two PM runs in parallel |

## Tested with real runs

All on Windows 11 with the Claude CLI logged in to a Pro account. Costs are the API-equivalent amounts reported by the CLI.

| Scenario | Result |
|---|---|
| New project from the dashboard (static counter page, PM on sonnet) | Team proposed and approved, feature branch, one commit per task, merged into `preview`, `main` untouched; about $1.58 |
| Migration with a `docs/` folder and two existing agents (PM on sonnet) | Office config only on `feature_office_migration`; one agent as staff, one as assistant; PM wrote the overview from the docs without an analyst; about $0.19; **Confirm migration** merged into `preview` |
| Migration without docs (earlier version) | PM created a `code_analyst` agent (haiku), reloaded, delegated T0, proposed a team |
| Open department | Removed department reopened with team, tasks and history |
| Hire staff, Manual | Nothing created on Cancel; created on **Hire** |
| Hire staff, Auto | Hire proposal (no files), approval, PM wrote the agent and a skill, setup task on the board; about $0.64 |
| Release to main and pushes | Tested against a local bare repository standing in for the remote |
| Dashboard | Room randomize, staff randomize, task board filters, Messages/Activity split, narrow screens without horizontal scroll |

## Known limits

- **Office files are copied at creation.** The `/office` skill, hooks and CLAUDE.md section in a workspace stay at the
  version installed when the department was created. Existing departments do not get later improvements (for example
  setup tasks or docs-first onboarding) until the files are updated by hand. There is no "update office files" button yet.
- **"The PM never starts work you did not ask for"** was added after a test where the PM invented a request after an
  onboarding approval. The rule is in the skill and in the approval message, but that exact path has not been re-run.
- **Assistants round trip**: moving a person to the assistants and back gives them a new random name and look.
- **Chat runs** need the dashboard server running so the PM's agent files are installed; in chat the customer may have to
  reply "continue" for new agents to load.
- **Role catalog access**: the PM reads `templates/` through `--add-dir`; only the skill text tells it not to edit the catalog.
- **Permissions in dashboard runs** depend on `office/runner.json` patterns; tools outside the list are denied (for
  example a headless browser), and the PM reports it instead of retrying.
- **Parallel runs**: the two-run limit and queue were not exercised with real concurrent runs.
- **Platforms**: only tested on Windows. macOS and Linux should work (Node and git only) but are untested.
- **No automated tests** for Agent Office itself; checks so far are manual and through real runs.

## Next steps (suggested)

1. A button to update the office files (skill, hooks, CLAUDE.md section) in existing departments, committed on a feature branch.
2. Keep the name and look when an assistant moves back to the staff.
3. Git account settings and creating the remote repository from the dashboard.
4. Animations for agents talking to each other (walking to the meeting table, handing over tasks).
5. Automated tests for the server (setup, migration, proposals, runner queue) and a smoke test for the dashboard.
