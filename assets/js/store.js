import { loadState, saveState, resetData, validateState } from './storage.js';
import { HISTORY_LIMIT } from './data.js';

export function createStore(options = {}) {
  let { state, status } = loadState(options);
  const subscribers = new Set();
  // Never overwrite malformed/incompatible saved data without an explicit reset.
  let writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
  const snapshot = () => structuredClone(state);
  const notify = () => subscribers.forEach((listener) => listener(snapshot(), { ...status }));
  function commit(next) {
    if (!validateState(next).ok) return { ok: false, issue: 'invalid-state' };
    const saved = writeBlocked ? { ok: false, issue: status.issue } : saveState(next, options);
    state = saved.ok ? saved.state : next;
    status = { source: saved.ok ? 'saved' : 'memory', persistent: saved.ok, issue: saved.ok ? null : saved.issue };
    notify();
    return { ok: true, persisted: saved.ok };
  }

  return Object.freeze({
    getState: snapshot,
    getStatus: () => ({ ...status }),
    // Used on BFCache restoration: another page may have saved newer data/pause.
    reload() {
      const loaded = loadState(options);
      state = loaded.state;
      status = loaded.status;
      writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
      notify();
    },
    getZoneReadings(zoneId) {
      return Object.fromEntries(state.sensors.filter((sensor) => sensor.zoneId === zoneId)
        .map((sensor) => [sensor.type, structuredClone(sensor)]));
    },
    getZoneDevices(zoneId) {
      return structuredClone(state.devices.filter((device) => device.zoneId === zoneId));
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    // Internal API for future settings UI. No device commands are exposed.
    updateZoneSettings(zoneId, settings) {
      if (!Object.hasOwn(state.settings.zones, zoneId)) return { ok: false, issue: 'unknown-zone' };
      const next = snapshot();
      try { next.settings.zones[zoneId] = structuredClone(settings); }
      catch { return { ok: false, issue: 'invalid-settings' }; }
      if (!validateState(next).ok) return { ok: false, issue: 'invalid-settings' };
      return commit(next);
    },
    setSimulationPaused(paused) {
      if (typeof paused !== 'boolean') return { ok: false, issue: 'invalid-pause' };
      if (state.simulation.paused === paused) return { ok: true, persisted: status.persistent };
      const next = snapshot();
      next.simulation.paused = paused;
      return commit(next);
    },
    recordMeasurements(measurements, timestamp) {
      if (!Array.isArray(measurements) || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))
        || new Date(timestamp).toISOString() !== timestamp) return { ok: false, issue: 'invalid-measurements' };
      const online = state.sensors.filter((sensor) => sensor.status === 'online');
      if (measurements.length !== online.length || new Set(measurements.map((item) => item?.id)).size !== online.length
        || measurements.some((item) => !item || !online.some((sensor) => sensor.id === item.id))) {
        return { ok: false, issue: 'invalid-measurements' };
      }
      if (!online.length) return { ok: true, updated: 0, persisted: status.persistent };
      if (online.some((sensor) => Date.parse(timestamp) < Date.parse(sensor.lastUpdatedAt))
        || (state.simulation.lastTickAt && timestamp < state.simulation.lastTickAt)) return { ok: false, issue: 'stale-time' };
      const next = snapshot();
      for (const measurement of measurements) {
        const sensor = next.sensors.find((item) => item.id === measurement.id);
        sensor.value = measurement.value;
        sensor.lastUpdatedAt = timestamp;
      }
      next.simulation.lastTickAt = timestamp;
      next.history.push({ timestamp, sensors: next.sensors.map((sensor) => ({
        sensorId: sensor.id, value: sensor.value, status: sensor.status, lastUpdatedAt: sensor.lastUpdatedAt,
      })) });
      next.history = next.history.slice(-HISTORY_LIMIT);
      return commit(next);
    },
    reset() {
      const result = resetData(options);
      if (result.state) {
        state = result.state;
        status = result.status;
        writeBlocked = false;
        notify();
      }
      return { ok: result.ok, issue: result.issue ?? result.status?.issue ?? null };
    },
  });
}
