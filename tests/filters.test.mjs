import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { filterSensors, filterZones } from '../assets/js/filters.js';
import { sensorRows, zoneCards } from '../assets/js/views.js';

const initial = () => createInitialState('2026-10-19T12:00:00.000Z');

test('Sensors search matches ID, model type, English label and Russian name with case-insensitive trimmed text', () => {
  const state = initial(); const before = structuredClone(state);
  for (const query of ['temperature', 'ТемПеРаТуРа', '  Air Humidity  ', 'ZONE-02-S-co2']) {
    const result = filterSensors(state, { query });
    assert.equal(result.length, query.includes('ZONE-02') ? 1 : 3);
  }
  assert.equal(filterSensors(state, { query: 'освещённость' })[0].type, 'light');
  assert.equal(filterSensors(state, { query: '   ' }).length, 18); assert.deepEqual(state, before);
});

test('zone, availability and search filters combine without mutating readings or metadata', () => {
  const state = initial(); state.sensors.find((s) => s.id === 'ZONE-02-S-humidity').status = 'offline';
  const before = structuredClone(state);
  const result = filterSensors(state, { query: 'влажность воздуха', zoneId: 'ZONE-02', status: 'offline' });
  assert.deepEqual(result.map((s) => s.id), ['ZONE-02-S-humidity']); assert.deepEqual(state, before);
  assert.equal(filterSensors(state, { zoneId: 'ZONE-02', status: 'online' }).length, 5);
  assert.equal(filterSensors(state, { query: 'temperature', status: 'offline' }).length, 0);
  assert.equal(filterSensors(state, { zoneId: 'ZONE-99' }).length, 0);
});

test('Sensors renders filtered actual values, times, offline and an explicit empty table row', () => {
  const state = initial(); state.sensors[0].value = 31; state.sensors[0].status = 'offline';
  const html = sensorRows(state, undefined, { query: 'temperature', zoneId: 'ZONE-01', status: 'offline' });
  assert.match(html, /31/); assert.match(html, /Нет связи/); assert.match(html, /2026-10-19T12:00:00.000Z/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1); assert.doesNotMatch(html, /ZONE-02-S/);
  assert.match(sensorRows(state, undefined, { query: 'no such sensor' }), /Нет датчиков/);
});

test('Zones searches names, IDs and crop labels while retaining the complete original model', () => {
  const state = initial(); const before = structuredClone(state);
  for (const query of ['  tomatoes ', 'ZONE-01', 'ТОМАТЫ']) assert.deepEqual(filterZones(state, query).map((z) => z.id), ['ZONE-01']);
  assert.equal(filterZones(state, '').length, 3); assert.equal(filterZones(state, 'no zone').length, 0);
  const html = zoneCards(state, true, {}, 'cucumbers');
  assert.match(html, /Огурцы/); assert.doesNotMatch(html, /Томаты/); assert.match(html, /Индекс риска/);
  assert.match(html, /data-zone-id="ZONE-02"/); // Цвет зоны сохраняется, даже если видна только её карточка.
  assert.match(zoneCards(state, true, {}, 'no zone'), /Нет зон/); assert.deepEqual(state, before);
  assert.match(sensorRows(state, 'ZONE-01'), /Томаты/); // Выбор подробных показателей не зависит от поиска карточек.
});

test('a new store snapshot immediately changes filter results without any writes from filtering', () => {
  let raw = null; let writes = 0;
  const store = createStore({ storage: { getItem: () => raw, setItem: (_, value) => { raw = value; writes++; } }, now: () => '2026-10-19T12:00:00.000Z' });
  assert.equal(filterSensors(store.getState(), { status: 'offline' }).length, 0);
  store.setSensorStatus('ZONE-01-S-temperature', 'offline'); const before = writes;
  assert.equal(filterSensors(store.getState(), { status: 'offline' }).length, 1);
  filterZones(store.getState(), 'Greens'); sensorRows(store.getState(), undefined, { status: 'offline' });
  assert.equal(writes, before);
});
