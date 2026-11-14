## Background tasks
- Before reporting work as done, check for background tasks you started. If one is not needed for what comes next, stop it, and say in the report which ones you stopped and which you kept (with the reason).

## Git
- The `main` branch is the production branch. Code lands here only after it is finished and confirmed OK on preview.
- The `preview` branch is the testing branch. New and changed features are tested here before moving to production.
- When starting a new task, create a `feature_xxx` branch from the `preview` branch.
- When a task is finished and the user says "PR into preview", create a PR from that feature branch into `preview`, merge it right away, and run the deploy/migration for preview if there is one.
- Likewise, when the user says "PR into production", create a PR from `preview` into `main`, merge it, and run the deploy/migration for production if there is one.

## Agent Office runs
- Each department (project) has its own workspace folder and git repository: anywhere on disk, or under `workspace/` here, which git ignores. The Git rules above are for developing Agent Office itself, not for those projects; each workspace has its own rules in its `CLAUDE.md`.
- The `/office` skill, hooks and settings in `templates/workspace/` are installed into each workspace, not loaded in this repository. `templates/roles.json` is only a reference catalog: each department's PM writes its own agents and skills.

## Language
- The user chats and gives requests in Vietnamese or English, so reply to the user in Vietnamese.
- Everything inside the source code (variables, functions, comments, messages, logs, etc.) must always be written in English.
