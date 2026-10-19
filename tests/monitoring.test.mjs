import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { STORAGE_KEY, validateState, loadState } from '../assets/js/storage.js';

const FIRST = '2026-10-18T12:00:00.000Z';
const ZONE = 'ZONE-01';
function fixture(changes = {}) {
  const seed = createInitialState(FIRST); seed.savedAt = FIRST; seed.simulation.paused = true;
  for (const [type, value] of Object.entries(changes)) seed.sensors.find((s) => s.zoneId === ZONE && s.type === type).value = value;
  const map = new Map([[STORAGE_KEY, JSON.stringify(seed)]]);
  const disk = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  let ms = Date.parse(FIRST); const now = () => new Date(ms).toISOString();
  const store = createStore({ storage: disk, now });
  return { store, disk, now, advance(dt = 5000) { ms += dt; },
    device(type) { return store.getZoneDevices(ZONE).find((d) => d.type === type); },
    alerts() { return store.getState().alerts.filter((a) => a.status === 'open'); },
    measure(changes = {}) {
      ms += 5000;
      return store.recordMeasurements(store.getState().sensors.filter((s) => s.status === 'online').map((s) => ({
        id: s.id, value: s.zoneId === ZONE && Object.hasOwn(changes, s.type) ? changes[s.type] : s.value,
      })), now());
    },
  };
}

for (const collection of ['events', 'alerts']) {
  for (const shape of ['array', 'object']) {
    test(`${collection} rejects ${shape} audit IDs without throwing or overwriting the saved snapshot`, () => {
      const f = fixture({ waterLevel: 10 }); const data = f.store.getState();
      const id = data[collection][0].id;
      data[collection][0].id = shape === 'array' ? [id] : { toString: null };
      let validation;
      assert.doesNotThrow(() => { validation = validateState(data); });
      assert.equal(validation.ok, false);
      const raw = JSON.stringify(data); f.disk.setItem(STORAGE_KEY, raw);
      let loaded;
      assert.doesNotThrow(() => { loaded = loadState({ storage: f.disk, now: f.now }); });
      assert.equal(loaded.status.issue, 'invalid-state');
      const recovered = createStore({ storage: f.disk, now: f.now });
      assert.equal(recovered.getStatus().issue, 'invalid-state');
      assert.equal(recovered.getState().simulation.paused, true);
      assert.equal(f.disk.getItem(STORAGE_KEY), raw);
    });
  }
}

for (const [input, value, type, severity] of [
  ['temperature', 19, 'temperature-low', 'warning'], ['temperature', 29, 'temperature-high', 'warning'],
  ['humidity', 49, 'humidity-low', 'warning'], ['humidity', 81, 'humidity-high', 'warning'],
  ['soil', 34, 'soil-low', 'warning'], ['light', 11000, 'light-low', 'warning'],
  ['co2', 1600, 'co2-high', 'warning'], ['waterLevel', 15, 'water-critical', 'critical'],
]) {
  test(`${type} opens the documented ${severity} alert with zone, sensor, value and threshold`, () => {
    const f = fixture({ [input]: value });
    const alert = f.alerts().find((a) => a.type === type);
    assert.ok(alert); assert.equal(alert.zoneId, ZONE); assert.equal(alert.sensorId, `${ZONE}-S-${input}`);
    assert.equal(alert.value, value); assert.equal(alert.severity, severity); assert.equal(alert.createdAt, FIRST);
    assert.equal(alert.resolvedAt, null); assert.ok(alert.message); assert.ok(alert.reason); assert.ok(Number.isFinite(alert.threshold));
  });
}

test('one uninterrupted violation updates its alert without duplicate records or tick events', () => {
  const f = fixture({ soil: 30 });
  const initial = f.alerts().find((a) => a.type === 'soil-low'); assert.ok(initial);
  const events = f.store.getState().events.length;
  f.measure({ soil: 31 }); f.measure({ soil: 34 });
  const same = f.alerts().find((a) => a.type === 'soil-low');
  assert.equal(same.id, initial.id); assert.equal(same.createdAt, FIRST); assert.equal(same.value, 34);
  assert.equal(f.store.getState().alerts.length, 1); assert.equal(f.store.getState().events.length, events);
});

test('recovery hysteresis resolves only after a stable margin and recurrence creates a new alert', () => {
  const f = fixture({ temperature: 29 });
  const first = f.alerts()[0]; assert.ok(first);
  for (const temperature of [28, 28.1, 27.5]) { f.measure({ temperature }); assert.equal(f.alerts()[0].id, first.id); }
  f.measure({ temperature: 27 });
  const resolved = f.store.getState().alerts.find((a) => a.id === first.id);
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.resolvedAt, f.now());
  assert.ok(f.store.getState().events.some((e) => e.type === 'ALERT_RESOLVED' && e.objectId === first.id));
  f.measure({ temperature: 28 }); assert.equal(f.alerts().length, 0);
  f.measure({ temperature: 29 }); assert.notEqual(f.alerts()[0].id, first.id);
});

test('offline inputs never resolve known threshold violations using old good values', () => {
  const f = fixture({ soil: 30 });
  const first = f.alerts().find((a) => a.type === 'soil-low'); assert.ok(first);
  f.store.setSensorStatus(`${ZONE}-S-soil`, 'offline');
  assert.equal(f.alerts().find((a) => a.id === first.id).value, null);
  assert.equal(f.alerts().find((a) => a.type === 'sensor-unavailable').severity, 'warning');
  f.measure(); assert.equal(f.alerts().find((a) => a.id === first.id).status, 'open');
});

test('water unavailability is Critical, blocks pump and records the real safety shutdown', () => {
  const f = fixture(); f.store.setDeviceState(f.device('pump').id, true); f.advance();
  f.store.setSensorStatus(`${ZONE}-S-waterLevel`, 'offline');
  assert.equal(f.device('pump').isOn, false);
  assert.equal(f.alerts().find((a) => a.type === 'sensor-unavailable').severity, 'critical');
  assert.ok(f.alerts().some((a) => a.type === 'pump-blocked' && a.deviceId === f.device('pump').id));
  assert.ok(f.store.getState().events.some((e) => e.type === 'DEVICE_OFF' && e.source === 'safety' && e.objectId === f.device('pump').id));
});

test('a rejected invalid Manual input is explicitly unavailable and creates an alert without a partial history frame', () => {
  const f = fixture();
  assert.equal(f.measure({ light: NaN }).ok, false);
  assert.equal(f.store.getZoneReadings(ZONE).light.status, 'offline');
  const fault = f.alerts().find((a) => a.type === 'sensor-unavailable'); assert.ok(fault);
  assert.equal(fault.sensorId, `${ZONE}-S-light`); assert.equal(fault.value, null);
  assert.equal(f.store.getState().history.length, 0); assert.equal(validateState(f.store.getState()).ok, true);
});

test('malformed Manual readings reject the frame without coercion and still apply fresh water protection', () => {
  for (const type of ['temperature', 'humidity', 'soil', 'light', 'co2']) {
    const f = fixture(); const before = f.store.getState();
    assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, true);
    let result;
    assert.doesNotThrow(() => { result = f.measure({ [type]: { toString: null }, waterLevel: 10 }); });
    assert.equal(result.ok, false);
    const next = f.store.getState();
    const sensor = next.sensors.find((s) => s.zoneId === ZONE && s.type === type);
    assert.equal(sensor.status, 'offline');
    assert.equal(sensor.value, before.sensors.find((s) => s.id === sensor.id).value);
    assert.equal(sensor.lastUpdatedAt, FIRST);
    assert.equal(f.device('pump').isOn, false);
    assert.equal(next.history.length, before.history.length);
    assert.equal(next.sensors.find((s) => s.zoneId === ZONE && s.type === 'waterLevel').value, 10);
    assert.equal(validateState(next).ok, true);
  }
});

test('scenarios A/B/C create real alerts and sources, then retain resolved history', () => {
  const f = fixture(); f.store.setZoneMode(ZONE, 'auto');
  f.store.applyScenario(ZONE, 'dry-soil');
  assert.equal(f.device('pump').isOn, true); assert.ok(f.alerts().some((a) => a.type === 'soil-low'));
  assert.ok(f.store.getState().events.some((e) => e.source === 'auto' && e.type === 'DEVICE_ON'));
  f.advance(); f.store.applyScenario(ZONE, 'low-water');
  assert.equal(f.device('pump').isOn, false);
  const critical = f.alerts().find((a) => a.type === 'water-critical'); assert.ok(critical);
  const count = f.alerts().length; f.measure({ waterLevel: 14 }); assert.equal(f.alerts().length, count);
  f.advance(); f.store.applyScenario(ZONE, 'restore');
  assert.equal(f.alerts().length, 0);
  assert.equal(f.store.getState().alerts.find((a) => a.id === critical.id).status, 'resolved');
  const events = f.store.getState().events;
  for (const source of ['auto', 'safety', 'scenario', 'operator', 'system']) assert.ok(events.some((e) => e.source === source), source);
  assert.equal(events.filter((e) => e.type === 'SCENARIO_RESTORED').length, 1);
});

test('manual actions, mode changes and settings log actual changes once, with old/new state', () => {
  const f = fixture(); const id = f.device('growLight').id;
  f.store.setDeviceState(id, true); f.store.setDeviceState(id, true);
  f.store.setDeviceState(id, false); f.store.setDeviceState(id, false);
  const actions = f.store.getState().events.filter((e) => e.objectId === id && ['DEVICE_ON', 'DEVICE_OFF'].includes(e.type));
  assert.equal(actions.length, 2); assert.equal(actions[0].source, 'operator');
  assert.equal(actions[0].previousState, 'OFF'); assert.equal(actions[0].newState, 'ON');
  f.store.setZoneMode(ZONE, 'auto'); f.store.setZoneMode(ZONE, 'auto');
  assert.equal(f.store.getState().events.filter((e) => e.type === 'MODE_CHANGED').length, 1);
  const settings = f.store.getState().settings.zones[ZONE]; settings.temperature.max = 23;
  f.store.updateZoneSettings(ZONE, settings); f.store.updateZoneSettings(ZONE, settings);
  f.store.updateZoneSettings(ZONE, Object.fromEntries(Object.entries(settings).reverse()));
  const changed = f.store.getState().events.filter((e) => e.type === 'SETTINGS_CHANGED');
  assert.equal(changed.length, 1); assert.equal(changed[0].source, 'settings');
  assert.ok(f.alerts().some((a) => a.type === 'temperature-high'));
});

test('significant command refusals are recorded with cooldown instead of spamming', () => {
  const f = fixture({ waterLevel: 15 });
  for (let i = 0; i < 5; i++) assert.equal(f.store.setDeviceState(f.device('pump').id, true).ok, false);
  const rejected = () => f.store.getState().events.filter((e) => e.type === 'COMMAND_REJECTED');
  assert.equal(rejected().length, 1); assert.equal(rejected()[0].source, 'safety');
  assert.equal(rejected()[0].previousState, 'OFF'); assert.equal(rejected()[0].newState, 'OFF');
  f.advance(31000); f.store.setDeviceState(f.device('pump').id, true); assert.equal(rejected().length, 2);
  f.store.setZoneMode(ZONE, 'auto'); f.store.setDeviceState(f.device('fan').id, false);
  assert.ok(rejected().some((e) => e.source === 'operator'));
});

test('reload retains open/resolved alerts, events and IDs without duplicate actions or writes', () => {
  const f = fixture({ soil: 30 }); f.measure({ soil: 40 }); f.measure({ waterLevel: 15 });
  const before = f.store.getState(); const raw = f.disk.getItem(STORAGE_KEY);
  f.advance(); const loaded = createStore({ storage: f.disk, now: f.now });
  assert.deepEqual(loaded.getState(), before); assert.equal(f.disk.getItem(STORAGE_KEY), raw);
  loaded.reload(); assert.deepEqual(loaded.getState(), before);
});

test('journal stays bounded and IDs remain unique after pruning and reload', () => {
  const f = fixture();
  for (let i = 0; i < 330; i++) { f.advance(); f.store.setDeviceState(f.device('growLight').id, i % 2 === 0); }
  const before = f.store.getState(); assert.equal(before.events.length, 300);
  const ids = new Set(before.events.map((e) => e.id)); assert.equal(ids.size, 300);
  const loaded = createStore({ storage: f.disk, now: f.now });
  loaded.setDeviceState(f.device('growLight').id, true);
  assert.equal(loaded.getState().events.length, 300); assert.equal(ids.has(loaded.getState().events.at(-1).id), false);
});

test('alert retention removes oldest resolved before any active Critical', () => {
  const f = fixture(); f.store.setSensorStatus(`${ZONE}-S-waterLevel`, 'offline');
  const criticalId = f.alerts().find((a) => a.severity === 'critical')?.id; assert.ok(criticalId);
  for (let i = 0; i < 205; i++) {
    const settings = f.store.getState().settings.zones[ZONE]; settings.soil.min = 50;
    f.advance(); f.store.updateZoneSettings(ZONE, settings);
    settings.soil.min = 35; f.advance(); f.store.updateZoneSettings(ZONE, settings);
  }
  assert.equal(f.store.getState().alerts.length, 200);
  assert.ok(f.alerts().some((a) => a.id === criticalId));
  assert.equal(validateState(f.store.getState()).ok, true);
});

test('v2 migration preserves history, pause, readings, settings and devices', () => {
  const legacy = createInitialState(FIRST); legacy.savedAt = FIRST; legacy.schemaVersion = 2; delete legacy.audit;
  legacy.simulation = { paused: true, lastTickAt: FIRST };
  legacy.history = [{ timestamp: FIRST, sensors: legacy.sensors.map((s) => ({ sensorId: s.id, value: s.value, status: s.status, lastUpdatedAt: s.lastUpdatedAt })) }];
  legacy.devices[0].isOn = true; legacy.settings.zones[ZONE].soil.min = 40;
  let raw = JSON.stringify(legacy);
  const result = loadState({ storage: { getItem: () => raw, setItem: (_, v) => { raw = v; } }, now: () => FIRST });
  assert.equal(result.state.schemaVersion, 3); assert.equal(result.status.source, 'migrated');
  for (const key of ['history', 'simulation', 'sensors', 'settings', 'devices']) assert.deepEqual(result.state[key], legacy[key]);
  assert.equal(validateState(result.state).ok, true);
  const original = JSON.stringify(legacy);
  const failed = loadState({ storage: { getItem: () => original, setItem() { throw new Error('quota'); } }, now: () => FIRST });
  assert.equal(failed.status.persistent, false); assert.deepEqual(failed.state.history, legacy.history);
});

test('malformed journal recovers without erasing raw data; quota failure retains a coherent action and record in memory', () => {
  const f = fixture(); const bad = f.store.getState(); bad.events = [{ id: 'bad', source: 'unknown' }];
  const raw = JSON.stringify(bad); f.disk.setItem(STORAGE_KEY, raw); f.store.reload();
  assert.equal(f.store.getStatus().persistent, false); assert.equal(f.disk.getItem(STORAGE_KEY), raw);
  const g = fixture(); g.disk.setItem = () => { throw new Error('quota'); };
  assert.equal(g.store.setDeviceState(g.device('growLight').id, true).persisted, false);
  assert.equal(g.device('growLight').isOn, true);
  assert.ok(g.store.getState().events.some((e) => e.type === 'DEVICE_ON' && e.objectId === g.device('growLight').id));
});

test('restoring narrow humidity settings resolves high and low alerts and releases Auto humidifier', () => {
  const f = fixture();
  const settings = f.store.getState().settings.zones[ZONE]; settings.humidity = { min: 50, max: 55 };
  f.store.updateZoneSettings(ZONE, settings); f.store.setZoneMode(ZONE, 'auto');
  assert.ok(f.alerts().some((a) => a.type === 'humidity-high'));
  f.advance(); f.store.applyScenario(ZONE, 'restore');
  assert.equal(f.alerts().length, 0); assert.equal(f.store.getZoneReadings(ZONE).humidity.value, 52.5);
  f.advance(); f.store.applyScenario(ZONE, 'low-humidity'); assert.equal(f.device('humidifier').isOn, true);
  f.advance(); f.store.applyScenario(ZONE, 'restore');
  assert.equal(f.alerts().length, 0); assert.equal(f.device('humidifier').isOn, false);
});

test('restored Heater/Fan safety shutdown records the actual conflict instead of a manual reason', () => {
  const state = createInitialState(FIRST); state.savedAt = FIRST;
  for (const d of state.devices.filter((d) => d.zoneId === ZONE && ['heater', 'fan'].includes(d.type))) d.isOn = true;
  const store = createStore({ storage: { getItem: () => JSON.stringify(state), setItem() {} }, now: () => FIRST });
  const shutdowns = store.getState().events.filter((e) => e.type === 'DEVICE_OFF');
  assert.equal(shutdowns.length, 2);
  for (const event of shutdowns) { assert.equal(event.source, 'safety'); assert.match(event.reason, /конфликт Heater\/Fan/); }
});

test('Auto OFF retains its actual source when the same transaction also adds an interlock', () => {
  const f = fixture({ temperature: 30 }); f.store.setZoneMode(ZONE, 'auto');
  assert.equal(f.device('fan').isOn, true);
  f.measure({ temperature: 18 });
  assert.equal(f.device('fan').isOn, false); assert.equal(f.device('heater').isOn, true);
  const event = f.store.getState().events.findLast((e) => e.type === 'DEVICE_OFF' && e.objectId === f.device('fan').id);
  assert.equal(event.source, 'auto'); assert.match(event.reason, /температура 18/);
});

for (const [input, initial, held, recovered, type] of [
  ['temperature', 19, 20.5, 21, 'temperature-low'], ['temperature', 29, 27.5, 27, 'temperature-high'],
  ['humidity', 49, 52, 53, 'humidity-low'], ['humidity', 81, 78, 77, 'humidity-high'],
  ['soil', 34, 37, 38, 'soil-low'], ['light', 11000, 12500, 12600, 'light-low'],
  ['co2', 1600, 1450, 1400, 'co2-high'], ['waterLevel', 15, 16, 17, 'water-critical'],
]) {
  test(`${type} recovers at its release threshold and remains Open inside the recovery band`, () => {
    const f = fixture({ [input]: initial });
    const id = f.alerts().find((a) => a.type === type).id;
    f.measure({ [input]: held }); assert.ok(f.alerts().some((a) => a.id === id));
    f.measure({ [input]: recovered });
    const alert = f.store.getState().alerts.find((a) => a.id === id);
    assert.equal(alert.status, 'resolved'); assert.equal(alert.resolvedAt, f.now());
  });
}

test('sensor recovery closes the same fault record, and corrupted audit relations fail validation', () => {
  const f = fixture(); f.store.setSensorStatus(`${ZONE}-S-co2`, 'offline');
  const id = f.alerts().find((a) => a.type === 'sensor-unavailable').id;
  f.advance(); f.store.setSensorStatus(`${ZONE}-S-co2`, 'online');
  assert.equal(f.store.getState().alerts.find((a) => a.id === id).status, 'resolved');
  const valid = f.store.getState();
  for (const mutate of [
    (s) => { s.alerts[0].sensorId = 'ZONE-99-S-co2'; },
    (s) => { s.alerts[0].resolvedAt = 'invalid'; },
    (s) => { s.audit.nextId = 1; },
    (s) => { s.events.push(s.events[0]); },
  ]) {
    const bad = structuredClone(valid); mutate(bad); assert.equal(validateState(bad).ok, false);
  }
});
