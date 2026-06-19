// Runs every tests/*.test.mjs script in its own process, serially (each boots
// its own server, so serial keeps port/CPU pressure low), and aggregates the
// results. Exits 0 only if all pass, 1 if any fail — the gate the dev skill
// runs alongside `npx vitest run`.
//
//   node tests/run-all.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter(f => f.endsWith('.test.mjs'))
  .sort();

if (scripts.length === 0) {
  console.error('no *.test.mjs scripts found in tests/');
  process.exit(1);
}

const results = [];
for (const script of scripts) {
  console.log(`\n${'='.repeat(60)}\n▶ ${script}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(here, script)], { stdio: 'inherit' });
  results.push({ script, ok: r.status === 0 });
}

console.log(`\n${'='.repeat(60)}\nsummary\n${'='.repeat(60)}`);
for (const { script, ok } of results) {
  console.log(`  ${ok ? '✓' : '✗'} ${script}`);
}
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.error(`\n✗ ${failed.length}/${results.length} test script(s) failed`);
  process.exit(1);
}
console.log(`\n✓ all ${results.length} test scripts passed`);
