import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Everything starting EXPO_PUBLIC_ is bundled into the app and readable by anyone who downloads it
// (AGENTS.md rule 5). Each name allowed here has a row in docs/SECURITY.md saying why it is safe.
const ALLOWED = new Set(['EXPO_PUBLIC_API_URL']);

const appRoot = path.resolve(__dirname, '..');

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'android' || entry.name === '.expo') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|json|js)$/.test(entry.name) && entry.name !== 'package-lock.json') yield full;
  }
}

test('the app only uses EXPO_PUBLIC_ variables that docs/SECURITY.md has justified', () => {
  const found = new Map<string, string[]>();
  for (const file of files(appRoot)) {
    if (file.endsWith('publicEnv.test.ts')) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/EXPO_PUBLIC_[A-Z0-9_]+/g)) {
      found.set(match[0], [...(found.get(match[0]) ?? []), path.relative(appRoot, file)]);
    }
  }
  for (const [name, where] of found) {
    assert.ok(ALLOWED.has(name), `${name} is not on the allowlist (found in ${where.join(', ')}). Add a line to docs/SECURITY.md first.`);
  }
});

test('every allowed variable is documented in docs/SECURITY.md and .env.example', () => {
  const security = fs.readFileSync(path.resolve(appRoot, '../docs/SECURITY.md'), 'utf8');
  const example = fs.readFileSync(path.resolve(appRoot, '../.env.example'), 'utf8');
  for (const name of ALLOWED) {
    assert.ok(security.includes(name), `${name} is missing from docs/SECURITY.md`);
    assert.ok(example.includes(name), `${name} is missing from .env.example`);
  }
});

test('no secret-shaped name is ever exposed through the Expo public prefix', () => {
  for (const name of ALLOWED) assert.doesNotMatch(name, /SECRET|PASSWORD|PRIVATE|_KEY|TOKEN/);
});
