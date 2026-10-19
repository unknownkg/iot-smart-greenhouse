import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../assets/js/store.js';
import { createSettingsEditor } from '../assets/js/settings-form.js';

function fixture() {
  const map = new Map();
  const disk = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const store = createStore({ storage: disk, now: () => '2026-10-18T12:00:00.000Z' });
  return { store, disk, editor: createSettingsEditor(store) };
}

test('settings drafts survive ticks and zone switches until an explicit save', () => {
  const f = fixture();
  f.editor.setValue('ZONE-01', 'soil.min', '44.5');
  assert.equal(f.editor.values('ZONE-02')['soil.min'], '35');
  f.store.setSimulationPaused(true);
  const batch = f.store.getState().sensors.map((s) => ({ id: s.id, value: s.value }));
  f.store.recordMeasurements(batch, '2026-10-18T12:00:05.000Z');
  assert.equal(f.editor.values('ZONE-01')['soil.min'], '44.5');
  assert.equal(f.store.getState().settings.zones['ZONE-01'].soil.min, 35);
  assert.equal(f.editor.save('ZONE-01').ok, true);
  assert.equal(f.store.getState().settings.zones['ZONE-01'].soil.min, 44.5);
  assert.equal(f.editor.dirty('ZONE-01'), false);
});

test('saving selected-zone settings immediately drives its Auto and persists all nine thresholds', () => {
  const f = fixture(); f.store.setZoneMode('ZONE-02', 'auto');
  const other = f.store.getState().settings.zones['ZONE-01'];
  const fields = { 'temperature.min': '19', 'temperature.max': '24', 'humidity.min': '55', 'humidity.max': '85',
    'soil.min': '40', 'soil.max': '70', 'light.min': '17000', 'waterLevel.critical': '20', 'co2.max': '800' };
  for (const [path, raw] of Object.entries(fields)) f.editor.setValue('ZONE-02', path, raw);
  assert.equal(f.editor.save('ZONE-02').ok, true);
  const reloaded = createStore({ storage: f.disk, now: () => '2026-10-18T12:10:00.000Z' });
  assert.deepEqual(reloaded.getState().settings.zones['ZONE-02'], {
    temperature: { min: 19, max: 24 }, humidity: { min: 55, max: 85 }, soil: { min: 40, max: 70 },
    light: { min: 17000 }, waterLevel: { critical: 20 }, co2: { max: 800 },
  });
  assert.equal(reloaded.getZoneDevices('ZONE-02').find((d) => d.type === 'fan').isOn, true);
  assert.deepEqual(reloaded.getState().settings.zones['ZONE-01'], other);
  assert.equal(reloaded.getState().history.length, 0);
});

for (const [field, raw] of [['temperature.min', ''], ['temperature.max', 'abc'], ['soil.min', '-1'],
  ['humidity.max', '101'], ['light.min', '200001'], ['waterLevel.critical', 'Infinity'], ['co2.max', '-5'],
  ['temperature.min', '28'], ['soil.min', '76'], ['humidity.min', '80']]) {
  test(`invalid threshold ${field}=${raw} is rejected with a field error and leaves the store intact`, () => {
    const f = fixture(); const before = f.store.getState();
    f.editor.setValue('ZONE-01', field, raw);
    const result = f.editor.save('ZONE-01');
    assert.equal(result.ok, false); assert.ok(result.errors[field]); assert.ok(result.message);
    assert.deepEqual(f.store.getState(), before);
    assert.equal(f.editor.values('ZONE-01')[field], raw);
  });
}

test('zero is a real threshold, whitespace is not; discard reads current saved settings', () => {
  const f = fixture();
  f.editor.setValue('ZONE-01', 'waterLevel.critical', '0'); assert.equal(f.editor.save('ZONE-01').ok, true);
  f.editor.setValue('ZONE-01', 'waterLevel.critical', '  '); assert.equal(f.editor.save('ZONE-01').ok, false);
  const settings = f.store.getState().settings.zones['ZONE-01']; settings.waterLevel.critical = 25;
  f.store.updateZoneSettings('ZONE-01', settings);
  f.editor.discard('ZONE-01'); assert.equal(f.editor.values('ZONE-01')['waterLevel.critical'], '25');
});

test('settings storage failure is reported while coherent Auto decisions remain safe in memory', () => {
  const f = fixture(); f.store.setZoneMode('ZONE-01', 'auto');
  f.disk.setItem = () => { throw new Error('quota'); };
  f.editor.setValue('ZONE-01', 'temperature.max', '24');
  const result = f.editor.save('ZONE-01');
  assert.equal(result.ok, true); assert.equal(result.persisted, false); assert.match(result.message, /памяти/);
  assert.equal(f.store.getZoneDevices('ZONE-01').find((d) => d.type === 'fan').isOn, true);
});
