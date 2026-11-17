# Agent Office: project status

Last updated: 2026-11-18. Production (`main`) contains PR #1 to #5. `preview` also contains the system review and
room polish (PR #6) and the second room update (PR #7), neither released to `main` yet. The third room update
(swappable room items, more desks and decoration) is on the branch `feature_room_items`, not merged yet.

## What works

| Area | State |
|---|---|
| Company dashboard | Floor plan of departments, room view, live updates over SSE, demo mode (`?demo`) |
| Departments | New project, Open department, Migrate project, Close department, folder picker |
| Git per department | `main` and `preview` created and pushed; the team works on `feature_<name>` branches from `preview`; **Release to main** from the dashboard |
| Migration | Latest code goes to `main` and `preview`; office config waits on `feature_office_migration` until **Confirm migration**; existing Claude agents become staff or assistants; documentation folders are read first |
| PM workflow (`/office`) | Team proposal and approval, planning, delegation, commits per task, merge into `preview`, onboarding of existing projects |
| Agents and skills | Written by the PM in the current Claude Code format (`templates/roles.json` is a reference); staged in `.office/team/` and installed by the server; automatic session reload after new agents |
| Office files update | A department with older hooks, `/office` skill or CLAUDE.md section shows **Update office files**; the update is committed on the current branch |
| HR | Edit profiles, dismiss, assistants (they keep their name and look), **+ Hire staff** in Manual or Auto (PM designs the role, hire proposal to approve) |
| Looks | Random names (Vietnamese and international), genders and pixel looks (14 or 15 hair styles per gender, 16 outfits, accessories, three builds, dyed hair tips, headwear, eyewear); rooms generated from a seed: 6 desk layouts, 10 lounges, 40 wall decorations (up to five per room), 23 floor items, 3 manager shelves, 3 cabinets, 3 cleaning robots, 5 chair models, 8 palettes; no rugs marking the areas |
| Room items | Every decoration can be clicked: side panel with what it is, what staff do there and who is there now; 🎲 swaps it for another item that fits; the choice is saved in the department (`roomItems`) and cleared by 🎲 Room |
| Desks | Per person: 14 shapes, 4 widths, 3 materials, 6 computer setups, 8 drinks, 10 personal items; the staff panel lists them and a desk button rolls a new desk (`deskSeed` in `.office/staff.json`) |
| PM | Navy blazer, gold tie and pin, headset, 6 executive desks and 4 executive chairs, name plate and two screens, star on the name tag |
| Room scenes | One scene per status with several variants per person; short flashes for the tool in use, a failed command and a finished task; tasks and reports flying between desks; confetti on delivery; moving furniture; windows follow the time of day |
| Breaks | Idle staff walk to a place and use it: sit (sofa, tables, stools, bench, armchair, beanbags, nap pods, massage chair), play (ping-pong, arcade, table football, gaming corner, band, treadmill), coffee, pets, door; group breaks of two to four people in the lounge; cleaning robot, wandering cat or dog and a courier |
| Customer channel | Client desk, Messages and Activity tabs, "Needs your reply" markers, chat runs can be taken over from the dashboard |
| Runner | Claude CLI in print mode, allowed and blocked tools in `office/runner.json`, up to two PM runs in parallel, runs stop with the server |
| Local API safety | Bound to 127.0.0.1; refuses requests from other sites and rebound host names; writes need JSON |
| Tests | `npm test`: 15 server tests (request guard, agent files, staff store and desks, room items, scheduler, new workspace, office update, release, migration) |

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

## Checked in the review of 2026-11-17 (no PM runs)

| Check | Result |
|---|---|
| `npm test` | 14 of 14 pass (git operations run in temporary repositories) |
| Demo mode in the browser | Four rooms with different layouts; every status scene, break walks, flying tasks and reports, the joining desk and the delivery celebration seen working; no console errors; no horizontal scroll at 375 px |
| Live mode in the browser | The two local departments load; rooms and break walks render; the update banner shows for both (their office files are from an older version); a write without a JSON content type is refused with 415 |
| Room generator | 300 seeds drawn with 0, 1, 5 and 12 staff in the three sky phases without an error |

Not done in that review: no PM run was started (they cost money), and **Update office files** was not pressed on a real
department; it is covered by an automated test in a temporary repository.

## Checked for the room update of 2026-11-18 (no PM runs)

| Check | Result |
|---|---|
| `npm test` | 14 of 14 pass |
| Room generator | 400 seeds drawn with 0, 1, 4, 9 and 13 staff, cycling through every hair style, outfit, headwear, accessory and build, without an error |
| Demo mode in the browser | Seen working: varied desks and gear, the PM's look, sitting on the sofa with the TV on, a ping-pong match with the ball, two people at the meeting table, the robot vacuum, the courier, tool flashes; no console errors |

Not checked in the browser for that update: live mode with a real run, narrow screens, and the less frequent scenes
(the cat's walk, kitchen, library, garden, round table, beanbags and arcade), which share the code of the ones seen.

## Checked for the room items update of 2026-11-18 (no PM runs)

| Check | Result |
|---|---|
| `npm test` | 15 of 15 pass |
| Room generator | 300 seeds drawn; every one of the 40 wall items, 23 floor items, 10 lounges, 14 desk shapes and 6 executive desks appeared; 9514 single swaps tried, each one applied without pushing another item out of the room |
| Demo mode in the browser | Clicked the lounge, a painting, a floor item, the shelf, the cabinet and the moving cleaning robot: each opened its panel, and 🎲 swapped it (gaming corner to sofa, flower painting to exit sign, printer to office cat, trophy shelf to bookshelf, filing cabinet to safe, drone to robot vacuum); the desk button gave a person another desk; no console errors |
| Live mode in the browser | A real department loads with 12 clickable items and opens their panel |

Not checked in the browser for that update: swapping an item in live mode (the server route is covered by a test),
narrow screens, and the scenes at the new places (band, nap pods, treadmill, massage chair, the dog's walk).

## Fixed in that review

- `templates/workspace/CLAUDE.md` was not in git (the `workspace/` ignore rule also matched `templates/workspace/`),
  so a fresh clone could not create or migrate a department. The rule is now `/workspace/` and the file is tracked.
- Any web page open in the same browser could call the local API (for example start a PM run). See "Local API safety".
- Moving a person to the assistants threw away their name and look.
- A half-written event line (or multi-byte character) could be lost between two polls of `events.jsonl`.
- PM processes kept running after the server stopped.
- A folder with an unreadable entry broke the folder picker; a malformed URL answered 500 instead of 400.

## Known limits

- **Rooms changed their look.** A room is generated from its seed, and the generator has more choices now, so every
  existing room looks different after each of these updates. **🎲 Room** picks another one.
- **Desks follow the person and the room seed**: a new room look also gives everybody another desk and gear; the
  desk button only changes one person's desk within the current room.
- **Swapped items depend on the room**: they are kept per place ("the third picture", "the lounge"), so a wall item
  that no longer fits after a code update falls back to the room's own choice. Items can be swapped, not added or
  removed, and the number of pictures depends on how much wall the windows leave.
- **Clicking near people**: the click areas of decoration lie under the staff, so a picture right behind somebody's
  head opens that person instead.
- **Walking through furniture**: people on a break walk along simple paths (aisle, corridor, target) and can cross
  the edge of a desk or a name tag on the way.
- **Scenes are decoration.** Break walks, flying notes and confetti play only in the open room, not on the company
  floor, and are not shown with reduced motion. A person on a break still counts as idle.
- **Office files** are still copied, not linked: after an Agent Office update each department needs one click on
  **Update office files**. The update is not committed when the workspace is on `main`.
- **"The PM never starts work you did not ask for"** was added after a test where the PM invented a request after an
  onboarding approval. The rule is in the skill and in the approval message, but that exact path has not been re-run.
- **Chat runs** need the dashboard server running so the PM's agent files are installed; in chat the customer may have to
  reply "continue" for new agents to load.
- **Role catalog access**: the PM reads `templates/` through `--add-dir`; only the skill text tells it not to edit the catalog.
- **Permissions in dashboard runs** depend on `office/runner.json` patterns; tools outside the list are denied (for
  example a headless browser), and the PM reports it instead of retrying.
- **Parallel runs**: the scheduler is unit-tested, but the two-run limit and queue were not exercised with real concurrent runs.
- **Platforms**: only tested on Windows. macOS and Linux should work (Node and git only) but are untested.
- **Dashboard tests**: the dashboard has no automated tests; it is checked by hand in the browser.

## Next steps (suggested)

1. Git account settings and creating the remote repository from the dashboard.
2. A smoke test for the dashboard (load demo mode, open every room, no console errors) and tests for the department API.
3. Tie the lounge to real work: the PM calls a meeting at the lounge table when several people get tasks at once.
4. Break walks and status scenes on the company floor cards, lighter than in the open room.
5. Run the test suite on macOS and Linux, and exercise two real PM runs in parallel.
