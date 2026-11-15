# HomeTask

An iPhone-friendly household-task PWA (Progressive Web App), not a native App Store app. It keeps a personal chore catalog and due dates on the device (`localStorage`), and works as a home-screen web app.

Built by Shaun Barry with AI tools on Replit.

**Status:** in progress. It is far enough along for personal use, and is being finished as a portfolio piece. There is no App Store commitment.

**Stack:** JavaScript PWA (HTML, CSS, and client-side modules) with a service worker and web app manifest, inside a Replit/pnpm workspace. The runnable app lives under `artifacts/home-tasks/`.

**Run locally:** from `artifacts/home-tasks`, install and start the dev server with the scripts in that package (typically `pnpm install` at the repo root, then start the Home Tasks app). No API keys are required for the personal PWA.

## Legacy HomeSync extract

The earlier household-sharing version of this idea lived in a separate Replit app (HomeSyncTasks). Reusable pieces — accounts and Firebase auth, household invites, zones, chore assignments, and the Postgres/Drizzle schema — are copied into [`legacy/homesync`](legacy/homesync), with a [`NOTES.md`](legacy/homesync/NOTES.md) that explains what each file is and how it could plug into HomeTask later. HomeTask itself stays local-first; those files are reference source, not a drop-in.
