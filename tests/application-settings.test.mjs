import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../assets/js/store.js';
import { STORAGE_KEY, validateState } from '../assets/js/storage.js';
import { createSimulator } from '../assets/js/simulator.js';
import { createApplicationSettings, bindApplicationSettings, RESET_WARNING } from '../assets/js/application-settings.js';
import { createSettingsEditor } from '../assets/js/settings-form.js';

const FIRST = '2026-10-19T12:00:00.000Z';
function fixture() {
  const map = new Map([['other.application', 'preserve me']]); let writes = 0; let removed = 0;
  let failRemove = false; let failWrite = false; let failRead = false;
  const disk = { getItem(key) { if (failRead) throw Error('read denied'); return map.get(key) ?? null; },
    setItem(key, value) { if (failWrite) throw Error('quota'); writes++; map.set(key, value); },
    removeItem(key) { if (failRemove) throw Error('remove denied'); removed++; map.delete(key); } };
  let ms = Date.parse(FIRST); const now = () => new Date(ms).toISOString();
  const store = createStore({ storage: disk, now });
  const jobs = new Map(); let serial = 0;
  const simulator = createSimulator(store, { now, random: () => .5,
    setInterval(fn, delay) { jobs.set(++serial, { fn, delay }); return serial; }, clearInterval(id) { jobs.delete(id); } });
  simulator.start();
  return { store, simulator, disk, map, jobs, now, advance() { ms += 5000; },
    counts: () => ({ writes, removed }), failRemove() { failRemove = true; }, failWrite() { failWrite = true; }, failRead() { failRead = true; } };
}

test('speed persists in existing schema and reload preserves readings, devices and history', () => {
  const f = fixture(); f.advance(); f.jobs.values().next().value.fn();
  f.store.setDeviceState('ZONE-01-D-growLight', true); const before = f.store.getState();
  assert.equal(before.settings.simulationIntervalMs, 5000);
  for (const interval of [3000, 10000]) {
    assert.equal(f.store.setSimulationIntervalMs(interval).ok, true);
    const restored = createStore({ storage: f.disk, now: f.now }).getState();
    assert.equal(restored.settings.simulationIntervalMs, interval);
    assert.equal(restored.schemaVersion, 3); assert.deepEqual(restored.history, before.history);
    assert.deepEqual(restored.sensors, before.sensors); assert.deepEqual(restored.devices, before.devices);
  }
});

test('invalid speed and same-value commands do not mutate state or storage', () => {
  const f = fixture(); const before = f.store.getState(); const counts = f.counts();
  for (const invalid of [2999, 10001, 3000.5, '5000', null, NaN, { toString: null }]) {
    assert.equal(f.store.setSimulationIntervalMs(invalid).ok, false);
    assert.deepEqual(f.store.getState(), before);
  }
  assert.equal(f.store.setSimulationIntervalMs(5000).ok, true); assert.deepEqual(f.counts(), counts);
});

test('speed changes replace one existing timer without making a measurement; pause/step/resume remain consistent', () => {
  const f = fixture(); const old = [...f.jobs.keys()][0];
  f.store.setSimulationIntervalMs(3000);
  assert.equal(f.jobs.size, 1); assert.equal(f.jobs.has(old), false); assert.equal([...f.jobs.values()][0].delay, 3000);
  assert.equal(f.store.getState().history.length, 0);
  f.simulator.pause(); f.store.setSimulationIntervalMs(7000); assert.equal(f.jobs.size, 0);
  f.advance(); assert.equal(f.simulator.step().ok, true); assert.equal(f.store.getState().history.length, 1);
  f.simulator.resume(); f.simulator.start(); assert.equal(f.jobs.size, 1); assert.equal([...f.jobs.values()][0].delay, 7000);
  f.simulator.dispose(); assert.equal(f.jobs.size, 0);
});

test('changing speed while paused survives reload and does not unexpectedly resume', () => {
  const f = fixture(); f.simulator.pause(); f.store.setSimulationIntervalMs(8000);
  const restored = createStore({ storage: f.disk, now: f.now }).getState();
  assert.equal(restored.simulation.paused, true); assert.equal(restored.settings.simulationIntervalMs, 8000);
  assert.equal(f.jobs.size, 0);
});

test('cancelled reset has no storage, timer or state effects and lists every reset target', () => {
  const f = fixture(); const before = f.store.getState(); const counts = f.counts(); const jobs = [...f.jobs.keys()];
  const settings = createApplicationSettings(f.store, f.simulator, { confirmReset(message) { assert.equal(message, RESET_WARNING); return false; } });
  assert.equal(settings.reset().cancelled, true);
  assert.deepEqual(f.store.getState(), before); assert.deepEqual(f.counts(), counts); assert.deepEqual([...f.jobs.keys()], jobs);
  for (const word of ['датчик', 'настрой', 'устройств', 'сценари', 'Alerts', 'Event Log', 'истори']) assert.ok(RESET_WARNING.includes(word));
});

test('confirmed reset only removes the application key, releases old timer, applies safety and reuses the store/controller', () => {
  const f = fixture(); f.simulator.pause(); f.store.setSimulationIntervalMs(3000);
  f.store.setZoneMode('ZONE-01', 'auto'); f.store.applyScenario('ZONE-01', 'low-water'); f.simulator.resume();
  const oldJobs = [...f.jobs.keys()]; let confirmations = 0;
  const settings = createApplicationSettings(f.store, f.simulator, { confirmReset() { confirmations++; return true; } });
  const result = settings.reset(); const next = f.store.getState();
  assert.equal(confirmations, 1); assert.equal(result.ok, true); assert.equal(result.applied, true);
  assert.equal(f.map.get('other.application'), 'preserve me'); assert.equal(f.counts().removed, 1);
  assert.equal(validateState(next).ok, true); assert.equal(next.sensors.length, 18); assert.equal(next.devices.length, 18);
  assert.ok(next.devices.every((d) => !d.isOn)); assert.ok(next.zones.every((z) => z.mode === 'manual'));
  assert.equal(next.settings.simulationIntervalMs, 5000); assert.deepEqual(next.history, []); assert.deepEqual(next.alerts, []); assert.deepEqual(next.events, []);
  assert.equal(f.jobs.size, 1); assert.ok(oldJobs.every((id) => !f.jobs.has(id))); assert.equal([...f.jobs.values()][0].delay, 5000);
  assert.equal(createSimulator(f.store), f.simulator);
  f.store.setSensorStatus('ZONE-01-S-waterLevel', 'offline');
  assert.equal(f.store.setDeviceState('ZONE-01-D-pump', true).ok, false);
});

test('remove denial leaves the old data and pause/running policy intact and reports failure', () => {
  const f = fixture(); f.store.setSimulationIntervalMs(3000); const before = f.store.getState(); const raw = f.map.get(STORAGE_KEY);
  f.failRemove(); const settings = createApplicationSettings(f.store, f.simulator, { confirmReset: () => true });
  const result = settings.reset(); assert.equal(result.ok, false); assert.equal(result.applied, false);
  assert.deepEqual(f.store.getState(), before); assert.equal(f.map.get(STORAGE_KEY), raw); assert.equal(f.jobs.size, 1);
  assert.equal([...f.jobs.values()][0].delay, 3000);
});

test('failed reset persistence exposes a clean paused memory model without a success promise or foreign-key loss', () => {
  const f = fixture(); f.store.applyScenario('ZONE-01', 'overheat'); f.failWrite();
  const result = createApplicationSettings(f.store, f.simulator, { confirmReset: () => true }).reset();
  assert.equal(result.ok, false); assert.equal(result.applied, true); assert.equal(result.persisted, false);
  assert.match(result.message, /памят|сохран/i); assert.equal(f.store.getState().simulation.paused, true);
  assert.equal(f.jobs.size, 0); assert.deepEqual(f.store.getState().alerts, []); assert.equal(f.map.get('other.application'), 'preserve me');
});

test('a read failure after removing data cannot turn a recovery model into trusted actuator inputs', () => {
  const f = fixture(); f.failRead();
  const result = createApplicationSettings(f.store, f.simulator, { confirmReset: () => true }).reset();
  assert.equal(result.ok, false); assert.equal(f.store.getState().simulation.paused, true);
  assert.equal(f.store.setDeviceState('ZONE-01-D-pump', true).ok, false);
});

test('speed write failure keeps a single correctly configured in-memory timer and reports persistence failure', () => {
  const f = fixture(); f.failWrite(); const result = f.store.setSimulationIntervalMs(3000);
  assert.equal(result.ok, true); assert.equal(result.persisted, false); assert.equal(f.jobs.size, 1);
  assert.equal([...f.jobs.values()][0].delay, 3000); assert.equal(f.store.getStatus().persistent, false);
});

test('clearing settings drafts after reset cannot resurrect thresholds from another zone', () => {
  const f = fixture(); const editor = createSettingsEditor(f.store);
  editor.setValue('ZONE-01', 'soil.min', '44'); editor.setValue('ZONE-02', 'soil.min', '48');
  createApplicationSettings(f.store, f.simulator, { confirmReset: () => true }).reset(); editor.clear();
  assert.equal(editor.dirty('ZONE-01'), false); assert.equal(editor.dirty('ZONE-02'), false);
  assert.equal(editor.values('ZONE-01')['soil.min'], '35'); assert.equal(editor.values('ZONE-02')['soil.min'], '35');
});

test('Settings native controls apply speed and invoke confirmation; UI reset callback only follows an applied reset', () => {
  const f = fixture(); let confirmed = false; let resetUI = 0;
  const node = () => ({ value: '', textContent: '', dataset: {}, events: {}, addEventListener(type, listener) { this.events[type] = listener; } });
  const nodes = { '[data-simulation-interval]': node(), '[data-reset-demo]': node(), '[data-application-settings-feedback]': node() };
  const root = { querySelector: (key) => nodes[key] ?? null, defaultView: { confirm: () => confirmed } };
  const binding = bindApplicationSettings(f.store, root, f.simulator, { onReset: () => resetUI++ });
  binding.render(); assert.equal(nodes['[data-simulation-interval]'].value, '5000');
  nodes['[data-simulation-interval]'].value = '3000'; nodes['[data-simulation-interval]'].events.change();
  assert.equal(f.store.getState().settings.simulationIntervalMs, 3000);
  nodes['[data-reset-demo]'].events.click(); assert.equal(resetUI, 0);
  confirmed = true; nodes['[data-reset-demo]'].events.click(); assert.equal(resetUI, 1);
  binding.render(); assert.equal(nodes['[data-simulation-interval]'].value, '5000');
});

test('a previously valid fractional-second interval remains visible rather than becoming a blank select', () => {
  const f = fixture(); f.store.setSimulationIntervalMs(3500);
  const select = { value: '', addEventListener() {} }; const option = { value: '', hidden: true, textContent: '' };
  const root = { querySelector: (key) => ({ '[data-simulation-interval]': select, '[data-current-interval]': option,
    '[data-reset-demo]': { addEventListener() {} }, '[data-application-settings-feedback]': {} })[key] ?? null };
  const binding = bindApplicationSettings(f.store, root, f.simulator);
  binding.render(); assert.equal(option.hidden, false); assert.equal(option.value, '3500'); assert.match(option.textContent, /3[.,]5/);
  assert.equal(select.value, '3500');
  f.store.setSimulationIntervalMs(5000); binding.render(); assert.equal(option.hidden, true);
});
