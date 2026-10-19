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

test('all eight pages present the same final Russian educational labels', () => {
  const pages = ['index', 'zones', 'sensors', 'control', 'alerts', 'analytics', 'settings', 'event-log'];
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<span>Учебный проект<\/span>/, page);
    assert.match(html, /Центр управления/, page);
    assert.match(html, /data-mode-indicator>Ручной<\/span>/, page);
    assert.doesNotMatch(html, /PROTOTYPE|Этап\s*0?8|Финальная проверка|IoT CONTROL CENTER/i, page);
  }
});
