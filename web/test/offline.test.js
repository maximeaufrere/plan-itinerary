import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const IGNORED = new Set(['test', 'e2e', 'node_modules', 'sw.js', 'package.json', 'package-lock.json', 'playwright.config.js', 'test-results', 'playwright-report']);

function appFiles(dir = root) {
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED.has(name) || name.startsWith('.') || name.startsWith('LICENSE')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? appFiles(path) : [relative(root, path)];
  });
}

test('hors ligne : tous les fichiers de l\'app sont gardés par le service worker', () => {
  const source = readFileSync(join(root, 'sw.js'), 'utf8');
  const listed = [...source.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(listed.includes('./'));
  const missing = appFiles().filter((file) => !listed.includes(file));
  assert.deepEqual(missing, [], 'fichiers à ajouter à APP_FILES dans sw.js');
  const gone = listed.filter((file) => file !== './' && !appFiles().includes(file));
  assert.deepEqual(gone, [], 'fichiers qui n\'existent plus, à retirer de APP_FILES');
});
