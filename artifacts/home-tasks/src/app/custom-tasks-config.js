/* ================================================================
   custom-tasks-config.js — compile-time flag for F1 custom tasks UI.

   CUSTOM_TASKS_UI_ENABLED gates the add/delete UI only.
   The loadTasks() append pass in v1-repository.js is UNCONDITIONAL
   and is NEVER gated by this flag — custom records survive every
   build variant and compatibility rollback.

   Compatibility rollback procedure:
     Set CUSTOM_TASKS_UI_ENABLED = false, rebuild, and publish.
     FAB, delete icons, and add-task sheet are hidden.
     Existing custom tasks remain in localStorage and reload
     transparently. Re-enable to restore full UI.

   This flag is guarded by import-order.test.mjs to prevent
   accidental toggling in a production build.
   ================================================================ */
export const CUSTOM_TASKS_UI_ENABLED = true;
