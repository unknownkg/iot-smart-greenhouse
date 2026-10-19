import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../assets/js/data.js';
import { createStore } from '../assets/js/store.js';
import { analyzeZone } from '../assets/js/analytics.js';

const FIRST = '2026-10-19T12:00:00.000Z';
const ZONE = 'ZONE-01';
function state(changes = {}) {
  const value = createInitialState(FIRST);
  for (const [type, reading] of Object.entries(changes)) value.sensors.find((s) => s.zoneId === ZONE && s.type === type).value = reading;
  return value;
}
function sample(value, seconds, changes = {}, unavailable = []) {
  const timestamp = new Date(Date.parse(FIRST) + seconds * 1000).toISOString();
  return { timestamp, sensors: value.sensors.map((sensor) => ({ sensorId: sensor.id,
    value: sensor.zoneId === ZONE && Object.hasOwn(changes, sensor.type) ? changes[sensor.type] : sensor.value,
    status: sensor.zoneId === ZONE && unavailable.includes(sensor.type) ? 'offline' : 'online',
    lastUpdatedAt: sensor.zoneId === ZONE && unavailable.includes(sensor.type) ? FIRST : timestamp })) };
}

test('normal state gives deterministic zero Low risk, six valid inputs, and no false historical analysis', () => {
  const data = state(); const before = structuredClone(data);
  const result = analyzeZone(data, ZONE);
  assert.equal(result.score, 0); assert.equal(result.level, 'low'); assert.equal(result.validInputs, 6);
  assert.equal(result.complete, true); assert.equal(result.historyStatus, 'insufficient');
  assert.deepEqual(analyzeZone(data, ZONE), result); assert.deepEqual(data, before);
});

for (const [type, value, expected] of [['temperature', 29, 25], ['temperature', 19, 20], ['soil', 30, 25],
  ['waterLevel', 15, 30], ['co2', 1600, 15], ['humidity', 40, 10], ['light', 1000, 10], ['soil', 90, 10]]) {
  test(`${type}=${value} contributes its documented weight ${expected}`, () => {
    const result = analyzeZone(state({ [type]: value }), ZONE);
    assert.equal(result.score, expected); assert.equal(result.factors.length, 1);
    assert.equal(result.factors[0].sensorType, type); assert.ok(result.factors[0].evidence);
  });
}

test('combined risk clamps to100 and water Critical classification is explicit even at30 points', () => {
  const high = analyzeZone(state({ temperature: 35, soil: 10, waterLevel: 5, co2: 2000, humidity: 10, light: 500 }), ZONE);
  assert.equal(high.score, 100); assert.equal(high.level, 'critical');
  assert.equal(analyzeZone(state({ waterLevel: 15 }), ZONE).level, 'critical');
});

test('risk follows each zone Settings including CO2 and does not leak another zone factors', () => {
  const data = state({ co2: 1600, temperature: 29 });
  data.settings.zones[ZONE].co2.max = 1700; data.settings.zones[ZONE].temperature.max = 30;
  assert.equal(analyzeZone(data, ZONE).score, 0);
  assert.equal(analyzeZone(data, 'ZONE-02').score, 0);
});

test('water and pump Alerts never double-count the same physical risk', () => {
  const data = state({ waterLevel: 15 }); data.savedAt = FIRST;
  const store = createStore({ storage: { getItem: () => JSON.stringify(data), setItem() {} }, now: () => FIRST });
  assert.equal(store.getState().alerts.filter((a) => a.status === 'open').length, 2);
  const result = analyzeZone(store.getState(), ZONE);
  assert.equal(result.score, 30); assert.equal(result.factors.length, 1);
  assert.ok(result.factors[0].sources.includes('alert'));
});

test('an open Alert in its recovery band remains visible in risk without a duplicate measurement factor', () => {
  const data = state({ temperature: 29 }); data.savedAt = FIRST; let raw = JSON.stringify(data);
  const store = createStore({ storage: { getItem: () => raw, setItem: (_, v) => { raw = v; } }, now: () => FIRST });
  store.recordMeasurements(store.getState().sensors.map((s) => ({ id: s.id, value: s.id === `${ZONE}-S-temperature` ? 27.5 : s.value })), '2026-10-19T12:00:05.000Z');
  const result = analyzeZone(store.getState(), ZONE);
  assert.equal(result.score, 25); assert.equal(result.factors.length, 1); assert.ok(result.factors[0].sources.includes('alert'));
});

for (const invalid of ['offline', NaN, 101]) {
  test(`unreliable humidity ${invalid} never reports Low or complete data`, () => {
    const data = state(); const sensor = data.sensors.find((s) => s.id === `${ZONE}-S-humidity`);
    if (invalid === 'offline') sensor.status = 'offline'; else sensor.value = invalid;
    const result = analyzeZone(data, ZONE);
    assert.equal(result.complete, false); assert.equal(result.validInputs, 5);
    assert.notEqual(result.level, 'low'); assert.ok(result.factors.some((f) => f.sensorType === 'humidity'));
    assert.ok(result.recommendations.some((r) => r.condition === 'unavailable'));
  });
}

test('missing water and untrusted recovery models cannot be presented as safe', () => {
  const data = state(); data.sensors = data.sensors.filter((s) => s.id !== `${ZONE}-S-waterLevel`);
  const result = analyzeZone(data, ZONE);
  assert.equal(result.complete, false); assert.equal(result.score, 30); assert.notEqual(result.level, 'low');
  const recovery = analyzeZone(state(), ZONE, { issue: 'invalid-state' });
  assert.equal(recovery.score, null); assert.equal(recovery.level, 'unknown'); assert.equal(recovery.complete, false);
});

test('recommendations respect water protection and mode, never advise starting a blocked pump', () => {
  const data = state({ soil: 30, waterLevel: 10, temperature: 18, co2: 1800 }); data.zones[0].mode = 'auto';
  data.devices.find((d) => d.id === `${ZONE}-D-heater`).isOn = true;
  const result = analyzeZone(data, ZONE);
  const dry = result.recommendations.find((r) => r.sensorType === 'soil');
  assert.match(dry.action, /воду|воды/); assert.doesNotMatch(dry.action, /включите насос/i);
  const ventilation = result.recommendations.find((r) => r.sensorType === 'co2');
  assert.match(ventilation.action, /обогрев/);
  for (const recommendation of result.recommendations) {
    assert.equal(recommendation.zoneId, ZONE); assert.ok(recommendation.evidence); assert.ok(recommendation.priority); assert.ok(recommendation.action);
  }
});

test('adjacent valid history detects a teacher30percent jump only above the physical step floor', () => {
  const data = state(); data.history = [sample(data, 0, { temperature: 20 }), sample(data, 5, { temperature: 30 })];
  const result = analyzeZone(data, ZONE);
  assert.equal(result.historyStatus, 'available');
  assert.ok(result.anomalies.some((a) => a.type === 'sudden-change' && a.sensorType === 'temperature'));
  const before = structuredClone(data); analyzeZone(data, ZONE); assert.deepEqual(data, before);
});

test('offline entries, missing values, duplicate times and long gaps do not get bridged for jump detection', () => {
  const data = state();
  for (const middle of [sample(data, 5, { temperature: 21 }, ['temperature']), { timestamp: '2026-10-19T12:00:05.000Z', sensors: [] }]) {
    data.history = [sample(data, 0, { temperature: 20 }), middle, sample(data, 10, { temperature: 35 })];
    assert.equal(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sudden-change'), false);
  }
  for (const seconds of [0, 60]) {
    data.history = [sample(data, 0, { temperature: 20 }), sample(data, seconds, { temperature: 35 })];
    assert.equal(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sudden-change'), false);
  }
});

test('malformed historical frames remain gaps without crashing current risk analysis', () => {
  const data = state();
  data.history = [sample(data, 0, { temperature: 20 }), null, sample(data, 10, { temperature: 35 })];
  const result = analyzeZone(data, ZONE);
  assert.equal(result.score, 0);
  assert.equal(result.anomalies.some((a) => a.type === 'sudden-change'), false);
});

test('zero baselines and natural/device-size fluctuations are not labelled sudden anomalies', () => {
  const data = state();
  data.history = [sample(data, 0, { temperature: 0.5, soil: 1, light: 0 }), sample(data, 5, { temperature: 0.1, soil: 2, light: 5000 })];
  assert.equal(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sudden-change'), false);
});

test('sustained findings require60seconds of continuous valid history using current thresholds', () => {
  const data = state({ temperature: 30 });
  data.history = Array.from({ length: 13 }, (_, i) => sample(data, i * 5, { temperature: 30 }));
  assert.ok(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sustained' && a.sensorType === 'temperature'));
  data.history[6] = sample(data, 30, {}, ['temperature']);
  assert.equal(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sustained'), false);
  data.settings.zones[ZONE].temperature.max = 35;
  assert.equal(analyzeZone(data, ZONE).anomalies.some((a) => a.type === 'sustained'), false);
});

test('analytics does not mutate storage, devices, Alerts or Event Log and reload uses the same history', () => {
  const data = state(); data.savedAt = FIRST; data.history = [sample(data, 0), sample(data, 5)]; data.simulation.lastTickAt = data.history.at(-1).timestamp;
  let raw = JSON.stringify(data); let writes = 0;
  const disk = { getItem: () => raw, setItem: (_, v) => { writes++; raw = v; } };
  const store = createStore({ storage: disk, now: () => FIRST }); const before = store.getState(); const count = writes;
  const result = analyzeZone(before, ZONE);
  assert.deepEqual(analyzeZone(createStore({ storage: disk, now: () => FIRST }).getState(), ZONE), result);
  assert.equal(writes, count); assert.deepEqual(store.getState(), before);
});
