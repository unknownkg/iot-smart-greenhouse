import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { buildDashboardModel, zoneCards, sensorRows, deviceCards } from '../assets/js/views.js';
import * as views from '../assets/js/views.js';
import { createStore } from '../assets/js/store.js';

const state = () => createInitialState('2026-10-18T12:00:00.000Z');

test('dashboard derives four averages and online count from the same 18 sensors', () => {
  const model = buildDashboardModel(state());
  assert.equal(model.temperature, 24.1);
  assert.equal(model.humidity, 67.7);
  assert.equal(model.soil, 50.3);
  assert.equal(model.waterLevel, 73.7);
  assert.equal(model.online, 18);
});

test('offline readings are excluded from averages; no valid readings is not zero', () => {
  const data = state();
  data.sensors.find((sensor) => sensor.type === 'temperature').status = 'offline';
  assert.equal(buildDashboardModel(data).temperature, 23.8);
  data.sensors.filter((sensor) => sensor.type === 'soil').forEach((sensor) => { sensor.status = 'offline'; });
  assert.equal(buildDashboardModel(data).soil, null);
  assert.equal(buildDashboardModel(data).online, 14);
});

test('views display current model readings instead of embedded examples', () => {
  const data = state();
  data.sensors.find((sensor) => sensor.zoneId === 'ZONE-01' && sensor.type === 'soil').value = 63;
  const cards = zoneCards(data, true);
  const rows = sensorRows(data);
  assert.match(cards, /63/);
  assert.match(rows, /63/);
  assert.equal((cards.match(/class="zone-card"/g) ?? []).length, 3);
  assert.equal((rows.match(/<tr>/g) ?? []).length, 18);
  assert.match(cards, /0 \/ 100/);
  assert.match(rows, /18\.10\.2026/);
});

test('control renders six manual switches for the selected zone only', () => {
  const cards = deviceCards(state(), 'ZONE-02');
  assert.equal((cards.match(/role="switch"/g) ?? []).length, 6);
  assert.equal((cards.match(/ disabled/g) ?? []).length, 0);
  assert.equal((cards.match(/aria-checked="false"/g) ?? []).length, 6);
  assert.match(cards, /ZONE-02-D-pump/);
  assert.doesNotMatch(cards, /ZONE-01-D/);
});

test('Auto cards disable all manual toggles including ON devices and explain real decisions', () => {
  const data = state(); data.zones[0].mode = 'auto'; data.sensors[0].value = 30; data.savedAt = data.createdAt;
  const store = createStore({ storage: { getItem: () => JSON.stringify(data), setItem() {} }, now: () => data.createdAt });
  const cards = deviceCards(store.getState(), 'ZONE-01');
  assert.equal((cards.match(/ disabled/g) ?? []).length, 6);
  assert.match(cards, /Автоматика/); assert.doesNotMatch(cards, /не запущена/);
  assert.match(cards, /Авто: температура 30/);
  assert.match(cards, /Включено/);
});

test('Dashboard distinguishes Manual, Auto and Mixed; zone cards show each mode', () => {
  assert.equal(typeof views.modeLabel, 'function');
  const data = state();
  assert.equal(views.modeLabel(data), 'Ручной');
  data.zones[0].mode = 'auto'; assert.equal(views.modeLabel(data), 'Смешанный');
  const cards = zoneCards(data);
  assert.match(cards, /Авто/); assert.match(cards, /Ручной/);
  data.zones.forEach((zone) => { zone.mode = 'auto'; }); assert.equal(views.modeLabel(data), 'Авто');
});
