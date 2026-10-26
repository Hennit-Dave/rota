// Checks for the link host (ADR 0019). Plain node:test, no dependencies. Run: node --test site/site.test.mjs
// The workflow runs this before every deploy, so a missing or malformed assetlinks.json fails the deploy.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');

test('assetlinks.json exists, is valid JSON and names this app and the EAS signing key', () => {
  assert.ok(existsSync(here('.well-known/assetlinks.json')), '.well-known/assetlinks.json is missing: Android cannot verify the App Links');
  const links = JSON.parse(read('.well-known/assetlinks.json'));
  assert.equal(links.length, 1);
  const [entry] = links;
  assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(entry.target.namespace, 'android_app');

  // The package name is the app's own, read from app.config.ts so the two cannot drift apart.
  const config = readFileSync(new URL('../app/app.config.ts', import.meta.url), 'utf8');
  const appPackage = config.match(/package:\s*'([^']+)'/)?.[1];
  assert.ok(appPackage, 'could not read android.package from app/app.config.ts');
  assert.equal(entry.target.package_name, appPackage);

  const prints = entry.target.sha256_cert_fingerprints;
  assert.ok(Array.isArray(prints) && prints.length >= 1, 'at least one fingerprint');
  for (const f of prints) assert.match(f, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'SHA-256 as 32 colon-separated upper-case hex bytes');
  assert.equal(new Set(prints).size, prints.length, 'no duplicate fingerprints');
});

for (const page of ['404.html', 'index.html']) {
  test(`${page}: static, nothing from another site, nothing that touches the URL`, () => {
    const html = read(page);
    assert.doesNotMatch(html, /<script/i, 'no script');
    assert.doesNotMatch(html, /<(link|img|iframe|object|embed|video|audio|source|form)\b/i, 'no external or interactive elements');
    assert.doesNotMatch(html, /\b(src|href|action|srcset)\s*=/i, 'no src, href or action attributes');
    assert.doesNotMatch(html, /@import|url\(/i, 'no CSS that loads anything');
    assert.doesNotMatch(html, /https?:\/\//i, 'no absolute URL of any kind');
    assert.doesNotMatch(html, /location|document\.|window\./i, 'nothing that reads the URL');
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
}

test('the workflow keeps dot-directories in the artifact, or .well-known would silently vanish', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /include-hidden-files:\s*true/);
  assert.match(workflow, /node --test site\/site\.test\.mjs/, 'the deploy runs these checks first');
});
