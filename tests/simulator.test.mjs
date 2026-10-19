import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, SENSOR_TYPES, HISTORY_LIMIT, SCHEMA_VERSION } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { STORAGE_KEY, loadState, validateState } from '../assets/js/storage.js';
import { simulateReadings, createSimulator } from '../assets/js/simulator.js';
import { buildDashboardModel, sensorRows, zoneCards } from '../assets/js/views.js';

const FIRST = '2026-10-18T12:00:00.000Z';
function storage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
}
function fixture(saved) {
  const disk = storage();
  if (saved) disk.setItem(STORAGE_KEY, JSON.stringify(saved));
  let milliseconds = Date.parse(FIRST);
  const now = () => new Date(milliseconds).toISOString();
  const store = createStore({ storage: disk, now });
  let nextId = 0;
  const jobs = new Map();
  const scheduler = {
    setInterval(fn, delay) { assert.equal(delay, 5000); jobs.set(++nextId, fn); return nextId; },
    clearInterval(id) { jobs.delete(id); },
  };
  const simulator = createSimulator(store, { now, random: () => 0.9, ...scheduler });
  return { store, disk, now, simulator, jobs, advance(ms = 5000) { milliseconds += ms; }, fire() { for (const fn of [...jobs.values()]) fn(); } };
}

test('all online sensors get bounded small independent readings; source is not mutated', () => {
  const state = createInitialState(FIRST);
  const before = structuredClone(state);
  let draw = 0;
  const batch = simulateReadings(state, { random: () => (++draw % 19) / 19 });
  assert.equal(batch.length, 18);
  assert.deepEqual(state, before);
  const deltas = state.zones.map((zone) => {
    const sensor = state.sensors.find((s) => s.zoneId === zone.id && s.type === 'temperature');
    return +(batch.find((s) => s.id === sensor.id).value - sensor.value).toFixed(2);
  });
  assert.equal(new Set(deltas).size, 3);
  const limits = { temperature: 0.2, humidity: 0.5, soil: 0.2, light: 200, co2: 8, waterLevel: 0.08 };
  for (const patch of batch) {
    const sensor = state.sensors.find((s) => s.id === patch.id);
    const type = SENSOR_TYPES.find((t) => t.type === sensor.type);
    assert.ok(patch.value >= type.min && patch.value <= type.max);
    assert.ok(Math.abs(patch.value - sensor.value) <= limits[sensor.type] + 1e-8);
    if (sensor.type === 'waterLevel') assert.ok(patch.value < sensor.value);
  }
});

test('simulation clamps extremes, percentages and depleted water even after many steps', () => {
  const f = fixture();
  f.simulator.pause();
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) { f.advance(); assert.equal(f.simulator.step().ok, true); }
  const state = f.store.getState();
  assert.equal(state.history.length, HISTORY_LIMIT);
  assert.equal(state.history[0].timestamp, '2026-10-18T12:00:30.000Z');
  assert.equal(state.history.at(-1).timestamp, f.now());
  assert.equal(validateState(state).ok, true);
  assert.ok(state.devices.every((d) => d.isOn === false));
  for (const sensor of state.sensors) {
    const type = SENSOR_TYPES.find((t) => t.type === sensor.type);
    sensor.value = sensor.type === 'waterLevel' ? 0 : type.max;
  }
  for (const patch of simulateReadings(state, { random: () => 1 })) {
    const sensor = state.sensors.find((s) => s.id === patch.id);
    assert.ok(patch.value <= SENSOR_TYPES.find((t) => t.type === sensor.type).max);
    if (sensor.type === 'waterLevel') assert.equal(patch.value, 0);
  }
  for (const sensor of state.sensors) sensor.value = SENSOR_TYPES.find((t) => t.type === sensor.type).min;
  for (const patch of simulateReadings(state, { random: () => 0 })) {
    const sensor = state.sensors.find((s) => s.id === patch.id);
    assert.ok(patch.value >= SENSOR_TYPES.find((t) => t.type === sensor.type).min);
  }
});

test('offline sensors retain both value and measurement time; history marks them offline', () => {
  const saved = createInitialState(FIRST);
  saved.savedAt = FIRST;
  saved.sensors[0].status = 'offline';
  const f = fixture(saved);
  f.simulator.start(); f.advance(); f.fire();
  const state = f.store.getState();
  assert.deepEqual(state.sensors[0], saved.sensors[0]);
  assert.equal(state.sensors[1].lastUpdatedAt, f.now());
  assert.equal(state.history[0].sensors[0].status, 'offline');
  assert.equal(state.history[0].sensors[0].lastUpdatedAt, FIRST);
});

test('start is idempotent and pause cancels the timer; a step updates exactly once', () => {
  const f = fixture();
  f.simulator.start(); f.simulator.start();
  assert.equal(f.jobs.size, 1);
  assert.equal(createSimulator(f.store), f.simulator);
  f.advance(); f.fire();
  assert.equal(f.store.getState().history.length, 1);
  const queuedCallback = [...f.jobs.values()][0];
  f.simulator.pause();
  assert.equal(f.jobs.size, 0);
  const frozen = f.store.getState().sensors;
  f.advance(); f.fire(); queuedCallback();
  assert.deepEqual(f.store.getState().sensors, frozen);
  assert.equal(f.simulator.step().ok, true);
  assert.equal(f.store.getState().history.length, 2);
  f.simulator.resume(); f.simulator.resume();
  assert.equal(f.jobs.size, 1);
  assert.equal(f.simulator.step().ok, false);
  f.simulator.dispose();
  assert.equal(f.jobs.size, 0);
});

test('reload preserves pause, readings and history and never replays missing ticks', () => {
  const f = fixture();
  f.simulator.pause(); f.advance(); f.simulator.step();
  const before = f.store.getState();
  f.simulator.dispose();
  const loaded = createStore({ storage: f.disk, now: () => '2026-10-25T12:00:00.000Z' });
  const jobs = new Map();
  const controller = createSimulator(loaded, { setInterval: (fn) => { jobs.set(1, fn); return 1; }, clearInterval: (id) => jobs.delete(id) });
  controller.start();
  assert.equal(jobs.size, 0);
  assert.deepEqual(loaded.getState(), before);
  controller.resume();
  assert.equal(jobs.size, 1);
  assert.equal(loaded.getState().history.length, 1);
  controller.dispose();
});

test('stage 2 migration retains saved readings/settings/device metadata with no extra samples', () => {
  const disk = storage();
  const legacy = createInitialState(FIRST);
  legacy.schemaVersion = 1;
  delete legacy.simulation;
  legacy.savedAt = FIRST;
  legacy.sensors[0].value = 27.3;
  legacy.settings.zones['ZONE-02'].soil.min = 40;
  disk.setItem(STORAGE_KEY, JSON.stringify(legacy));
  const result = loadState({ storage: disk, now: () => '2026-10-19T12:00:00.000Z' });
  assert.equal(result.state.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.status.persistent, true);
  assert.deepEqual(result.state.sensors, legacy.sensors);
  assert.deepEqual(result.state.devices, legacy.devices);
  assert.deepEqual(result.state.settings, legacy.settings);
  assert.equal(result.state.history.length, 0);
  assert.equal(result.state.simulation.paused, false);
  assert.equal(JSON.parse(disk.getItem(STORAGE_KEY)).schemaVersion, SCHEMA_VERSION);
});

test('failed migration write retains the original stage 2 record and exposes a valid memory model', () => {
  const disk = storage();
  const legacy = createInitialState(FIRST);
  legacy.schemaVersion = 1; delete legacy.simulation; legacy.savedAt = FIRST;
  disk.setItem(STORAGE_KEY, JSON.stringify(legacy));
  const raw = disk.getItem(STORAGE_KEY);
  disk.setItem = () => { throw new Error('quota'); };
  const result = loadState({ storage: disk, now: () => FIRST });
  assert.equal(result.state.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.status.persistent, false);
  assert.equal(result.state.simulation.paused, true);
  assert.equal(disk.getItem(STORAGE_KEY), raw);
});

test('a restored page reloads the latest saved pause/readings/history before restarting', () => {
  const a = fixture();
  a.simulator.start(); a.advance(); a.fire(); a.simulator.stop();
  const b = createStore({ storage: a.disk, now: a.now });
  const bSimulator = createSimulator(b, { now: a.now, random: () => 0.2 });
  bSimulator.pause(); a.advance(); bSimulator.step();
  const latest = b.getState();
  a.store.reload(); a.simulator.start();
  assert.equal(a.jobs.size, 0);
  assert.deepEqual(a.store.getState(), latest);
  a.simulator.dispose(); bSimulator.dispose();
});

test('unavailable storage starts safely paused; an explicit resume can still simulate in memory', () => {
  const store = createStore({ storage: { getItem() { throw new Error('denied'); } }, now: () => FIRST });
  const jobs = new Map();
  const simulator = createSimulator(store, { now: () => '2026-10-18T12:00:05.000Z', random: () => 0.9,
    setInterval: (fn) => { jobs.set(1, fn); return 1; }, clearInterval: (id) => jobs.delete(id) });
  simulator.start();
  assert.equal(jobs.size, 0);
  assert.equal(store.getState().simulation.paused, true);
  simulator.resume();
  assert.equal(jobs.size, 1);
  [...jobs.values()][0]();
  assert.equal(store.getState().history.length, 1);
  assert.equal(store.getStatus().persistent, false);
  simulator.dispose();
});

test('quota failures during ticks are reported without throwing and do not stop memory updates', () => {
  const f = fixture(); f.simulator.start();
  f.disk.setItem = () => { throw new Error('quota'); };
  f.advance(); assert.doesNotThrow(() => f.fire());
  assert.equal(f.store.getStatus().persistent, false);
  assert.equal(f.store.getState().history.length, 1);
  f.advance(); f.fire();
  assert.equal(f.store.getState().history.length, 2);
  f.simulator.dispose();
});

test('store updates feed the same values to dashboard, zones and sensor rows', () => {
  const f = fixture();
  let notifications = 0;
  f.store.subscribe(() => { notifications++; });
  f.simulator.pause(); f.advance(); f.simulator.step();
  const state = f.store.getState();
  assert.equal(buildDashboardModel(state).temperature, 24.3);
  assert.match(zoneCards(state), /25/);
  assert.match(sensorRows(state), /25/);
  assert.equal(notifications, 2);
  assert.equal(state.history[0].sensors.find((s) => s.sensorId === state.sensors[0].id).value, state.sensors[0].value);
});

test('every online measurement receives the tick time, even if a value rounds to the previous value', () => {
  const f = fixture();
  const original = f.store.getState();
  f.advance();
  const batch = simulateReadings(original, { random: () => 0.5 });
  assert.equal(f.store.recordMeasurements(batch, f.now()).ok, true);
  const updated = f.store.getState();
  assert.deepEqual(updated.sensors.map((s) => s.id), original.sensors.map((s) => s.id));
  assert.equal(updated.sensors[0].value, original.sensors[0].value);
  assert.ok(updated.sensors.every((s) => s.lastUpdatedAt === f.now()));
});

test('invalid measurements reject the frame, mark the fault offline and retain good values; malformed history is rejected', () => {
  const f = fixture();
  const before = f.store.getState();
  const batch = simulateReadings(before, { random: () => 0.5 });
  batch[0].value = NaN;
  f.advance();
  assert.equal(f.store.recordMeasurements(batch, f.now()).ok, false);
  assert.deepEqual(f.store.getState().sensors, before.sensors.map((s, i) => i === 0 ? { ...s, status: 'offline' } : s));
  assert.deepEqual(f.store.getState().history, before.history);
  assert.equal(f.store.getState().simulation.lastTickAt, null);
  assert.ok(f.store.getState().alerts.some((a) => a.type === 'sensor-unavailable'));
  f.simulator.pause(); f.simulator.step();
  const invalid = f.store.getState();
  invalid.history[0].sensors[0].sensorId = 'orphan';
  assert.equal(validateState(invalid).ok, false);
});
