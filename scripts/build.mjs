// Static build: copy public/ and the engine's src/*.js into dist/. Nothing else ships
// (no docs, tests, README, package.json or prompts). No network, no dependencies.
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function build(outDir = join(ROOT, 'dist')) {
  const out = resolve(outDir);
  if (out === ROOT || ROOT.startsWith(out)) throw new Error(`refusing to build into ${out}`);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(ROOT, 'public'), out, { recursive: true });
  mkdirSync(join(out, 'src'));
  for (const f of readdirSync(join(ROOT, 'src'))) if (f.endsWith('.js')) cpSync(join(ROOT, 'src', f), join(out, 'src', f));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`built ${build()}`);
}
