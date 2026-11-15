/* ================================================================
   release-hardening.test.mjs — static release-delivery checks.
   Runs after the production build so it can validate the generated
   artifact, source identity, service-worker contract, and contrast.
   ================================================================ */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const read = path => readFileSync(path, 'utf8');
const paths = {
  index: join(APP, 'index.html'),
  script: join(APP, 'src', 'script.js'),
  style: join(APP, 'src', 'style.css'),
  sw: join(APP, 'public', 'sw.js'),
  v2BackupService: join(APP, 'src', 'data', 'backup', 'v2-backup-service.js'),
  dist: join(APP, 'dist', 'public'),
};

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name} — ${error.message}`);
  }
}

function hexToLinear(hex) {
  return [1, 3, 5].map(offset => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

function luminance(hex) {
  const [r, g, b] = hexToLinear(hex);
  return (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
}

function contrast(first, second) {
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function token(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing ${name} color token`);
  return match[1].toLowerCase();
}

function textFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(path);
    return ['.css', '.html', '.js', '.json', '.svg', '.txt'].includes(extname(path)) ? [path] : [];
  });
}

console.log('\nHomeTask release-hardening checks');

const source = Object.fromEntries(
  Object.entries(paths)
    .filter(([name]) => name !== 'dist')
    .map(([name, path]) => [name, read(path)])
);

check('1: v22-f1 release identity is consistent in source and visible build text', () => {
  assert.match(source.index, /Build v22-f1/);
  assert.match(source.script, /APP_BUILD = 'v22-f1'/);
  assert.match(source.sw, /const CACHE = 'hometask-v22-f1'/);
  for (const [name, contents] of Object.entries(source)) {
    assert.doesNotMatch(contents, /v21-repository-test/, `${name} retains the old release identifier`);
  }
});

check('2: worker captures complete Vite attribute paths and caches the captures', () => {
  assert.match(source.sw, /<script\\b\[\^>\]\*\\bsrc=/);
  assert.match(source.sw, /<link\\b\[\^>\]\*\\bhref=/);
  assert.match(source.sw, /const jsPath\s*=\s*jsMatches\[0\]\[2\]/);
  assert.match(source.sw, /const cssPath\s*=\s*cssMatches\[0\]\[2\]/);
  assert.match(source.sw, /cache\.put\(new Request\(jsPath\),\s*jsRes\)/);
  assert.match(source.sw, /cache\.put\(new Request\(cssPath\),\s*cssRes\)/);
});

check('3: active graphite text and controls meet WCAG AA thresholds', () => {
  const text3 = token(source.style, '--text-3');
  const text4 = token(source.style, '--text-4');
  const g2 = token(source.style, '--g2');
  assert.ok(contrast(text3, g2) >= 4.5,
    `--text-3 contrast on --g2 must be at least 4.5:1; got ${contrast(text3, g2).toFixed(2)}:1`);
  assert.equal(text4, '#2c2a28', '--text-4 must remain the disabled/decorative token');
  for (const selector of ['.hp-chevron', '.sr-group-room', '.btn-delete']) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = source.style.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 's'));
    assert.ok(rule, `missing ${selector} rule`);
    assert.match(rule[0], /color:\s*var\(--text-3\)/,
      `${selector} must use the accessible functional text token`);
  }
});

check('4: production output exists and uses rooted hashed main assets', () => {
  assert.ok(existsSync(paths.dist), 'dist/public must exist; run the production build first');
  const html = read(join(paths.dist, 'index.html'));
  const jsPaths = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/index-[A-Za-z0-9_-]+\.js)"[^>]*>/gi)];
  const cssPaths = [...html.matchAll(/<link\b[^>]*\bhref="(\/assets\/index-[A-Za-z0-9_-]+\.css)"[^>]*>/gi)];
  assert.equal(jsPaths.length, 1, 'built HTML must reference exactly one rooted hashed JS asset');
  assert.equal(cssPaths.length, 1, 'built HTML must reference exactly one rooted hashed CSS asset');
  assert.ok(existsSync(join(paths.dist, jsPaths[0][1].slice(1))), 'built JS asset must exist');
  assert.ok(existsSync(join(paths.dist, cssPaths[0][1].slice(1))), 'built CSS asset must exist');
});

check('5: built output has no Vite development markers, source entry, or source-map directives', () => {
  for (const path of textFiles(paths.dist)) {
    const contents = read(path);
    assert.doesNotMatch(contents, /\/@vite\/client|\/src\/script\.js|sourceMappingURL|vite-plugin-runtime-error-modal/);
  }
});

check('6: generated service worker retains v22-f1 identity and path-preserving contract', () => {
  const sw = read(join(paths.dist, 'sw.js'));
  assert.match(sw, /const CACHE = 'hometask-v22-f1'/);
  assert.doesNotMatch(sw, /v21-repository-test/);
  assert.match(sw, /const jsPath\s*=\s*jsMatches\[0\]\[2\]/);
  assert.match(sw, /const cssPath\s*=\s*cssMatches\[0\]\[2\]/);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);