import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { buildDashboardModel, zoneCards, sensorRows, deviceCards } from '../assets/js/views.js';

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
  assert.match(cards, /Не рассчитан/);
  assert.match(rows, /18\.10\.2026/);
});

test('control renders six disabled switches for the selected zone and no command buttons', () => {
  const cards = deviceCards(state(), 'ZONE-02');
  assert.equal((cards.match(/role="switch"/g) ?? []).length, 6);
  assert.equal((cards.match(/ disabled/g) ?? []).length, 6);
  assert.equal((cards.match(/aria-checked="false"/g) ?? []).length, 6);
  assert.match(cards, /ZONE-02-D-pump/);
  assert.doesNotMatch(cards, /ZONE-01-D/);
});
