---
name: Cartographer CSS interference
description: @replit/vite-plugin-cartographer causes complete CSS reset and WebSocket HMR failure in the Replit preview environment.
---

## Rule
Remove `@replit/vite-plugin-cartographer` (and optionally `@replit/vite-plugin-dev-banner`) from `vite.config.ts` in any artifact where custom CSS is critical.

**Why:** The cartographer plugin injects a large inline script that fires a `replit-init-tailwind` event and loads Tailwind CSS v4 browser from CDN. In the Replit preview environment this runtime performs a CSS reset that overrides ALL custom styles — inline `<style>` blocks, `<link>` stylesheets, and JS-injected styles all lose to it. It also causes WebSocket HMR to fail (the proxy rejects the upgrade), which was a secondary symptom.

**How to apply:** When any web artifact shows completely unstyled content in the preview despite correct CSS being served (confirmed by curl), check for cartographer in `vite.config.ts` and remove the block:

```ts
// Remove this:
...(process.env.NODE_ENV !== 'production' && process.env.REPL_ID !== undefined
  ? [
      await import('@replit/vite-plugin-cartographer').then(...),
      await import('@replit/vite-plugin-dev-banner').then(...),
    ]
  : []),
```

After removal, restart the workflow. HMR WebSocket will connect and styles will apply correctly.

**Note:** Cartographer is Replit's visual design editor plugin. Removing it only disables the visual editor overlay; it has no effect on app functionality, routing, or the user's experience.
