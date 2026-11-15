/**
 * recurrence.js — the frozen v2 recurrence union (validator + interval/day
 * evaluation).
 *
 * CP1 implements:
 *   • validateRecurrence() for the COMPLETE union (all five kinds), so any
 *     v2 data written later is forward-valid.
 *   • nextDue() evaluation for { kind:"interval", unit:"day" } and "paused"
 *     only — identical behavior to v1 intervalDays. The remaining
 *     evaluators (week/month/year, annualDate, seasonal, once) are Step 2
 *     scope against this same frozen shape; they throw explicitly here
 *     rather than guessing.
 *   • Lossless intervalDays ⇄ recurrence conversion for migration.
 *
 * Pure module: no storage, no DOM, no clock. Dates are injected.
 */

import { addDays, isDateStr } from './dates.js';

export const RECURRENCE_KINDS = ['interval', 'annualDate', 'seasonal', 'once', 'paused'];
export const INTERVAL_UNITS   = ['day', 'week', 'month', 'year'];
export const SEASONS          = ['spring', 'summer', 'fall', 'winter'];

/**
 * Validate a recurrence value against the full v2 union.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRecurrence(rec) {
  const errors = [];
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, errors: ['recurrence must be an object'] };
  }
  switch (rec.kind) {
    case 'interval':
      if (!INTERVAL_UNITS.includes(rec.unit)) errors.push(`invalid unit "${rec.unit}"`);
      if (!Number.isInteger(rec.every) || rec.every < 1) errors.push(`every must be an integer ≥ 1, got ${rec.every}`);
      break;
    case 'annualDate':
      if (!Number.isInteger(rec.month) || rec.month < 1 || rec.month > 12) errors.push(`invalid month ${rec.month}`);
      if (!Number.isInteger(rec.day) || rec.day < 1 || rec.day > 31) errors.push(`invalid day ${rec.day}`);
      // Reject days that exist in no year (Apr 31, Feb 30…). Feb 29 is valid (clamps in non-leap years).
      if (Number.isInteger(rec.month) && Number.isInteger(rec.day)) {
        const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][rec.month - 1];
        if (rec.day > maxDay) errors.push(`day ${rec.day} does not exist in month ${rec.month}`);
      }
      break;
    case 'seasonal':
      if (!SEASONS.includes(rec.season)) errors.push(`invalid season "${rec.season}"`);
      break;
    case 'once':
      if (!isDateStr(rec.date)) errors.push(`invalid date "${rec.date}"`);
      break;
    case 'paused':
      break;
    default:
      errors.push(`unknown kind "${rec.kind}"`);
  }
  // No stray fields beyond the shape (defense against typos silently ignored).
  const allowed = { interval: ['kind', 'unit', 'every'], annualDate: ['kind', 'month', 'day'],
    seasonal: ['kind', 'season'], once: ['kind', 'date'], paused: ['kind'] }[rec.kind];
  if (allowed) for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) errors.push(`unexpected field "${k}" on kind "${rec.kind}"`);
  }
  return { ok: errors.length === 0, errors };
}

/** Lossless v1 → v2 conversion. */
export function fromIntervalDays(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`fromIntervalDays: invalid intervalDays ${n}`);
  return { kind: 'interval', unit: 'day', every: n };
}

/**
 * Lossless v2 → v1 conversion — supported domain only.
 * @returns {{ ok: true, intervalDays: number } | { ok: false, reason: string }}
 */
export function toIntervalDays(rec) {
  const v = validateRecurrence(rec);
  if (!v.ok) return { ok: false, reason: `invalid recurrence: ${v.errors.join('; ')}` };
  if (rec.kind === 'interval' && rec.unit === 'day') return { ok: true, intervalDays: rec.every };
  return { ok: false, reason: `v1 cannot represent kind "${rec.kind}"${rec.unit ? `/unit "${rec.unit}"` : ''}` };
}

/**
 * Natural next-due date from the last completion (CP1: interval/day + paused).
 * Mirrors v1: lastDone + intervalDays; null when never done or paused.
 * skipUntil precedence is applied by the caller (see effectiveDue below).
 */
export function nextDue(rec, lastDone) {
  const v = validateRecurrence(rec);
  if (!v.ok) throw new Error(`nextDue: ${v.errors.join('; ')}`);
  if (rec.kind === 'paused') return null;
  if (rec.kind === 'interval' && rec.unit === 'day') {
    return lastDone ? addDays(lastDone, rec.every) : null;
  }
  throw new Error(`nextDue: evaluator for "${rec.kind}${rec.unit ? '/' + rec.unit : ''}" is Step 2 scope`);
}

/**
 * Effective due date — identical precedence to v1 computeEffectiveDue:
 * skipUntil (explicit override) wins, else natural nextDue.
 */
export function effectiveDue(rec, lastDone, skipUntil) {
  if (skipUntil) return skipUntil;
  return nextDue(rec, lastDone);
}
