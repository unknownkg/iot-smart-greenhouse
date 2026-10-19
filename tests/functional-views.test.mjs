import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../assets/js/store.js';
import { renderDataPage } from '../assets/js/views.js';

// Подменяются узлы и события DOM; представление страницы, хранилище и подписки выполняются настоящим кодом.
function fixture(page) {
  const node = (value = '') => ({ value, textContent: '', innerHTML: '', dataset: {}, attributes: {}, events: {},
    setAttribute(key, val) { this.attributes[key] = val; }, after() {},
    addEventListener(type, listener) { this.events[type] = listener; } });
  const nodes = new Map([['main > .notice', node()], ['[data-mode-indicator]', node()], ['[data-notifications]', node()]]);
  const add = (key, value = '') => { nodes.set(key, node(value)); };
  if (page === 'sensors') for (const key of ['[data-sensor-search]', '[data-sensor-zone]', '[data-sensor-status]', '[data-sensor-rows]']) add(key);
  if (page === 'zones') { for (const key of ['[data-zone-search]', '[data-zone-cards]', '[data-sensor-rows]']) add(key); add('[data-zone-select]', 'ZONE-01'); }
  if (page === 'dashboard') for (const key of ['[data-kpis]', '[data-zone-cards]', '[data-device-summary]', '[data-recent-events]', '[data-recent-alerts]']) add(key);
  const root = { body: { dataset: { page } }, querySelector: (key) => nodes.get(key) ?? null, createElement: node };
  let raw = null; let ms = Date.parse('2026-10-19T12:00:00.000Z');
  const store = createStore({ storage: { getItem: () => raw, setItem: (_, v) => raw = v }, now: () => new Date(ms).toISOString() });
  const rendering = renderDataPage(store, root);
  return { store, nodes, rendering, advance() { ms += 5000; },
    input(key, value, type = 'input') { const n = nodes.get(key); n.value = value; n.events[type]?.(); } };
}

test('Sensors native filter events and later store notifications keep one current filtered table', () => {
  const f = fixture('sensors');
  f.input('[data-sensor-search]', 'температура'); f.input('[data-sensor-zone]', 'ZONE-02', 'change');
  const rows = () => f.nodes.get('[data-sensor-rows]').innerHTML;
  assert.equal((rows().match(/<tr>/g) ?? []).length, 1); assert.match(rows(), /ZONE-02-S-temperature/);
  f.input('[data-sensor-status]', 'offline', 'change'); assert.match(rows(), /Нет датчиков/);
  f.store.setSensorStatus('ZONE-02-S-temperature', 'offline'); assert.match(rows(), /Нет связи/);
  assert.equal(f.nodes.get('[data-sensor-search]').value, 'температура'); f.rendering();
});

test('Zones search filters cards without removing entities or losing independently selected details', () => {
  const f = fixture('zones'); f.input('[data-zone-search]', 'Greens');
  assert.doesNotMatch(f.nodes.get('[data-zone-cards]').innerHTML, /Томаты/);
  assert.match(f.nodes.get('[data-zone-cards]').innerHTML, /Зелень/);
  assert.match(f.nodes.get('[data-sensor-rows]').innerHTML, /Томаты/);
  f.input('[data-zone-select]', 'ZONE-02', 'change'); assert.match(f.nodes.get('[data-sensor-rows]').innerHTML, /Огурцы/);
  f.input('[data-zone-search]', 'no zone'); assert.match(f.nodes.get('[data-zone-cards]').innerHTML, /Нет зон/);
  assert.equal(f.store.getState().zones.length, 3); f.rendering();
});

test('Dashboard renders separate real Alerts and Event Log while topbar count follows recovery', () => {
  const f = fixture('dashboard'); f.advance(); f.store.applyScenario('ZONE-01', 'low-water');
  assert.match(f.nodes.get('[data-recent-alerts]').innerHTML, /Критическ/);
  assert.match(f.nodes.get('[data-recent-events]').innerHTML, /Включение|Предупреждение|Критическ/);
  assert.match(f.nodes.get('[data-notifications]').textContent, /2/);
  f.advance(); f.store.applyScenario('ZONE-01', 'restore');
  assert.match(f.nodes.get('[data-recent-alerts]').innerHTML, /Устранено/);
  assert.match(f.nodes.get('[data-notifications]').textContent, /0/); f.rendering();
});

test('all8 topbars expose a native keyboard-focusable Alerts link; Settings reset is a labelled explicit button', () => {
  for (const name of ['index', 'zones', 'sensors', 'control', 'alerts', 'analytics', 'settings', 'event-log']) {
    const html = readFileSync(new URL(`../${name}.html`, import.meta.url), 'utf8');
    const link = html.match(/<a\b[^>]*data-notifications[^>]*>/)?.[0];
    assert.ok(link, name); assert.match(link, /href="alerts.html"/); assert.doesNotMatch(link, /tabindex="-1"|disabled/);
  }
  const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*data-reset-demo[^>]*>/)?.[0];
  assert.ok(button); assert.match(button, /type="button"/); assert.match(button, /aria-describedby="reset-warning"/);
  assert.match(html, /id="reset-warning"/);
  assert.ok(html.indexOf('data-simulation-interval') > html.indexOf('</form>'));
  for (let ms = 3000; ms <= 10000; ms += 1000) assert.ok(html.includes(`value="${ms}"`));
});
