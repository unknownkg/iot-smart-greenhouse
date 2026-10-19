import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { STORAGE_KEY, validateState } from '../assets/js/storage.js';
import { createStore } from '../assets/js/store.js';
import { createSimulator } from '../assets/js/simulator.js';

const FIRST = '2026-10-18T12:00:00.000Z';
const ZONE = 'ZONE-01';
function fixture(changes = {}, mode = 'manual') {
  const state = createInitialState(FIRST); state.savedAt = FIRST; state.simulation.paused = true;
  state.zones[0].mode = mode;
  for (const [type, value] of Object.entries(changes)) state.sensors.find((s) => s.zoneId === ZONE && s.type === type).value = value;
  const map = new Map([[STORAGE_KEY, JSON.stringify(state)]]);
  const disk = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  let ms = Date.parse(FIRST);
  const now = () => new Date(ms).toISOString();
  const store = createStore({ storage: disk, now });
  const device = (type, zone = ZONE) => store.getZoneDevices(zone).find((d) => d.type === type);
  function measure(changes, zone = ZONE) {
    ms += 5000;
    return store.recordMeasurements(store.getState().sensors.filter((s) => s.status === 'online')
      .map((s) => ({ id: s.id, value: s.zoneId === zone && Object.hasOwn(changes, s.type) ? changes[s.type] : s.value })), now());
  }
  return { store, disk, now, device, measure };
}

test('entering Auto immediately irrigates dry soil and persists mode without creating a measurement', () => {
  const f = fixture({ soil: 30 });
  const before = f.store.getState();
  assert.equal(f.store.setZoneMode(ZONE, 'auto').ok, true);
  assert.equal(f.device('pump').isOn, true);
  assert.equal(f.device('pump').source, 'automation');
  assert.deepEqual(f.store.getState().sensors, before.sensors);
  assert.deepEqual(f.store.getState().history, []);
  assert.equal(f.store.getState().simulation.paused, true);
  const restored = createStore({ storage: f.disk, now: f.now });
  assert.equal(restored.getState().zones[0].mode, 'auto');
  assert.equal(restored.getZoneDevices(ZONE).find((d) => d.type === 'pump').isOn, true);
  assert.deepEqual(f.store.getZoneDevices('ZONE-02'), before.devices.filter((d) => d.zoneId === 'ZONE-02'));
});

test('pump keeps its latch between soil thresholds and stops exactly at soil max', () => {
  const f = fixture({ soil: 30 }, 'auto');
  assert.equal(f.device('pump').isOn, true);
  const since = f.device('pump').changedAt;
  f.measure({ soil: 35 }); assert.equal(f.device('pump').isOn, true);
  f.measure({ soil: 74.9 }); assert.equal(f.device('pump').isOn, true);
  assert.equal(f.device('pump').changedAt, since);
  f.measure({ soil: 75 }); assert.equal(f.device('pump').isOn, false);
  f.measure({ soil: 35 }); assert.equal(f.device('pump').isOn, false);
  f.measure({ soil: 34.9 }); assert.equal(f.device('pump').isOn, true);
});

for (const [input, low, device] of [['temperature', 30, 'fan'], ['temperature', 18, 'heater'],
  ['light', 10000, 'growLight'], ['humidity', 40, 'humidifier'], ['co2', 1600, 'vent']]) {
  test(`Auto reacts to ${input}=${low} with ${device}`, () => {
    const f = fixture({ [input]: low }, 'auto');
    assert.equal(f.device(device).isOn, true);
    assert.equal(f.device(device).source, 'automation');
  });
}

test('temperature hysteresis avoids chatter and handles hot-to-cold transitions without a conflict', () => {
  const f = fixture({ temperature: 29 }, 'auto');
  for (const v of [28, 28.1, 27.5]) { f.measure({ temperature: v }); assert.equal(f.device('fan').isOn, true); }
  f.measure({ temperature: 27 }); assert.equal(f.device('fan').isOn, false);
  f.measure({ temperature: 28 }); assert.equal(f.device('fan').isOn, false);
  f.measure({ temperature: 19 }); assert.equal(f.device('heater').isOn, true);
  for (const v of [20, 20.2, 20.9]) { f.measure({ temperature: v }); assert.equal(f.device('heater').isOn, true); }
  f.measure({ temperature: 21 }); assert.equal(f.device('heater').isOn, false);
  for (const v of [30, 18, 30, 18]) {
    f.measure({ temperature: v });
    assert.equal(f.device('fan').isOn, v === 30); assert.equal(f.device('heater').isOn, v === 18);
    assert.equal(f.device(v === 30 ? 'fan' : 'heater').source, 'automation');
  }
});

for (const [type, initial, held, released, device] of [
  ['light', 11000, 12599, 12600, 'growLight'],
  ['humidity', 49, 52.9, 53, 'humidifier'],
  ['co2', 1501, 1401, 1400, 'vent'],
]) {
  test(`${device} uses distinct start and release thresholds`, () => {
    const f = fixture({ [type]: initial }, 'auto');
    assert.equal(f.device(device).isOn, true);
    f.measure({ [type]: held }); assert.equal(f.device(device).isOn, true);
    f.measure({ [type]: released }); assert.equal(f.device(device).isOn, false);
    f.measure({ [type]: held }); assert.equal(f.device(device).isOn, false);
  });
}

test('Auto closes vent while heating and resumes CO2 ventilation when heating is no longer needed', () => {
  const f = fixture({ temperature: 19, co2: 1600 }, 'auto');
  assert.equal(f.device('heater').isOn, true); assert.equal(f.device('vent').isOn, false);
  f.measure({ temperature: 21 });
  assert.equal(f.device('heater').isOn, false); assert.equal(f.device('vent').isOn, true);
});

test('Auto rejects both manual ON and OFF; returning to Manual turns all zone devices off', () => {
  const f = fixture({ soil: 30, temperature: 30, light: 1000 }, 'auto');
  for (const d of f.store.getZoneDevices(ZONE)) {
    assert.equal(f.store.setDeviceState(d.id, true).ok, false);
    assert.equal(f.store.setDeviceState(d.id, false).ok, false);
  }
  assert.equal(f.store.setZoneMode(ZONE, 'manual').ok, true);
  assert.ok(f.store.getZoneDevices(ZONE).every((d) => !d.isOn));
  assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, true);
  f.store.setZoneMode(ZONE, 'manual');
  assert.equal(f.device('pump').isOn, true, 'reselecting same mode is not a shutdown command');
});

test('water safety wins over dry soil and a running Auto pump cannot bypass protection', () => {
  const f = fixture({ soil: 30 }, 'auto');
  f.measure({ waterLevel: 15 });
  assert.equal(f.device('pump').isOn, false); assert.ok(f.device('pump').blockedReason);
  assert.equal(f.device('pump').source, 'system');
  f.measure({ waterLevel: 14 }); assert.equal(f.device('pump').isOn, false);
  f.measure({ waterLevel: 60 }); assert.equal(f.device('pump').isOn, true);
});

for (const [type, device] of [['soil', 'pump'], ['waterLevel', 'pump'], ['temperature', 'fan'],
  ['temperature', 'heater'], ['light', 'growLight'], ['humidity', 'humidifier'], ['co2', 'vent']]) {
  test(`offline ${type} safely stops Auto ${device}`, () => {
    const f = fixture({ soil: 30, temperature: device === 'heater' ? 18 : 30, light: 1000, humidity: 40, co2: 1800 }, 'auto');
    assert.equal(f.device(device).isOn, true);
    const sensor = f.store.getState().sensors.find((s) => s.zoneId === ZONE && s.type === type);
    f.store.setSensorStatus(sensor.id, 'offline');
    assert.equal(f.device(device).isOn, false); assert.ok(f.device(device).blockedReason);
  });
}

test('unreliable Auto inputs become offline without using previous values to make decisions', () => {
  const f = fixture({ soil: 30, temperature: 30, light: 1000, humidity: 40, co2: 1800 }, 'auto');
  assert.equal(f.measure({ soil: NaN, temperature: NaN, light: Infinity, humidity: -1, co2: 100001 }).ok, true);
  assert.ok(f.store.getZoneDevices(ZONE).every((d) => !d.isOn));
  assert.equal(validateState(f.store.getState()).ok, true);
});

test('failed packets still stop unsafe Auto devices when another Manual zone has invalid readings', () => {
  const f = fixture({ soil: 30, temperature: 30 }, 'auto');
  assert.equal(f.device('pump').isOn, true);
  const batch = f.store.getState().sensors.map((s) => ({ id: s.id, value: s.value }));
  batch.find((p) => p.id === `${ZONE}-S-soil`).value = NaN;
  batch.find((p) => p.id === 'ZONE-02-S-temperature').value = NaN;
  assert.equal(f.store.recordMeasurements(batch, '2026-10-18T12:00:05.000Z').ok, false);
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.store.getState().history.length, 0);
});

test('threshold changes immediately reevaluate Auto on pause and preserve readings/history', () => {
  const f = fixture({ temperature: 27 }, 'auto');
  const before = f.store.getState();
  const settings = before.settings.zones[ZONE]; settings.temperature.max = 26;
  assert.equal(f.store.updateZoneSettings(ZONE, settings).ok, true);
  assert.equal(f.device('fan').isOn, true);
  assert.deepEqual(f.store.getState().history, before.history);
  assert.deepEqual(f.store.getState().sensors, before.sensors);
  const bad = structuredClone(settings); bad.temperature.min = 27;
  assert.equal(f.store.updateZoneSettings(ZONE, bad).ok, false);
});

test('narrow threshold intervals have non-overlapping hysteresis and boundary values remain stable', () => {
  const f = fixture({ temperature: 20.1 }, 'auto');
  const settings = f.store.getState().settings.zones[ZONE]; settings.temperature = { min: 20, max: 20.2 };
  settings.humidity = { min: 50, max: 50.1 }; settings.light.min = 200000; settings.co2.max = 0;
  f.store.updateZoneSettings(ZONE, settings);
  for (const v of [21, 20.1, 19, 20.1]) {
    f.measure({ temperature: v });
    assert.ok(!(f.device('fan').isOn && f.device('heater').isOn));
    if (v === 21) assert.equal(f.device('fan').isOn, true);
    if (v === 19) assert.equal(f.device('heater').isOn, true);
  }
  f.measure({ light: 200000, co2: 0 });
  assert.equal(f.device('growLight').isOn, false); assert.equal(f.device('vent').isOn, false);
});

test('Auto uses one simulator timer and one paused step; no fake operational records are created', () => {
  const f = fixture({ soil: 30 }, 'auto');
  const jobs = new Map(); let count = 0;
  const sim = createSimulator(f.store, { random: () => 0.5, now: () => '2026-10-18T12:00:05.000Z',
    setInterval: (fn) => { jobs.set(++count, fn); return count; }, clearInterval: (id) => jobs.delete(id) });
  sim.start(); assert.equal(jobs.size, 0);
  sim.step(); assert.equal(f.store.getState().history.length, 1);
  assert.equal(f.store.getZoneReadings(ZONE).soil.value, 31);
  sim.resume(); f.store.setZoneMode('ZONE-02', 'auto'); assert.equal(jobs.size, 1);
  assert.deepEqual(f.store.getState().alerts, []); assert.deepEqual(f.store.getState().events, []);
  sim.dispose();
});

test('an incomplete frame cannot discard a unique fresh critical water input in Manual', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true);
  const batch = f.store.getState().sensors.filter((s) => s.id !== 'ZONE-03-S-light').map((s) => ({ id: s.id, value: s.value }));
  batch.find((p) => p.id === `${ZONE}-S-waterLevel`).value = 0;
  assert.equal(f.store.recordMeasurements(batch, '2026-10-18T12:00:05.000Z').ok, false);
  assert.equal(f.device('pump').isOn, false); assert.ok(f.device('pump').blockedReason);
  assert.equal(f.store.getState().history.length, 0);
  assert.equal(JSON.parse(f.disk.getItem(STORAGE_KEY)).devices.find((d) => d.id === f.device('pump').id).isOn, false);
});

test('duplicate water inputs fail closed, while stale partial readings cannot replace a newer water value', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true);
  f.store.recordMeasurements([{ id: `${ZONE}-S-waterLevel`, value: 0 }, { id: `${ZONE}-S-waterLevel`, value: 72 }], '2026-10-18T12:00:05.000Z');
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.store.getZoneReadings(ZONE).waterLevel.status, 'offline');
  const g = fixture(); g.measure({ waterLevel: 60 }); g.store.setDeviceState(g.device('pump').id, true);
  g.store.recordMeasurements([{ id: `${ZONE}-S-waterLevel`, value: 0 }], FIRST);
  assert.equal(g.store.getZoneReadings(ZONE).waterLevel.value, 60);
  assert.equal(g.device('pump').isOn, true);
});
