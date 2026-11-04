// Copies shared/sentry-scrub.ts BYTE FOR BYTE into the server and the app (ADR 0039). Run from the repo root: node shared/sync-sentry-scrub.mjs
// `--check` only compares and exits 1 if a copy differs (the packages' own tests do the same).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'shared', 'sentry-scrub.ts');
const targets = [join(root, 'server', 'src', 'observability', 'sentryScrub.ts'), join(root, 'app', 'src', 'observability', 'sentryScrub.ts')];
const check = process.argv.includes('--check');

let drift = false;
for (const target of targets) {
  if (check) {
    let same = false;
    try {
      same = readFileSync(target, 'utf8') === readFileSync(source, 'utf8');
    } catch {
      same = false;
    }
    if (!same) {
      console.error(`DIFFERS: ${target}`);
      drift = true;
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`copied to ${target}`);
  }
}
if (drift) process.exit(1);
