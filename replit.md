# HomeTask

A home maintenance and cleaning task reminder app. Plain HTML, CSS, and JavaScript — no frameworks. Installable as a PWA.

## Run & Operate

- `pnpm --filter @workspace/home-tasks run dev` — run the app (port assigned at runtime)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages

## Stack

- pnpm workspaces, Node.js 24
- Frontend: Vanilla HTML + CSS + JS (ES modules), Vite dev server
- PWA: Web App Manifest + Service Worker (cache-first)
- Storage: localStorage (via `storage` module in `script.js`)
- No frameworks, no build step for the app JS

## Where things live

- `artifacts/home-tasks/index.html` — app shell, PWA meta tags
- `artifacts/home-tasks/src/style.css` — all styles (CSS custom properties)
- `artifacts/home-tasks/src/script.js` — modular JS: `storage`, `tasks`, `filters`, `ui`, `modal`, `notifications`, `app`
- `artifacts/home-tasks/public/manifest.json` — PWA manifest
- `artifacts/home-tasks/public/sw.js` — service worker (cache-first + push notification stub)

## Architecture decisions

- **Modular IIFE pattern** — each concern (storage, tasks, ui, modal, filters) is its own IIFE module in `script.js`. No bundler or import maps needed; just Vite for dev serving.
- **localStorage** for persistence — straightforward to swap for IndexedDB or a REST API later.
- **Vite as dev server only** — no React, no Tailwind. The JS/CSS are served as-is; Vite handles HMR and the Replit proxy integration.
- **Service worker** — cache-first for static assets; push notification handler is stubbed and ready to wire up.

## Product

Users can add, edit, complete, and delete home maintenance and cleaning tasks. Tasks have a title, category (cleaning/maintenance/garden/other), optional due date, and optional notes. Overdue tasks are highlighted. A filter button toggles completed tasks. The app works offline.

## User preferences

- No frameworks — plain HTML, CSS, JS only
- Modular code structure so features can be added incrementally
- Extremely simple, clean interface

## Gotchas

- The Vite config reads `PORT` and `BASE_PATH` from the environment — these are injected by the artifact workflow. Don't run `vite dev` directly from bash.
- `public/` folder contents (manifest, sw.js, icons) are served at the root path.
- Service worker scope is the root `/`. If `BASE_PATH` changes, update `sw.js` registration in `script.js` accordingly.

## Pointers

- See the `pnpm-workspace` skill for workspace structure
- PWA icons (icon-192.png, icon-512.png) are not yet generated — add them to `artifacts/home-tasks/public/` when ready
