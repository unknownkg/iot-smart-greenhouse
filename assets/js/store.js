import { loadState, saveState, resetData, validateState } from './storage.js';
import { HISTORY_LIMIT, SENSOR_TYPES } from './data.js';
import { deviceBlockReason, enforceDeviceSafety } from './safety.js';
import { evaluateAutomation } from './automation.js';
import { buildScenarioReadings } from './scenarios.js';

export function createStore(options = {}) {
  let { state, status } = loadState(options);
  const subscribers = new Set();
  // Never overwrite malformed/incompatible saved data without an explicit reset.
  let writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
  const snapshot = () => structuredClone(state);
  const notify = () => subscribers.forEach((listener) => listener(snapshot(), { ...status }));
  const now = options.now ?? (() => new Date().toISOString());
  const recoveryReason = () => writeBlocked ? 'Сохранённая модель не восстановлена. Управление заблокировано до сброса данных.' : null;
  function reconcileDevices(next, timestamp) {
    const before = enforceDeviceSafety(next, timestamp, recoveryReason());
    if (!recoveryReason()) {
      for (const zone of next.zones.filter((item) => item.mode === 'auto')) {
        const decisions = evaluateAutomation(next, zone.id);
        for (const device of next.devices.filter((item) => item.zoneId === zone.id)) {
          if (device.isOn !== decisions[device.type].isOn) {
            device.isOn = decisions[device.type].isOn;
            device.source = 'automation';
            device.changedAt = timestamp;
          }
        }
      }
    }
    const after = enforceDeviceSafety(next, timestamp, recoveryReason());
    return { message: after.message || (before.message.includes('восстановлен конфликт') ? before.message : '') };
  }
  function commit(next) {
    const safety = reconcileDevices(next, now());
    if (!validateState(next).ok) return { ok: false, issue: 'invalid-state' };
    const saved = writeBlocked ? { ok: false, issue: status.issue } : saveState(next, options);
    state = saved.ok ? saved.state : next;
    status = { ...status, source: saved.ok ? 'saved' : 'memory', persistent: saved.ok, issue: saved.ok ? null : saved.issue,
      safetyMessage: safety.message || null };
    notify();
    return { ok: true, persisted: saved.ok };
  }
  function checkLoadedSafety() {
    const next = snapshot();
    reconcileDevices(next, now());
    if (JSON.stringify(next.devices) !== JSON.stringify(state.devices)) commit(next);
  }
  function preserveMeasurementSafety(measurements, timestamp) {
    const safe = snapshot();
    let hazard = false;
    for (const sensor of safe.sensors.filter((item) => item.status === 'online')) {
      if (timestamp < sensor.lastUpdatedAt || (safe.simulation.lastTickAt && timestamp < safe.simulation.lastTickAt)) continue;
      const patches = measurements.filter((item) => item?.id === sensor.id);
      if (!patches.length) continue;
      const range = SENSOR_TYPES.find((item) => item.type === sensor.type);
      const value = patches[0].value;
      const invalid = patches.length !== 1 || !Number.isFinite(value) || value < range.min || value > range.max;
      const automatic = safe.zones.find((zone) => zone.id === sensor.zoneId).mode === 'auto';
      const unsafeWater = sensor.type === 'waterLevel' && (invalid || value <= safe.settings.zones[sensor.zoneId].waterLevel.critical);
      if (!automatic && !unsafeWater) continue;
      hazard = true;
      if (invalid) sensor.status = 'offline';
      else { sensor.value = value; sensor.lastUpdatedAt = timestamp; }
    }
    if (!hazard) return {};
    const result = commit(safe);
    return { safetyApplied: result.ok, persisted: result.persisted };
  }
  checkLoadedSafety();

  const api = Object.freeze({
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
      if (!['manual', 'auto'].includes(mode)) return { ok: false, message: 'Неизвестный режим.' };
      const next = snapshot();
      const zone = next.zones.find((item) => item.id === zoneId);
      if (!zone) return { ok: false, message: 'Неизвестная зона.' };
      if (zone.mode === mode) return { ok: true, persisted: status.persistent, message: 'Режим уже установлен.' };
      if (mode === 'manual') {
        for (const device of next.devices.filter((item) => item.zoneId === zoneId && item.isOn)) {
          device.isOn = false; device.source = 'manual'; device.changedAt = now();
        }
      }
      zone.mode = mode;
      const result = commit(next);
      return { ...result, message: result.ok ? `Режим ${mode === 'auto' ? 'Auto: правила применены' : 'Manual: устройства выключены'}${result.persisted ? '.' : ' в памяти; сохранить не удалось.'}` : 'Режим не изменён: некорректные данные.' };
    },
    setDeviceState(deviceId, isOn) {
      if (typeof isOn !== 'boolean') return { ok: false, message: 'Состояние устройства должно быть ON или OFF.' };
      const next = snapshot();
      const device = next.devices.find((item) => item.id === deviceId);
      if (!device) return { ok: false, message: 'Неизвестное устройство.' };
      if (next.zones.find((zone) => zone.id === device.zoneId).mode === 'auto') return { ok: false, message: 'Auto управляет устройствами. Для ручной команды выберите Manual.' };
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
    // Validated transaction used by the per-zone settings form.
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
    applyScenario(zoneId, scenarioId) {
      const input = buildScenarioReadings(state, zoneId, scenarioId);
      if (!input.ok) return input;
      const result = api.recordMeasurements(input.measurements, now());
      const mode = state.zones.find((zone) => zone.id === zoneId).mode;
      return { ...result, message: result.ok ? `Учебный сценарий «${input.name}» применён. ${mode === 'auto' ? 'Auto пересчитан' : 'Manual сохранён: устройства включаются оператором'}${result.persisted ? '.' : ' в памяти; сохранить не удалось.'}` : 'Сценарий не применён: проверьте показания и время измерений.' };
    },
    recordMeasurements(measurements, timestamp) {
      if (!Array.isArray(measurements) || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))
        || new Date(timestamp).toISOString() !== timestamp) return { ok: false, issue: 'invalid-measurements' };
      const online = state.sensors.filter((sensor) => sensor.status === 'online');
      if (measurements.length !== online.length || new Set(measurements.map((item) => item?.id)).size !== online.length
        || measurements.some((item) => !item || !online.some((sensor) => sensor.id === item.id))) {
        return { ok: false, issue: 'invalid-measurements', ...preserveMeasurementSafety(measurements, timestamp) };
      }
      if (!online.length) return { ok: true, updated: 0, persisted: status.persistent };
      if (online.some((sensor) => Date.parse(timestamp) < Date.parse(sensor.lastUpdatedAt))
        || (state.simulation.lastTickAt && timestamp < state.simulation.lastTickAt)) {
        return { ok: false, issue: 'stale-time', ...preserveMeasurementSafety(measurements, timestamp) };
      }
      const next = snapshot();
      for (const measurement of measurements) {
        const sensor = next.sensors.find((item) => item.id === measurement.id);
        const range = SENSOR_TYPES.find((item) => item.type === sensor.type);
        const automatic = next.zones.find((zone) => zone.id === sensor.zoneId).mode === 'auto';
        if ((sensor.type === 'waterLevel' || automatic) && (!Number.isFinite(measurement.value) || measurement.value < range.min || measurement.value > range.max)) {
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
      // Reject the history frame, but never discard independently trusted safety inputs.
      return { ...result, ...preserveMeasurementSafety(measurements, timestamp) };
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
  return api;
}
