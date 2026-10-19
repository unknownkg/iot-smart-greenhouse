import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function documents(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? documents(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

test('public project documentation does not expose a local Windows user home path', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const path of [join(root, 'README.md'), ...documents(join(root, 'docs'))]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /[A-Z]:[/\\]Users[/\\][^/\\\s]+/i, path);
  }
});

test('all eight pages present the same prototype version and development stage', () => {
  const pages = ['index', 'zones', 'sensors', 'control', 'alerts', 'analytics', 'settings', 'event-log'];
  const versions = new Set(); const stages = new Set();
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
    const version = html.match(/PROTOTYPE v(\d+\.\d+)/);
    assert.ok(version, `${page}: missing visible version`);
    versions.add(version[1]);
    const labels = [...html.matchAll(/этап\s+(\d+)/gi)];
    assert.ok(labels.length >= 3, `${page}: sidebar, notice and footer identify the stage`);
    for (const label of labels) stages.add(Number(label[1]));
  }
  assert.equal(versions.size, 1, `conflicting project versions: ${[...versions].join(', ')}`);
  assert.equal(stages.size, 1, `conflicting stage labels: ${[...stages].join(', ')}`);
});
