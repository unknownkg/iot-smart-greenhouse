import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { STORAGE_KEY, validateState, loadState, resetData } from '../assets/js/storage.js';
import { createStore } from '../assets/js/store.js';

const FIRST = '2026-10-18T12:00:00.000Z';
const LATER = '2026-10-18T12:10:00.000Z';
// Подменяется только хранилище браузера; проверка данных и хранилище состояния выполняются настоящим кодом.
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}
const options = (storage, time = FIRST) => ({ storage, now: () => time });

test('settings reject a non-string zone identifier without coercion, writes or state changes', () => {
  const storage = memoryStorage(); const store = createStore(options(storage));
  const before = store.getState(); const raw = storage.getItem(STORAGE_KEY);
  for (const id of [{ toString: null }, ['ZONE-01'], null, undefined]) {
    let result;
    assert.doesNotThrow(() => { result = store.updateZoneSettings(id, {}); });
    assert.equal(result.ok, false); assert.equal(result.issue, 'unknown-zone');
    assert.deepEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});

test('initial model has exactly three named zones and six sensor/device types per zone', () => {
  const state = createInitialState(FIRST);
  assert.deepEqual(state.zones.map(({ id, name }) => [id, name]), [
    ['ZONE-01', 'Tomatoes'], ['ZONE-02', 'Cucumbers'], ['ZONE-03', 'Greens'],
  ]);
  assert.equal(state.sensors.length, 18);
  assert.equal(state.devices.length, 18);
  const allIds = [...state.zones, ...state.sensors, ...state.devices].map((item) => item.id);
  assert.equal(new Set(allIds).size, 39);
  for (const zone of state.zones) {
    assert.equal(new Set(state.sensors.filter((s) => s.zoneId === zone.id).map((s) => s.type)).size, 6);
    assert.equal(new Set(state.devices.filter((d) => d.zoneId === zone.id).map((d) => d.type)).size, 6);
  }
  assert.ok(state.devices.every((device) => device.isOn === false));
  assert.ok(state.sensors.every((sensor) => sensor.lastUpdatedAt === FIRST));
  assert.equal(validateState(state).ok, true);
});

const mutations = [
  ['duplicate global ID', (s) => { s.devices[0].id = s.sensors[0].id; }],
  ['orphan sensor', (s) => { s.sensors[0].zoneId = 'ZONE-99'; }],
  ['duplicate sensor type', (s) => { s.sensors[1].type = 'temperature'; s.sensors[1].unit = '°C'; }],
  ['missing device', (s) => { s.devices.pop(); }],
  ['wrong unit', (s) => { s.sensors[0].unit = '%'; }],
  ['out of range percentage', (s) => { s.sensors.find((x) => x.type === 'soil').value = 101; }],
  ['non finite reading', (s) => { s.sensors[0].value = NaN; }],
  ['invalid timestamp', (s) => { s.sensors[0].lastUpdatedAt = 'yesterday'; }],
  ['reversed thresholds', (s) => { s.settings.zones['ZONE-01'].temperature.min = 29; }],
  ['missing zone settings', (s) => { delete s.settings.zones['ZONE-03']; }],
  ['non boolean actuator state', (s) => { s.devices[0].isOn = 'false'; }],
];
for (const [name, mutate] of mutations) {
  test(`validator rejects ${name}`, () => {
    const state = createInitialState(FIRST);
    mutate(state);
    assert.equal(validateState(state).ok, false);
  });
}

test('first launch persists a snapshot; reload keeps all values and original timestamps', () => {
  const storage = memoryStorage();
  const first = loadState(options(storage));
  assert.equal(first.status.persistent, true);
  assert.equal(first.state.savedAt, FIRST);
  const raw = storage.getItem(STORAGE_KEY);
  const reload = loadState(options(storage, LATER));
  assert.deepEqual(reload.state, first.state);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('valid saved readings and settings are not replaced by initial examples', () => {
  const storage = memoryStorage();
  const saved = createInitialState(FIRST);
  saved.sensors[0].value = 26.3;
  saved.settings.zones['ZONE-01'].temperature.max = 31;
  saved.savedAt = FIRST;
  storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const loaded = loadState(options(storage, LATER));
  assert.equal(loaded.state.sensors[0].value, 26.3);
  assert.equal(loaded.state.settings.zones['ZONE-01'].temperature.max, 31);
  assert.equal(loaded.state.sensors[0].lastUpdatedAt, FIRST);
});

for (const raw of ['{broken', JSON.stringify({ schemaVersion: 999 }), JSON.stringify({ schemaVersion: 1 })]) {
  test(`bad/incompatible saved data recovers without throwing or erasing the original: ${raw}`, () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, raw);
    const loaded = loadState(options(storage));
    assert.equal(validateState(loaded.state).ok, true);
    assert.equal(loaded.status.persistent, false);
    assert.ok(loaded.status.issue);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  });
}

test('denied reads and exhausted quota return usable memory data with an explicit warning', () => {
  for (const storage of [
    { getItem() { throw new Error('denied'); } },
    { getItem() { return null; }, setItem() { throw new Error('quota'); } },
  ]) {
    const loaded = loadState(options(storage));
    assert.equal(validateState(loaded.state).ok, true);
    assert.equal(loaded.status.persistent, false);
    assert.ok(loaded.status.issue);
    assert.equal(loaded.state.savedAt, null);
  }
});

test('reset removes only the greenhouse snapshot and initializes fresh data', () => {
  const storage = memoryStorage();
  storage.setItem('other-app', 'keep');
  storage.setItem(STORAGE_KEY, '{broken');
  const reset = resetData(options(storage, LATER));
  assert.equal(reset.ok, true);
  assert.equal(reset.state.createdAt, LATER);
  assert.equal(storage.getItem('other-app'), 'keep');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).sensors.length, 18);
});

test('store returns isolated snapshots and derives zone readings/devices from one state', () => {
  const store = createStore(options(memoryStorage()));
  const snapshot = store.getState();
  snapshot.sensors[0].value = -99;
  assert.equal(store.getZoneReadings('ZONE-01').temperature.value, 24.8);
  assert.equal(store.getZoneReadings('ZONE-02').soil.value, 58);
  assert.equal(store.getZoneDevices('ZONE-03').length, 6);
});

test('controlled settings updates persist across a new store without changing readings', () => {
  const storage = memoryStorage();
  const store = createStore(options(storage));
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  const next = store.getState().settings.zones['ZONE-01'];
  next.temperature.max = 30;
  assert.equal(store.updateZoneSettings('ZONE-01', next).ok, true);
  const reloaded = createStore(options(storage, LATER));
  assert.equal(reloaded.getState().settings.zones['ZONE-01'].temperature.max, 30);
  assert.equal(reloaded.getZoneReadings('ZONE-01').temperature.lastUpdatedAt, FIRST);
  assert.equal(notifications, 1);
  unsubscribe();
});

test('invalid settings transaction leaves memory and storage unchanged', () => {
  const storage = memoryStorage();
  const store = createStore(options(storage));
  const before = store.getState();
  const raw = storage.getItem(STORAGE_KEY);
  const invalid = structuredClone(before.settings.zones['ZONE-01']);
  invalid.soil.min = invalid.soil.max;
  assert.equal(store.updateZoneSettings('ZONE-01', invalid).ok, false);
  assert.deepEqual(store.getState(), before);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('persisted data must include the time of an actual successful save', () => {
  const storage = memoryStorage();
  const unsaved = JSON.stringify(createInitialState(FIRST));
  storage.setItem(STORAGE_KEY, unsaved);
  const loaded = loadState(options(storage));
  assert.equal(loaded.status.persistent, false);
  assert.equal(loaded.status.issue, 'invalid-state');
  assert.equal(storage.getItem(STORAGE_KEY), unsaved);
});

test('non-cloneable settings are rejected without throwing or corrupting the state', () => {
  const store = createStore(options(memoryStorage()));
  const before = store.getState();
  const result = store.updateZoneSettings('ZONE-01', { bad: () => {} });
  assert.equal(result.ok, false);
  assert.deepEqual(store.getState(), before);
});

test('failed setting writes retain the memory change and report that it was not persisted', () => {
  const storage = memoryStorage();
  const store = createStore(options(storage));
  const saved = storage.getItem(STORAGE_KEY);
  storage.setItem = () => { throw new Error('quota'); };
  const settings = store.getState().settings.zones['ZONE-01'];
  settings.temperature.max = 32;
  const result = store.updateZoneSettings('ZONE-01', settings);
  assert.deepEqual(result, { ok: true, persisted: false });
  assert.equal(store.getState().settings.zones['ZONE-01'].temperature.max, 32);
  assert.equal(store.getStatus().persistent, false);
  assert.equal(storage.getItem(STORAGE_KEY), saved);
});

test('recovered memory changes cannot overwrite incompatible saved data until reset', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, '{broken');
  const store = createStore(options(storage));
  const settings = store.getState().settings.zones['ZONE-01'];
  settings.temperature.max = 32;
  assert.equal(store.updateZoneSettings('ZONE-01', settings).persisted, false);
  assert.equal(storage.getItem(STORAGE_KEY), '{broken');
  assert.equal(store.reset().ok, true);
  assert.equal(store.getState().settings.zones['ZONE-01'].temperature.max, 28);
  assert.equal(store.getStatus().persistent, true);
});
