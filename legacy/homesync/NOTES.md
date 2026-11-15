# HomeSync extract — how this could plug into HomeTask

This folder is a curated extract of **HomeSyncTasks**, the earlier household-wide version of HomeTask. The full HomeSyncTasks backup lives in its own archive. HomeSync as a product is parked; these files are kept only so the reusable pieces can be wired into HomeTask later if needed.

HomeTask today is a personal iPhone web app (PWA). It stores a single user's task state in `localStorage` under the key `hometask-v1` (see `artifacts/home-tasks/src/app/storage.js`). There are no accounts, no household, and no server. HomeSync is a multi-user Express + React app with Firebase Auth, a Postgres schema (Drizzle), and SendGrid invite emails. The two codebases do not share a runtime. Anything below would be a later integration, not a drop-in.

## What was extracted

### Postgres / Drizzle schema — `shared/schema.ts` and `config/drizzle.config.ts`

Seven tables, all scoped to a household:

| Table | Purpose |
|---|---|
| `users` | Profile tied to a Firebase UID (`firebaseUid`), plus email, name, phone, and notification prefs (daily / weekly / critical). |
| `households` | Named household with a unique `inviteCode` and `createdBy`. |
| `household_members` | Membership + role (join of user to household). |
| `zones` | Rooms/areas in the house. Supports a `parentZoneId` tree and an `isCustom` flag. |
| `task_templates` | Reusable chore definitions (name, category, default frequency, duration, optional per-household custom templates). |
| `tasks` | Assigned, scheduled instances: zone, assignee, frequency, `lastCompleted`, `nextDue`, notes, active flag. |
| `task_completions` | History of who completed what, and when. |

`config/homesync-package.json` is the original HomeSync `package.json`, kept so dependency versions for Drizzle, Firebase, and SendGrid are easy to look up. Environment variables HomeSync expected (names only): `DATABASE_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `SENDGRID_API_KEY`.

### Data access — `server/storage.ts`

A storage interface plus a Drizzle implementation covering users, households, invite-code lookup, members, zones, templates, tasks (including due-by-date), completions, completion stats, overdue tasks, and member performance. This is the natural backend if HomeTask ever grows a shared household mode. It would replace, not wrap, the current `localStorage` module — a migration would need to copy each personal task into a `tasks` row (and optionally a `task_templates` row) for a newly created household.

### HTTP API — `server/routes.ts` and `server/index.ts`

REST routes for the entities above, plus:

- `GET /api/validate-invite/:inviteCode`
- `POST /api/accept-invitation`
- `POST /api/send-invitation`
- `GET /api/health`

`server/index.ts` is the Express bootstrap. HomeTask has no server today; adding these routes would mean introducing a Node host (the same kind of always-on service BitcoinBytes needs) and a Postgres database (Neon was the original plan).

### Invite email — `server/email-service.ts` and `server/email.ts`

SendGrid-backed invitation email. Only useful once HomeTask has accounts and a household to invite people into. Requires `SENDGRID_API_KEY`.

### Firebase Auth — `client/src/lib/firebase.ts`

Initializes Firebase only when `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` are all present. No hardcoded keys. Exports `auth` and `db` (Firestore). HomeTask would use this as the identity layer before any of the household APIs make sense.

### Client hooks

- `client/src/hooks/use-auth.ts` — Firebase sign-in / session, then upserts the user via `/api/users`.
- `client/src/hooks/use-household.ts` — loads the current household, members, and related queries.

These are the glue between Firebase and the Express API. They would sit above HomeTask's current local-only state.

### Accounts, invites, and household UI

- `client/src/pages/auth.tsx`, `setup.tsx`, `invite.tsx`
- `client/src/components/auth/login-form.tsx`, `signup-form.tsx`
- `client/src/components/accept-invite.tsx`
- `client/src/components/household/create-household-form.tsx`, `join-household-form.tsx`
- `client/src/components/dashboard/household-members.tsx`, `invite-member-modal.tsx`

This is the complete “create or join a household, invite by code or email” flow. It has no equivalent in HomeTask and would be a new area of the PWA (likely behind a later “Share with household” switch, with local-only remaining the default).

### Zones

- `client/src/pages/rooms-zones.tsx`
- `client/src/components/zones/add-zone-modal.tsx`

HomeTask already has a simpler “room” field on each catalog task. HomeSync zones are a household-level tree (rooms can have parent zones, custom rooms can be added). If HomeTask grows shared mode, map HomeTask rooms onto `zones` rows rather than inventing a second room model.

### Chore assignments and scheduling

- `client/src/pages/schedule.tsx`, `dashboard.tsx`, `task-library.tsx`, `settings.tsx`
- `client/src/components/tasks/add-task-modal.tsx`, `task-item.tsx`
- `client/src/components/dashboard/todays-tasks.tsx`, `upcoming-tasks.tsx`
- `client/src/lib/predefined-tasks.ts`

This is the assignment layer HomeTask does not have: a task belongs to a zone, can be assigned to a member, has a frequency and a next-due date, and completions are recorded per person. `predefined-tasks.ts` is HomeSync's seed catalog — compare it with HomeTask's `SEED_TASKS` / catalog before merging, so titles, rooms, and intervals are not duplicated or overwritten.

## Suggested way to plug this into HomeTask later

1. Keep HomeTask personal and local-first. Do not require a login for the current single-user flow.
2. If/when a shared household is wanted, add Firebase Auth as an optional upgrade (using `firebase.ts` + the auth hook and forms).
3. Stand up Postgres with this Drizzle schema (or a tightened version of it) and the `storage.ts` / `routes.ts` API.
4. On first share: create a `users` row, a `households` row, and copy the current `hometask-v1` local tasks into `tasks` / `task_templates` / `zones`.
5. Invite other members with the invite-code + SendGrid flow already in this extract.
6. Reuse zone and assignment UI; keep HomeTask's existing personal UI as the “just me” view.

Do not treat these files as the live HomeTask app. They are reference source, copied as of the Replit backup on 15 November 2026 (America/Detroit).
