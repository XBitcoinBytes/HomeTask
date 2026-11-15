/**
 * shadow-fingerprint.js — cryptographic source-integrity digest.
 *
 * Produces a 64-character SHA-256 hex digest over a deterministic
 * length-prefixed UTF-8 canonical encoding of the source-key map.
 *
 * SHA-256 is used as a one-way integrity digest to detect source mutations.
 * It is not encryption and does not prevent inspection of the local storage
 * by parties who have physical or API access to the device. No claim is made
 * that the digest makes content reconstruction mathematically impossible.
 *
 * The digest function is injected, keeping this module environment-neutral:
 *   - No Node-only imports (no 'node:crypto', no 'node:fs', etc.).
 *   - Default implementation uses globalThis.crypto.subtle (Web Crypto API),
 *     available in all modern browsers and Node.js 19+.
 *   - Tests may inject a synchronous or alternative async digest for speed.
 *
 * Pure module: no storage, no DOM, no clock.
 */

/* ── Canonical encoding ───────────────────────────────────────────── */

/**
 * Encode a source map into an unambiguous canonical byte sequence.
 *
 * Encoding (for each key, sorted alphabetically):
 *
 *   [4 bytes]  uint32 big-endian: key UTF-8 byte length
 *   [N bytes]  key encoded as UTF-8
 *   [1 byte]   0x00 = null/absent value | 0x01 = non-null string
 *   if 0x01:
 *     [4 bytes]  uint32 big-endian: value UTF-8 byte length
 *     [M bytes]  value encoded as UTF-8
 *
 * This encoding:
 *   - Distinguishes null/absent from "" ("" → 0x01 + 4-byte zero length + 0 bytes).
 *   - Is unambiguous for keys or values containing colons, newlines, or any
 *     Unicode — no delimiter can be confused with content because lengths are
 *     explicit rather than delimited.
 *   - Produces the same output regardless of JavaScript object insertion order
 *     (keys are sorted before encoding).
 *   - Encodes all characters as UTF-8, giving consistent multi-byte handling.
 *
 * @param {Record<string, string|null|undefined>} sourceMap
 * @returns {Uint8Array} Canonical byte sequence ready for hashing.
 */
export function buildCanonicalEncoding(sourceMap) {
  if (!sourceMap || typeof sourceMap !== 'object')
    throw new Error('buildCanonicalEncoding: sourceMap must be a plain object');

  const enc   = new TextEncoder();
  const parts = [];

  for (const k of Object.keys(sourceMap).sort()) {
    // Key: 4-byte length prefix + UTF-8 bytes.
    const keyBytes  = enc.encode(k);
    const keyLenBuf = new Uint8Array(4);
    new DataView(keyLenBuf.buffer).setUint32(0, keyBytes.length, /* big-endian */ false);
    parts.push(keyLenBuf, keyBytes);

    // Value: presence byte, then optional length-prefixed value.
    const v = sourceMap[k];
    if (v === null || v === undefined) {
      parts.push(new Uint8Array([0x00]));   // null sentinel
    } else {
      const valBytes  = enc.encode(String(v));
      const valLenBuf = new Uint8Array(4);
      new DataView(valLenBuf.buffer).setUint32(0, valBytes.length, false);
      parts.push(new Uint8Array([0x01]), valLenBuf, valBytes);  // non-null sentinel + length + bytes
    }
  }

  // Concatenate into a single Uint8Array.
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result   = new Uint8Array(totalLen);
  let   offset   = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}

/* ── Default digest: Web Crypto SHA-256 ──────────────────────────── */

/**
 * Compute a SHA-256 digest using the Web Crypto API.
 *
 * Uses globalThis.crypto.subtle — available in all modern browsers and
 * Node.js 19+. Contains no Node-only imports so the module remains
 * browser-safe.
 *
 * SHA-256 is used as a one-way integrity digest; it is not encryption.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
export async function webCryptoDigest(bytes) {
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Build a 64-character SHA-256 hex digest of the source map.
 *
 * @param {Record<string, string|null>} sourceMap  — { key: rawString|null }
 * @param {function(Uint8Array): Promise<string>|string} [digestFn]
 *   Async (or sync) function receiving canonical bytes and returning a
 *   64-char lowercase hex digest. Defaults to webCryptoDigest.
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
export async function buildFingerprint(sourceMap, digestFn = webCryptoDigest) {
  const canonical = buildCanonicalEncoding(sourceMap);
  return digestFn(canonical);
}

/* ── Canonical fingerprint validation ────────────────────────────── */

/**
 * Regular expression for a canonical SHA-256 hex digest:
 * exactly 64 lowercase hexadecimal characters [0-9a-f].
 * Uppercase, short, oversized, or non-hex strings do not match.
 */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Return true when `s` is a canonical SHA-256 hex digest:
 * a string, exactly 64 characters, all lowercase [0-9a-f].
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isCanonicalFingerprint(s) {
  return typeof s === 'string' && s.length === 64 && FINGERPRINT_RE.test(s);
}

/**
 * Return true only when both `a` and `b` are valid canonical SHA-256
 * hex digests (64 lowercase hex chars) and they are equal.
 *
 * Invalid, truncated, oversized, uppercase, non-hex, null, undefined,
 * or non-string inputs always return false — including two equal
 * malformed strings.
 *
 * Uses a fixed-length comparison that accumulates all character
 * differences into a single integer rather than returning early on the
 * first mismatch, avoiding unnecessary timing variation for this
 * fixed-length format.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function fingerprintsMatch(a, b) {
  if (!isCanonicalFingerprint(a) || !isCanonicalFingerprint(b)) return false;
  // Both strings are validated to be exactly 64 lowercase hex chars.
  // Accumulate all character differences — no early exit on mismatch.
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
