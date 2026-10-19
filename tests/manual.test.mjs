import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, SENSOR_TYPES } from '../assets/js/data.js';
import { STORAGE_KEY } from '../assets/js/storage.js';
import { createStore } from '../assets/js/store.js';
import { simulateReadings, createSimulator } from '../assets/js/simulator.js';
import { pumpBlockReason } from '../assets/js/safety.js';
import { deviceCards, zoneCards } from '../assets/js/views.js';

const FIRST = '2026-10-18T12:00:00.000Z';
function fixture(saved = createInitialState(FIRST)) {
  saved.savedAt = FIRST;
  const map = new Map([[STORAGE_KEY, JSON.stringify(saved)]]);
  const disk = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
  let ms = Date.parse(FIRST);
  const now = () => new Date(ms).toISOString();
  const store = createStore({ storage: disk, now });
  return { store, disk, now, advance() { ms += 5000; }, device(type, zone = 'ZONE-01') { return store.getZoneDevices(zone).find((d) => d.type === type); } };
}
function water(state, zone = 'ZONE-01') { return state.sensors.find((s) => s.zoneId === zone && s.type === 'waterLevel'); }

for (const type of ['pump', 'fan', 'growLight', 'humidifier', 'heater', 'vent']) {
  test(`manual ${type} ON/OFF persists metadata without changing another zone`, () => {
    const f = fixture(); f.advance();
    const other = f.store.getZoneDevices('ZONE-02');
    assert.equal(f.store.setDeviceState(f.device(type).id, true).ok, true);
    assert.equal(f.device(type).isOn, true);
    assert.equal(f.device(type).source, 'manual');
    assert.equal(f.device(type).changedAt, f.now());
    assert.deepEqual(f.store.getZoneDevices('ZONE-02'), other);
    const reloaded = createStore({ storage: f.disk, now: f.now });
    assert.equal(reloaded.getZoneDevices('ZONE-01').find((d) => d.type === type).isOn, true);
    assert.equal(reloaded.getState().zones[0].mode, 'manual');
    f.advance();
    assert.equal(f.store.setDeviceState(f.device(type).id, false).ok, true);
    assert.equal(f.device(type).isOn, false);
  });
}

test('pump uses zone threshold, blocks at equality and cannot be forced through store API', () => {
  const state = createInitialState(FIRST);
  state.settings.zones['ZONE-01'].waterLevel.critical = 40;
  water(state).value = 40;
  const f = fixture(state);
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, false);
  assert.equal(f.device('pump').isOn, false);
  assert.ok(f.device('pump').blockedReason);
  assert.equal(f.store.setDeviceState(f.device('pump', 'ZONE-02').id, true).ok, true);
});

test('pump shuts off and persists safety source as soon as a new water reading reaches critical', () => {
  const f = fixture();
  f.store.setDeviceState(f.device('pump').id, true); f.advance();
  const batch = simulateReadings(f.store.getState(), { random: () => 0.5 });
  batch.find((patch) => patch.id === water(f.store.getState()).id).value = 15;
  assert.equal(f.store.recordMeasurements(batch, f.now()).ok, true);
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.device('pump').source, 'system');
  assert.equal(f.device('pump').changedAt, f.now());
  assert.ok(f.device('pump').blockedReason);
  assert.equal(JSON.parse(f.disk.getItem(STORAGE_KEY)).devices.find((d) => d.id === f.device('pump').id).isOn, false);
  assert.equal(f.store.getState().history.length, 1);
});

test('offline water stops a running pump and invalid water measurements become offline', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true); f.advance();
  assert.equal(f.store.setSensorStatus(water(f.store.getState()).id, 'offline').ok, true);
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, false);
  const g = fixture(); g.store.setDeviceState(g.device('pump').id, true); g.advance();
  const batch = simulateReadings(g.store.getState(), { random: () => 0.5 });
  batch.find((patch) => patch.id === water(g.store.getState()).id).value = NaN;
  assert.equal(g.store.recordMeasurements(batch, g.now()).ok, true);
  assert.equal(water(g.store.getState()).status, 'offline');
  assert.equal(water(g.store.getState()).lastUpdatedAt, FIRST);
  assert.equal(g.device('pump').isOn, false);
});

for (const value of [NaN, 15]) {
  test(`rejected mixed batch still applies water safety (${value}) without recording a partial history frame`, () => {
    const f = fixture(); f.store.setDeviceState(f.device('pump').id, true); f.advance();
    const before = f.store.getState();
    const batch = simulateReadings(before, { random: () => 0.5 });
    batch.find((patch) => patch.id === water(before).id).value = value;
    batch.find((patch) => patch.id === before.sensors.find((s) => s.type === 'temperature').id).value = NaN;
    assert.equal(f.store.recordMeasurements(batch, f.now()).ok, false);
    assert.equal(f.device('pump').isOn, false);
    assert.equal(f.device('pump').source, 'system');
    assert.ok(f.device('pump').blockedReason);
    assert.deepEqual(f.store.getState().history, before.history);
    assert.deepEqual(f.store.getState().sensors.find((s) => s.type === 'temperature'), before.sensors.find((s) => s.type === 'temperature'));
    assert.equal(water(f.store.getState()).status, Number.isFinite(value) ? 'online' : 'offline');
    const restored = createStore({ storage: f.disk, now: f.now });
    assert.equal(restored.getZoneDevices('ZONE-01').find((d) => d.type === 'pump').isOn, false);
  });
}

test('cleared conflicts remove obsolete safety messages', () => {
  const f = fixture();
  f.store.setDeviceState(f.device('fan').id, true);
  assert.match(f.store.getStatus().safetyMessage, /вентилятор/);
  f.store.setDeviceState(f.device('fan').id, false);
  assert.equal(f.store.getStatus().safetyMessage, null);
});

test('missing, offline and unreliable water all produce a safety reason', () => {
  for (const mutate of [
    (s) => { s.sensors = s.sensors.filter((sensor) => sensor !== water(s)); },
    (s) => { water(s).status = 'offline'; },
    (s) => { water(s).value = NaN; },
    (s) => { water(s).value = -1; },
    (s) => { water(s).value = 101; },
    (s) => { water(s).unit = 'litres'; },
    (s) => { water(s).lastUpdatedAt = 'invalid'; },
    (s) => { water(s).lastUpdatedAt = '2026-10-18'; },
  ]) {
    const state = createInitialState(FIRST); mutate(state);
    assert.ok(pumpBlockReason(state, 'ZONE-01'));
  }
});

test('load rechecks running pump and heater/fan conflict without erasing sensor history', () => {
  const f = fixture(); f.advance();
  f.store.recordMeasurements(simulateReadings(f.store.getState(), { random: () => 0.5 }), f.now());
  const unsafe = f.store.getState();
  water(unsafe).value = 15;
  for (const device of unsafe.devices.filter((d) => d.zoneId === 'ZONE-01' && ['pump', 'fan', 'heater'].includes(d.type))) device.isOn = true;
  const g = fixture(unsafe);
  assert.ok(g.store.getZoneDevices('ZONE-01').filter((d) => ['pump', 'fan', 'heater'].includes(d.type)).every((d) => !d.isOn));
  assert.deepEqual(g.store.getState().history, unsafe.history);
  assert.ok(g.store.getStatus().safetyMessage);
});

test('heater/fan rejects the second ON in either order and permits recovery after OFF', () => {
  for (const [first, second] of [['fan', 'heater'], ['heater', 'fan']]) {
    const f = fixture();
    assert.equal(f.store.setDeviceState(f.device(first).id, true).ok, true);
    const result = f.store.setDeviceState(f.device(second).id, true);
    assert.equal(result.ok, false); assert.ok(result.message);
    assert.equal(f.device(first).isOn, true); assert.equal(f.device(second).isOn, false);
    f.store.setDeviceState(f.device(first).id, false);
    assert.equal(f.store.setDeviceState(f.device(second).id, true).ok, true);
  }
});

test('restored Auto rejects manual commands and can explicitly return to safe Manual', () => {
  const state = createInitialState(FIRST); state.zones[0].mode = 'auto'; state.devices[0].isOn = true;
  const f = fixture(state);
  assert.equal(f.device('pump').isOn, true);
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, false);
  assert.equal(f.store.setZoneMode('ZONE-01', 'auto').ok, true);
  assert.equal(f.store.setZoneMode('ZONE-01', 'manual').ok, true);
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, true);
});

test('threshold changes reapply pump safety and quota failure keeps the safe state in memory', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true); f.advance();
  f.disk.setItem = () => { throw new Error('quota'); };
  const settings = f.store.getState().settings.zones['ZONE-01']; settings.waterLevel.critical = 80;
  const result = f.store.updateZoneSettings('ZONE-01', settings);
  assert.equal(result.ok, true); assert.equal(result.persisted, false);
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.store.getStatus().persistent, false);
});

test('untrusted recovered model cannot enable devices using fallback demo water', () => {
  const f = fixture(); f.disk.setItem(STORAGE_KEY, '{broken'); f.store.reload();
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, false);
  assert.equal(f.store.getState().devices.every((d) => !d.isOn), true);
});

const effects = [
  ['pump', 'soil', 43], ['fan', 'temperature', 24.4], ['growLight', 'light', 19200],
  ['humidifier', 'humidity', 67.8], ['heater', 'temperature', 25.2], ['vent', 'co2', 800],
];
for (const [type, sensorType, expected] of effects) {
  test(`${type} causes the expected small effect only in its own zone`, () => {
    const f = fixture(); f.store.setDeviceState(f.device(type).id, true);
    const state = f.store.getState();
    const batch = simulateReadings(state, { random: () => 0.5 });
    const sensor = state.sensors.find((s) => s.zoneId === 'ZONE-01' && s.type === sensorType);
    assert.equal(batch.find((p) => p.id === sensor.id).value, expected);
    if (type === 'pump') assert.equal(batch.find((p) => p.id === water(state).id).value, 71.7);
    const other = state.sensors.find((s) => s.zoneId === 'ZONE-02' && s.type === sensorType);
    assert.equal(batch.find((p) => p.id === other.id).value, other.value);
  });
}

test('actuator effects respect pause, one step, ranges and history persistence', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true);
  const jobs = new Map();
  const simulator = createSimulator(f.store, { now: f.now, random: () => 0.5,
    setInterval: (fn) => { jobs.set(1, fn); return 1; }, clearInterval: (id) => jobs.delete(id) });
  simulator.start(); simulator.pause();
  const frozen = f.store.getState().sensors; f.advance();
  assert.equal(jobs.size, 0); assert.deepEqual(f.store.getState().sensors, frozen);
  assert.equal(simulator.step().ok, true);
  assert.equal(f.store.getState().history.length, 1);
  assert.equal(f.store.getZoneReadings('ZONE-01').soil.value, 43);
  assert.deepEqual(createStore({ storage: f.disk, now: f.now }).getState().history, f.store.getState().history);
  const extreme = f.store.getState();
  for (const sensor of extreme.sensors) sensor.value = SENSOR_TYPES.find((t) => t.type === sensor.type).max;
  for (const patch of simulateReadings(extreme, { random: () => 1 })) {
    const sensor = extreme.sensors.find((s) => s.id === patch.id); const definition = SENSOR_TYPES.find((t) => t.type === sensor.type);
    assert.ok(patch.value >= definition.min && patch.value <= definition.max);
  }
  simulator.dispose();
});

test('Control renders usable manual switches and escaped metadata; Zones counts active devices', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true);
  const html = deviceCards(f.store.getState(), 'ZONE-01');
  assert.match(html, /ON/); assert.match(html, /Оператор/); assert.match(html, /18\.10\.2026/);
  assert.match(zoneCards(f.store.getState(), true), /1 \/ 6 устройств ON/);
});

test('Control disables blocked ON but renders the reason safely as text', () => {
  const f = fixture(); f.store.setDeviceState(f.device('fan').id, true);
  const state = f.store.getState();
  state.devices.find((d) => d.zoneId === 'ZONE-01' && d.type === 'heater').blockedReason = '<img onerror="bad()">';
  const html = deviceCards(state, 'ZONE-01');
  assert.equal((html.match(/ disabled/g) ?? []).length, 1);
  assert.match(html, /BLOCKED/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});
