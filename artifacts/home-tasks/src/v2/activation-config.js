/**
 * activation-config.js — compile-time v2 activation feature flag.
 *
 * It must never be controlled by a URL parameter, localStorage key,
 * environment variable, or remote configuration endpoint.
 *
 * Current value false is intentional: the activation infrastructure
 * (CP5A) exists for pre-publication verification only. Enabling it
 * requires a separate explicit owner approval after the shadow-diagnostic
 * audit window completes. Do not change this flag without that approval.
 */
export const V2_ACTIVATION_ENABLED = false;
