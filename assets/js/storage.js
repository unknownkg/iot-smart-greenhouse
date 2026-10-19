import { SCHEMA_VERSION, HISTORY_LIMIT, SENSOR_TYPES, DEVICE_TYPES, ZONE_DEFINITIONS, createInitialState } from './data.js';

export const STORAGE_KEY = 'iotSmartGreenhouse.state';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const numberIn = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

function validateVersion(state, version) {
  const fail = (reason) => ({ ok: false, reason });
  if (!object(state) || state.schemaVersion !== version) return fail('schema');
  if (state.isDemo !== true || !date(state.createdAt)
    || !(state.savedAt === null || date(state.savedAt))) return fail('metadata');
  if (!Array.isArray(state.zones) || state.zones.length !== 3
    || !Array.isArray(state.sensors) || state.sensors.length !== 18
    || !Array.isArray(state.devices) || state.devices.length !== 18) return fail('counts');
  const ids = new Set();
  for (const item of [...state.zones, ...state.sensors, ...state.devices]) {
    if (!object(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(item.id)
      || ids.has(item.id)) return fail('ids');
    ids.add(item.id);
  }
  for (const expected of ZONE_DEFINITIONS) {
    const zone = state.zones.find((item) => item.id === expected.id);
    if (!zone || zone.name !== expected.name || zone.crop !== expected.crop
      || !['manual', 'auto'].includes(zone.mode)) return fail('zones');
  }
  const zoneIds = state.zones.map((zone) => zone.id);
  for (const sensor of state.sensors) {
    const type = SENSOR_TYPES.find((item) => item.type === sensor.type);
    if (!zoneIds.includes(sensor.zoneId) || !type || sensor.unit !== type.unit
      || !numberIn(sensor.value, type.min, type.max) || !['online', 'offline'].includes(sensor.status)
      || !date(sensor.lastUpdatedAt)) return fail('sensors');
  }
  for (const device of state.devices) {
    if (!zoneIds.includes(device.zoneId) || !DEVICE_TYPES.some((item) => item.type === device.type)
      || typeof device.isOn !== 'boolean' || !date(device.changedAt)
      || !['initial', 'manual', 'automation', 'system'].includes(device.source)
      || !(device.blockedReason === null || (typeof device.blockedReason === 'string'
        && device.blockedReason.length <= 500))) return fail('devices');
  }
  for (const id of zoneIds) {
    for (const [collection, types] of [[state.sensors, SENSOR_TYPES], [state.devices, DEVICE_TYPES]]) {
      const items = collection.filter((item) => item.zoneId === id);
      if (items.length !== 6 || !types.every(({ type }) => items.filter((item) => item.type === type).length === 1)) {
        return fail('zone-membership');
      }
    }
  }
  if (!object(state.settings) || state.settings.theme !== 'dark'
    || !Number.isInteger(state.settings.simulationIntervalMs)
    || !numberIn(state.settings.simulationIntervalMs, 3000, 10000)
    || !keysAre(state.settings.zones, zoneIds)) return fail('settings');
  for (const settings of Object.values(state.settings.zones)) {
    if (!keysAre(settings, ['temperature', 'humidity', 'soil', 'light', 'waterLevel', 'co2'])) return fail('thresholds');
    for (const type of ['temperature', 'humidity', 'soil']) {
      const rule = settings[type];
      const range = SENSOR_TYPES.find((item) => item.type === type);
      if (!keysAre(rule, ['min', 'max']) || !numberIn(rule.min, range.min, range.max)
        || !numberIn(rule.max, range.min, range.max) || rule.min >= rule.max) return fail('thresholds');
    }
    for (const [type, key, max] of [['light', 'min', 200000], ['waterLevel', 'critical', 100], ['co2', 'max', 100000]]) {
      if (!keysAre(settings[type], [key]) || !numberIn(settings[type][key], 0, max)) return fail('thresholds');
    }
  }
  for (const key of ['alerts', 'events']) {
    if (!Array.isArray(state[key]) || state[key].length !== 0) return fail('reserved-collections');
  }
  if (!Array.isArray(state.history)) return fail('history');
  if (version === 1) return state.history.length === 0 ? { ok: true } : fail('legacy-history');
  if (!keysAre(state.simulation, ['paused', 'lastTickAt']) || typeof state.simulation.paused !== 'boolean'
    || !(state.simulation.lastTickAt === null || date(state.simulation.lastTickAt))
    || state.history.length > HISTORY_LIMIT) return fail('simulation');
  let previous = -Infinity;
  for (const sample of state.history) {
    if (!object(sample) || !date(sample.timestamp) || Date.parse(sample.timestamp) < previous
      || !Array.isArray(sample.sensors) || sample.sensors.length !== 18) return fail('history');
    previous = Date.parse(sample.timestamp);
    const seen = new Set();
    for (const measurement of sample.sensors) {
      if (!object(measurement)) return fail('history');
      const sensor = state.sensors.find((item) => item.id === measurement.sensorId);
      const type = SENSOR_TYPES.find((item) => item.type === sensor?.type);
      if (!sensor || seen.has(sensor.id) || !numberIn(measurement.value, type.min, type.max)
        || !['online', 'offline'].includes(measurement.status) || !date(measurement.lastUpdatedAt)
        || Date.parse(measurement.lastUpdatedAt) > previous
        || (measurement.status === 'online' && measurement.lastUpdatedAt !== sample.timestamp)) return fail('history');
      seen.add(sensor.id);
    }
  }
  if (state.simulation.lastTickAt !== (state.history.at(-1)?.timestamp ?? null)) return fail('last-tick');
  return { ok: true };
}

export function validateState(state) {
  return validateVersion(state, SCHEMA_VERSION);
}

function resolveStorage(storage) {
  // Access itself can throw when browser storage is denied.
  return storage === undefined ? globalThis.localStorage : storage;
}

export function saveState(state, { storage, now = () => new Date().toISOString() } = {}) {
  if (!validateState(state).ok) return { ok: false, issue: 'invalid-state' };
  const saved = structuredClone(state);
  saved.savedAt = now();
  if (!validateState(saved).ok) return { ok: false, issue: 'invalid-save-time' };
  try {
    resolveStorage(storage).setItem(STORAGE_KEY, JSON.stringify(saved));
    return { ok: true, state: saved };
  } catch {
    return { ok: false, issue: 'write-failed' };
  }
}

export function loadState(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const fallback = (issue) => {
    const state = createInitialState(now());
    // Unknown saved pause state must not result in an automatic restart.
    state.simulation.paused = true;
    return { state, status: { source: 'memory', persistent: false, issue } };
  };
  let raw;
  try {
    raw = resolveStorage(options.storage).getItem(STORAGE_KEY);
  } catch {
    return fallback('read-failed');
  }
  if (raw !== null) {
    let saved;
    try { saved = JSON.parse(raw); } catch { return fallback('invalid-json'); }
    if (object(saved) && saved.schemaVersion === 1) {
      if (!validateVersion(saved, 1).ok || saved.savedAt === null) return fallback('invalid-state');
      const migrated = { ...saved, schemaVersion: SCHEMA_VERSION, simulation: { paused: false, lastTickAt: null } };
      const result = saveState(migrated, options);
      if (!result.ok) migrated.simulation.paused = true;
      return result.ok
        ? { state: result.state, status: { source: 'migrated', persistent: true, issue: null } }
        : { state: migrated, status: { source: 'memory', persistent: false, issue: 'migration-write-failed' } };
    }
    if (!object(saved) || saved.schemaVersion !== SCHEMA_VERSION) return fallback('incompatible-schema');
    if (!validateState(saved).ok || saved.savedAt === null) return fallback('invalid-state');
    return { state: saved, status: { source: 'saved', persistent: true, issue: null } };
  }
  const initial = createInitialState(now());
  const saved = saveState(initial, options);
  if (!saved.ok) initial.simulation.paused = true;
  return saved.ok
    ? { state: saved.state, status: { source: 'initial', persistent: true, issue: null } }
    : { state: initial, status: { source: 'memory', persistent: false, issue: saved.issue } };
}

export function resetData(options = {}) {
  try { resolveStorage(options.storage).removeItem(STORAGE_KEY); }
  catch { return { ok: false, issue: 'reset-failed' }; }
  const loaded = loadState(options);
  return { ok: loaded.status.persistent, ...loaded };
}
