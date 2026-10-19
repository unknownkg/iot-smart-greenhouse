import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { buildDashboardModel, zoneCards } from '../assets/js/views.js';
import { filterAlerts, filterEvents, alertRows, eventRows, recentEvents } from '../assets/js/monitoring-views.js';

function model() {
  const state = createInitialState('2026-10-18T12:00:00.000Z'); state.savedAt = state.createdAt;
  state.sensors.find((s) => s.id === 'ZONE-01-S-waterLevel').value = 10;
  state.sensors.find((s) => s.id === 'ZONE-02-S-soil').value = 30;
  let raw = JSON.stringify(state);
  return createStore({ storage: { getItem: () => raw, setItem: (_, value) => { raw = value; } }, now: () => state.createdAt });
}

test('alert filters combine zone/severity/status without mutating the shared state', () => {
  const store = model(); store.applyScenario('ZONE-01', 'restore');
  const state = store.getState(); const original = structuredClone(state);
  const matches = filterAlerts(state, { zoneId: 'ZONE-01', severity: 'critical', status: 'resolved' });
  assert.equal(matches.length, 2); assert.ok(matches.every((a) => a.zoneId === 'ZONE-01' && a.severity === 'critical' && a.status === 'resolved'));
  assert.equal(filterAlerts(state, { zoneId: 'ZONE-02', status: 'open' }).length, 1);
  assert.equal(filterAlerts(state, { severity: 'impossible' }).length, 0);
  assert.deepEqual(state, original);
});

test('journal filters and row limits show newest first and support extending the visible page', () => {
  const store = model();
  for (let i = 0; i < 50; i++) store.setDeviceState('ZONE-03-D-growLight', i % 2 === 0);
  const state = store.getState();
  const events = filterEvents(state, { zoneId: 'ZONE-03', source: 'operator' });
  assert.equal(events.length, 50); assert.equal(events[0].id, state.events.at(-1).id);
  assert.equal((eventRows(state, { zoneId: 'ZONE-03', source: 'operator' }, 30).match(/<tr>/g) ?? []).length, 30);
  assert.equal((eventRows(state, { zoneId: 'ZONE-03', source: 'operator' }, 60).match(/<tr>/g) ?? []).length, 50);
  assert.equal(filterEvents(state, { source: 'invalid' }).length, 0);
});

test('monitoring rows escape stored descriptions and provide clear empty states', () => {
  const state = model().getState();
  state.alerts[0].message = '<img src=x onerror=bad()>𐀀'; state.events[0].reason = '<script>bad()</script>';
  assert.match(alertRows(state), /&lt;img/); assert.doesNotMatch(alertRows(state), /<img/);
  assert.match(eventRows(state), /&lt;script/); assert.doesNotMatch(eventRows(state), /<script/);
  assert.match(alertRows(state, { zoneId: 'ZONE-99' }), /Нет предупреждений/);
  assert.match(eventRows(state, { source: 'invalid' }), /Нет событий/);
});

test('Dashboard derives actual open severity counts and Zones shows per-zone alerts', () => {
  const state = model().getState(); const dashboard = buildDashboardModel(state);
  assert.equal(dashboard.alerts, 3); assert.equal(dashboard.warning, 1); assert.equal(dashboard.critical, 2);
  const cards = zoneCards(state); assert.match(cards, /2 активных/); assert.match(cards, /1 активных/);
  const feed = recentEvents(state, 2); assert.equal((feed.match(/class="event-item"/g) ?? []).length, 2);
  assert.doesNotMatch(feed, /после подключения/);
});
