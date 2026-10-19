import { loadState, saveState, resetData, validateState } from './storage.js';

export function createStore(options = {}) {
  let { state, status } = loadState(options);
  const subscribers = new Set();
  // Never overwrite malformed/incompatible saved data without an explicit reset.
  let writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
  const snapshot = () => structuredClone(state);
  const notify = () => subscribers.forEach((listener) => listener(snapshot(), { ...status }));

  return Object.freeze({
    getState: snapshot,
    getStatus: () => ({ ...status }),
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
    // Internal API for future settings UI. No UI editing or device command API in stage 2.
    updateZoneSettings(zoneId, settings) {
      if (!Object.hasOwn(state.settings.zones, zoneId)) return { ok: false, issue: 'unknown-zone' };
      const next = snapshot();
      try { next.settings.zones[zoneId] = structuredClone(settings); }
      catch { return { ok: false, issue: 'invalid-settings' }; }
      if (!validateState(next).ok) return { ok: false, issue: 'invalid-settings' };
      const saved = writeBlocked ? { ok: false, issue: status.issue } : saveState(next, options);
      state = saved.ok ? saved.state : next;
      status = { source: saved.ok ? 'saved' : 'memory', persistent: saved.ok, issue: saved.ok ? null : saved.issue };
      notify();
      return { ok: true, persisted: saved.ok };
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
