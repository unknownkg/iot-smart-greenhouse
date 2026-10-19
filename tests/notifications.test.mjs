import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../assets/js/store.js';
import { recentAlerts, notificationModel, renderNotifications } from '../assets/js/monitoring-views.js';

function fixture() {
  let raw = null; let ms = Date.parse('2026-10-19T12:00:00.000Z'); let writes = 0;
  const store = createStore({ storage: { getItem: () => raw, setItem: (_, value) => { raw = value; writes++; } }, now: () => new Date(ms).toISOString() });
  return { store, writes: () => writes, advance() { ms += 5000; } };
}

test('recent Alerts are actual Open records first followed by recent Resolved, separately from Event Log', () => {
  const f = fixture(); f.advance(); f.store.applyScenario('ZONE-01', 'overheat');
  f.advance(); f.store.applyScenario('ZONE-01', 'low-water');
  const state = f.store.getState(); const before = structuredClone(state);
  const html = recentAlerts(state);
  assert.match(html, /Критическ/); assert.match(html, /Томаты/); assert.match(html, /Активно/); assert.match(html, /Устранено/);
  assert.ok(html.indexOf('Активно') < html.indexOf('Устранено')); assert.match(html, /Вода/);
  assert.deepEqual(state, before); assert.ok(state.events.length > state.alerts.length);
});

test('recent Alerts has an honest empty state, escapes all dynamic strings and respects the limit', () => {
  const f = fixture(); assert.match(recentAlerts(f.store.getState()), /Предупреждений пока нет/);
  f.store.applyScenario('ZONE-01', 'low-water'); const state = f.store.getState();
  for (const alert of state.alerts) { alert.reason = '<img onerror=bad()>'; alert.message = '<script>bad()</script>'; }
  const html = recentAlerts(state, 1); assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/);
  assert.equal((html.match(/class="event-item"/g) ?? []).length, 1);
});

test('Notifications derive active counts/severity and recover to a calm normal state using the same Alerts', () => {
  const f = fixture(); const link = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  assert.deepEqual(notificationModel(f.store.getState()), { count: 0, critical: 0, warning: 0, level: 'normal' });
  f.store.subscribe((state) => renderNotifications(state, link));
  f.advance(); f.store.applyScenario('ZONE-01', 'overheat');
  assert.match(link.className, /badge-yellow/); assert.match(link.textContent, /1/);
  assert.match(link.attributes['aria-label'], /Предупреждений: 1/);
  f.advance(); f.store.applyScenario('ZONE-01', 'low-water');
  assert.match(link.className, /badge-red/); assert.match(link.attributes['aria-label'], /Критических: 2/);
  f.advance(); f.store.applyScenario('ZONE-01', 'restore');
  assert.match(link.className, /badge-green/); assert.match(link.textContent, /0/);
  const before = f.store.getState(); const writes = f.writes();
  renderNotifications(before, link); recentAlerts(before); notificationModel(before);
  assert.equal(f.writes(), writes); assert.deepEqual(f.store.getState(), before);
});
