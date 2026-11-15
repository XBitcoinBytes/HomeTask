/**
 * shadow-config.js — compile-time shadow-migration feature flag.
 *
 * It must never be controlled by a URL parameter, localStorage key,
 * environment variable, or remote configuration endpoint.
 *
 * The committed value remains false. Enabling it requires a reviewed,
 * explicit source-code change in a future checkpoint.
 */
export const SHADOW_MIGRATION_ENABLED = false;
