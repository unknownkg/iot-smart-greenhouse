import { loadState, saveState, resetData, validateState } from './storage.js';
import { HISTORY_LIMIT } from './data.js';
import { deviceBlockReason, enforceDeviceSafety } from './safety.js';

export function createStore(options = {}) {
  let { state, status } = loadState(options);
  const subscribers = new Set();
  // Never overwrite malformed/incompatible saved data without an explicit reset.
  let writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
  const snapshot = () => structuredClone(state);
  const notify = () => subscribers.forEach((listener) => listener(snapshot(), { ...status }));
  const now = options.now ?? (() => new Date().toISOString());
  const recoveryReason = () => writeBlocked ? 'Сохранённая модель не восстановлена. Управление заблокировано до сброса данных.' : null;
  function commit(next, safetyNotice = null) {
    const safety = enforceDeviceSafety(next, now(), recoveryReason());
    if (!validateState(next).ok) return { ok: false, issue: 'invalid-state' };
    const saved = writeBlocked ? { ok: false, issue: status.issue } : saveState(next, options);
    state = saved.ok ? saved.state : next;
    status = { ...status, source: saved.ok ? 'saved' : 'memory', persistent: saved.ok, issue: saved.ok ? null : saved.issue,
      safetyMessage: safetyNotice || safety.message || null };
    notify();
    return { ok: true, persisted: saved.ok };
  }
  function checkLoadedSafety() {
    const next = snapshot();
    const safety = enforceDeviceSafety(next, now(), recoveryReason());
    if (safety.changed) {
      commit(next, safety.message || 'Восстановлено безопасное состояние устройств.');
    }
  }
  checkLoadedSafety();

  return Object.freeze({
    getState: snapshot,
    getStatus: () => ({ ...status }),
    // Used on BFCache restoration: another page may have saved newer data/pause.
    reload() {
      const loaded = loadState(options);
      state = loaded.state;
      status = loaded.status;
      writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
      checkLoadedSafety();
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
    setZoneMode(zoneId, mode) {
      if (mode !== 'manual') return { ok: false, message: 'Auto будет доступен на следующем этапе.' };
      const next = snapshot();
      const zone = next.zones.find((item) => item.id === zoneId);
      if (!zone) return { ok: false, message: 'Неизвестная зона.' };
      zone.mode = 'manual';
      return { ...commit(next), message: 'Режим Manual установлен.' };
    },
    setDeviceState(deviceId, isOn) {
      if (typeof isOn !== 'boolean') return { ok: false, message: 'Состояние устройства должно быть ON или OFF.' };
      const next = snapshot();
      const device = next.devices.find((item) => item.id === deviceId);
      if (!device) return { ok: false, message: 'Неизвестное устройство.' };
      const reason = recoveryReason() ?? deviceBlockReason(next, device);
      if (isOn && reason) return { ok: false, message: reason };
      if (device.isOn === isOn) return { ok: true, persisted: status.persistent, message: 'Состояние уже установлено.' };
      device.isOn = isOn;
      device.source = 'manual';
      device.changedAt = now();
      const result = commit(next);
      return { ...result, message: result.ok ? `Команда ${isOn ? 'ON' : 'OFF'} выполнена${result.persisted ? '.' : ' в памяти; сохранить не удалось.'}` : 'Команда отклонена: некорректные данные.' };
    },
    // Internal monitoring API; changing availability is not a new measurement.
    setSensorStatus(sensorId, sensorStatus) {
      if (!['online', 'offline'].includes(sensorStatus)) return { ok: false, issue: 'invalid-status' };
      const next = snapshot();
      const sensor = next.sensors.find((item) => item.id === sensorId);
      if (!sensor) return { ok: false, issue: 'unknown-sensor' };
      sensor.status = sensorStatus;
      return commit(next);
    },
    // Internal API for the future settings editor.
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
        if (sensor.type === 'waterLevel' && (!Number.isFinite(measurement.value) || measurement.value < 0 || measurement.value > 100)) {
          sensor.status = 'offline';
          continue;
        }
        sensor.value = measurement.value;
        sensor.lastUpdatedAt = timestamp;
      }
      next.simulation.lastTickAt = timestamp;
      next.history.push({ timestamp, sensors: next.sensors.map((sensor) => ({
        sensorId: sensor.id, value: sensor.value, status: sensor.status, lastUpdatedAt: sensor.lastUpdatedAt,
      })) });
      next.history = next.history.slice(-HISTORY_LIMIT);
      const result = commit(next);
      if (result.ok) return result;
      // A rejected frame must not cancel an independently received water hazard.
      // Keep other readings/history transactional, but publish a valid safety-only update.
      const safe = snapshot();
      let waterHazard = false;
      for (const measurement of measurements) {
        const sensor = safe.sensors.find((item) => item.id === measurement.id);
        if (sensor.type !== 'waterLevel') continue;
        const invalid = !Number.isFinite(measurement.value) || measurement.value < 0 || measurement.value > 100;
        if (!invalid && measurement.value > safe.settings.zones[sensor.zoneId].waterLevel.critical) continue;
        waterHazard = true;
        if (invalid) sensor.status = 'offline';
        else { sensor.value = measurement.value; sensor.lastUpdatedAt = timestamp; }
      }
      if (waterHazard) {
        const safetyResult = commit(safe);
        return { ...result, safetyApplied: safetyResult.ok, persisted: safetyResult.persisted };
      }
      return result;
    },
    reset() {
      const result = resetData(options);
      if (result.state) {
        state = result.state;
        status = result.status;
        writeBlocked = false;
        checkLoadedSafety();
        notify();
      }
      return { ok: result.ok, issue: result.issue ?? result.status?.issue ?? null };
    },
  });
}
