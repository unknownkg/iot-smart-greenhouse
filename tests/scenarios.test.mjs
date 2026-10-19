import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { STORAGE_KEY, validateState } from '../assets/js/storage.js';
import { createSimulator } from '../assets/js/simulator.js';

const FIRST = '2026-10-18T12:00:00.000Z';
const ZONE = 'ZONE-02';
function fixture() {
  const state = createInitialState(FIRST); state.savedAt = FIRST; state.simulation.paused = true;
  const data = new Map([[STORAGE_KEY, JSON.stringify(state)]]);
  const disk = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  let ms = Date.parse(FIRST);
  const now = () => new Date(ms).toISOString();
  const store = createStore({ storage: disk, now });
  return { store, disk, now, advance() { ms += 5000; }, device(type) { return store.getZoneDevices(ZONE).find((d) => d.type === type); } };
}

const scenarios = [
  ['dry-soil', 'soil', 30, 'pump'], ['low-water', 'waterLevel', 15, null],
  ['overheat', 'temperature', 30, 'fan'], ['cold', 'temperature', 18, 'heater'],
  ['low-light', 'light', 10800, 'growLight'], ['low-humidity', 'humidity', 45, 'humidifier'],
  ['high-co2', 'co2', 1650, 'vent'],
];
for (const [id, sensorType, value, expectedDevice] of scenarios) {
  test(`${id} supplies reproducible inputs and applies real zone Auto rules`, () => {
    const f = fixture();
    assert.equal(typeof f.store.applyScenario, 'function');
    f.store.setZoneMode(ZONE, 'auto');
    const other = f.store.getZoneReadings('ZONE-01');
    const result = f.store.applyScenario(ZONE, id);
    assert.equal(result.ok, true, result.message);
    assert.equal(f.store.getZoneReadings(ZONE)[sensorType].value, value);
    if (expectedDevice) assert.equal(f.device(expectedDevice).isOn, true);
    else { assert.equal(f.device('pump').isOn, false); assert.ok(f.device('pump').blockedReason); }
    const readings = Object.fromEntries(Object.entries(f.store.getZoneReadings(ZONE)).map(([k, v]) => [k, v.value]));
    f.advance(); f.store.applyScenario(ZONE, id);
    assert.deepEqual(Object.fromEntries(Object.entries(f.store.getZoneReadings(ZONE)).map(([k, v]) => [k, v.value])), readings);
    // Согласованный срез обновляет время измерений, но не значения других зон.
    for (const [type, sensor] of Object.entries(other)) assert.equal(f.store.getZoneReadings('ZONE-01')[type].value, sensor.value);
    assert.equal(f.store.getState().simulation.paused, true);
    assert.equal(f.store.getState().history.length, 2);
    assert.equal(validateState(f.store.getState()).ok, true);
    const restored = createStore({ storage: f.disk, now: f.now });
    assert.deepEqual(restored.getState().history, f.store.getState().history);
  });
}

test('scenario in Manual changes measurements, never enables devices or secretly changes mode', () => {
  const f = fixture(); assert.equal(typeof f.store.applyScenario, 'function');
  f.store.applyScenario(ZONE, 'dry-soil');
  assert.ok(f.store.getZoneDevices(ZONE).every((d) => !d.isOn));
  assert.equal(f.store.getState().zones[1].mode, 'manual');
});

test('restore teaching conditions preserves mode, thresholds, pause and all accumulated history', () => {
  const f = fixture(); assert.equal(typeof f.store.applyScenario, 'function');
  f.store.setZoneMode(ZONE, 'auto'); f.store.applyScenario(ZONE, 'overheat'); f.advance();
  const history = f.store.getState().history;
  const settings = f.store.getState().settings.zones[ZONE]; settings.temperature.max = 29;
  f.store.updateZoneSettings(ZONE, settings);
  assert.equal(f.store.applyScenario(ZONE, 'restore').ok, true);
  assert.equal(f.store.getZoneReadings(ZONE).temperature.value, 25.2);
  assert.equal(f.device('fan').isOn, false);
  assert.equal(f.store.getState().history.length, 2);
  assert.deepEqual(f.store.getState().history[0], history[0]);
  assert.equal(f.store.getState().zones[1].mode, 'auto');
  assert.deepEqual(f.store.getState().settings.zones[ZONE], settings);
});

test('scenarios retain offline sensors and cannot circumvent missing water safety', () => {
  const f = fixture(); assert.equal(typeof f.store.applyScenario, 'function');
  const before = f.store.getZoneReadings(ZONE).waterLevel;
  f.store.setSensorStatus(before.id, 'offline'); f.store.setZoneMode(ZONE, 'auto');
  f.advance(); assert.equal(f.store.applyScenario(ZONE, 'dry-soil').ok, true);
  assert.equal(f.device('pump').isOn, false);
  assert.deepEqual(f.store.getZoneReadings(ZONE).waterLevel, { ...before, status: 'offline' });
  assert.equal(f.store.applyScenario(ZONE, 'low-water').ok, false, 'cannot pretend an offline input was received');
});

test('scenarios use current thresholds and reject demonstrations impossible at sensor boundaries', () => {
  const f = fixture(); assert.equal(typeof f.store.applyScenario, 'function');
  const settings = f.store.getState().settings.zones[ZONE]; settings.soil.min = 45;
  f.store.updateZoneSettings(ZONE, settings); f.store.setZoneMode(ZONE, 'auto');
  f.store.applyScenario(ZONE, 'dry-soil');
  assert.equal(f.store.getZoneReadings(ZONE).soil.value, 40);
  assert.equal(f.device('pump').isOn, true);
  settings.temperature.max = 80; f.store.updateZoneSettings(ZONE, settings);
  const before = f.store.getState();
  const result = f.store.applyScenario(ZONE, 'overheat');
  assert.equal(result.ok, false); assert.ok(result.message);
  assert.deepEqual(f.store.getState(), before);
  assert.equal(f.store.applyScenario(ZONE, 'unknown').ok, false);
  assert.equal(f.store.applyScenario('ZONE-99', 'cold').ok, false);
});

test('paused scenario plus one step advances one frame with actuator effects', () => {
  const f = fixture(); assert.equal(typeof f.store.applyScenario, 'function');
  f.store.setZoneMode(ZONE, 'auto'); f.store.applyScenario(ZONE, 'dry-soil');
  const sim = createSimulator(f.store, { now: f.now, random: () => 0.5,
    setInterval: () => { throw new Error('Unexpected background timer'); }, clearInterval() {} });
  sim.start(); f.advance();
  assert.equal(sim.step().ok, true);
  assert.equal(f.store.getState().history.length, 2);
  assert.equal(f.store.getZoneReadings(ZONE).soil.value, 31);
  sim.dispose();
});

test('scenarios near sensor limits use reachable triggering inputs instead of rejecting valid demonstrations', () => {
  const f = fixture();
  const settings = f.store.getState().settings.zones[ZONE];
  settings.soil.min = 2; settings.humidity.min = 2;
  settings.temperature = { min: -49, max: 79 }; settings.co2.max = 99999;
  f.store.updateZoneSettings(ZONE, settings); f.store.setZoneMode(ZONE, 'auto');
  for (const [id, type, value] of [['dry-soil', 'soil', 0], ['low-humidity', 'humidity', 0],
    ['cold', 'temperature', -50], ['overheat', 'temperature', 80], ['high-co2', 'co2', 100000]]) {
    const result = f.store.applyScenario(ZONE, id);
    assert.equal(result.ok, true, `${id}: ${result.message}`);
    assert.equal(f.store.getZoneReadings(ZONE)[type].value, value);
    f.advance();
  }
});
