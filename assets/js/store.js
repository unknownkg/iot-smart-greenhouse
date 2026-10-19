import { loadState, saveState, resetData, validateState } from './storage.js';
import { HISTORY_LIMIT, SENSOR_TYPES } from './data.js';
import { deviceBlockReason, enforceDeviceSafety } from './safety.js';
import { evaluateAutomation } from './automation.js';
import { buildScenarioReadings } from './scenarios.js';
import { appendEvent, recordDeviceEvents, thresholdSummary } from './events.js';
import { syncAlerts } from './alerts.js';

export function createStore(options = {}) {
  let { state, status } = loadState(options);
  const subscribers = new Set();
  // Never overwrite malformed/incompatible saved data without an explicit reset.
  let writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
  const snapshot = () => structuredClone(state);
  const notify = () => subscribers.forEach((listener) => listener(snapshot(), { ...status }));
  const now = options.now ?? (() => new Date().toISOString());
  const actionTime = () => state.events.reduce((latest, event) => event.timestamp > latest ? event.timestamp : latest, now());
  const recoveryReason = () => writeBlocked ? 'Сохранённая модель не восстановлена. Управление заблокировано до сброса данных.' : null;
  function reconcileDevices(next, timestamp) {
    const actions = {};
    const beforeSafety = new Map(next.devices.map((device) => [device.id, device.isOn]));
    const before = enforceDeviceSafety(next, timestamp, recoveryReason());
    for (const device of next.devices) {
      if (beforeSafety.get(device.id) !== device.isOn) actions[device.id] = { source: 'safety', reason: device.blockedReason ?? before.message };
    }
    if (!recoveryReason()) {
      for (const zone of next.zones.filter((item) => item.mode === 'auto')) {
        const decisions = evaluateAutomation(next, zone.id);
        for (const device of next.devices.filter((item) => item.zoneId === zone.id)) {
          if (device.isOn !== decisions[device.type].isOn) {
            device.isOn = decisions[device.type].isOn;
            device.source = 'automation';
            device.changedAt = timestamp;
            actions[device.id] = { source: 'auto', reason: decisions[device.type].reason };
          }
        }
      }
    }
    const beforeFinalSafety = new Map(next.devices.map((device) => [device.id, device.isOn]));
    const after = enforceDeviceSafety(next, timestamp, recoveryReason());
    for (const device of next.devices) {
      if (beforeFinalSafety.get(device.id) !== device.isOn) actions[device.id] = { source: 'safety', reason: device.blockedReason ?? after.message };
    }
    return { actions, message: after.message || (before.message.includes('восстановлен конфликт') ? before.message : '') };
  }
  function commit(next, context = null) {
    const timestamp = actionTime();
    const safety = reconcileDevices(next, timestamp);
    recordDeviceEvents(state, next, timestamp, { ...context, deviceActions: safety.actions, safetyReason: safety.message });
    for (const sensor of next.sensors) {
      const old = state.sensors.find((item) => item.id === sensor.id);
      if (old.status !== sensor.status) appendEvent(next, { zoneId: sensor.zoneId, source: 'system', type: 'SENSOR_STATUS_CHANGED',
        objectId: sensor.id, objectName: SENSOR_TYPES.find((item) => item.type === sensor.type).name,
        previousState: old.status, newState: sensor.status, message: 'Изменён статус датчика.',
        reason: sensor.status === 'offline' ? 'Нет достоверного online-показания; последнее корректное значение не подменяется.' : 'Датчик отмечен online.' }, timestamp);
    }
    if (context?.type) appendEvent(next, context, timestamp);
    syncAlerts(next, timestamp);
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
    reconcileDevices(next, actionTime());
    syncAlerts(next, actionTime());
    const migration = status.source === 'migrated';
    if (migration || JSON.stringify(next.devices) !== JSON.stringify(state.devices) || JSON.stringify(next.alerts) !== JSON.stringify(state.alerts)) {
      commit(snapshot(), migration ? { source: 'system', type: 'STATE_MIGRATED', objectName: 'Схема данных',
        previousState: 'v1/v2', newState: 'v3', message: 'Сохранённая модель перенесена в схему v3.',
        reason: 'Добавлены Alerts и Event Log; настройки, устройства и история измерений сохранены.' } : null);
    }
  }
  function rejectDevice(device, isOn, message, source, key) {
    const next = snapshot();
    if (appendEvent(next, { zoneId: device.zoneId, source, type: 'COMMAND_REJECTED', objectId: device.id,
      objectName: device.type, previousState: device.isOn ? 'ON' : 'OFF', newState: device.isOn ? 'ON' : 'OFF',
      message: `Команда ${isOn ? 'ON' : 'OFF'} отклонена; фактическое состояние не изменено.`, reason: message,
      dedupeKey: `${device.id}|${isOn}|${key}` }, actionTime())) commit(next);
    return { ok: false, message };
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
      if (!automatic && !unsafeWater && !invalid) continue;
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
      const result = commit(next, { zoneId, source: 'operator', type: 'MODE_CHANGED', objectId: zoneId, objectName: 'Режим зоны',
        previousState: state.zones.find((item) => item.id === zoneId).mode, newState: mode,
        message: `Режим зоны изменён на ${mode === 'auto' ? 'Auto' : 'Manual'}.`,
        reason: mode === 'auto' ? 'Оператор включил управление по порогам.' : 'Возврат в Manual: устройства зоны безопасно выключены.' });
      return { ...result, message: result.ok ? `Режим ${mode === 'auto' ? 'Auto: правила применены' : 'Manual: устройства выключены'}${result.persisted ? '.' : ' в памяти; сохранить не удалось.'}` : 'Режим не изменён: некорректные данные.' };
    },
    setDeviceState(deviceId, isOn) {
      if (typeof isOn !== 'boolean') return { ok: false, message: 'Состояние устройства должно быть ON или OFF.' };
      const next = snapshot();
      const device = next.devices.find((item) => item.id === deviceId);
      if (!device) return { ok: false, message: 'Неизвестное устройство.' };
      if (next.zones.find((zone) => zone.id === device.zoneId).mode === 'auto') return rejectDevice(device, isOn, 'Auto управляет устройствами. Для ручной команды выберите Manual.', 'operator', 'auto-mode');
      const reason = recoveryReason() ?? deviceBlockReason(next, device);
      if (isOn && reason) return rejectDevice(device, isOn, reason, 'safety', device.type === 'pump' ? 'water-or-recovery' : 'interlock');
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
      if (typeof zoneId !== 'string' || !Object.hasOwn(state.settings.zones, zoneId)) return { ok: false, issue: 'unknown-zone' };
      const next = snapshot();
      try { next.settings.zones[zoneId] = structuredClone(settings); }
      catch { return { ok: false, issue: 'invalid-settings' }; }
      if (!validateState(next).ok) return { ok: false, issue: 'invalid-settings' };
      if (thresholdSummary(state.settings.zones[zoneId]) === thresholdSummary(next.settings.zones[zoneId])) return { ok: true, persisted: status.persistent };
      return commit(next, { zoneId, source: 'settings', type: 'SETTINGS_CHANGED', objectId: zoneId, objectName: 'Пороги зоны',
        previousState: thresholdSummary(state.settings.zones[zoneId]), newState: thresholdSummary(next.settings.zones[zoneId]),
        message: 'Изменены пороговые значения зоны.', reason: 'Новые пороги применены; Auto и Alerts переоценены без нового измерения.' });
    },
    setSimulationPaused(paused) {
      if (typeof paused !== 'boolean') return { ok: false, issue: 'invalid-pause' };
      if (state.simulation.paused === paused) return { ok: true, persisted: status.persistent };
      const next = snapshot();
      next.simulation.paused = paused;
      return commit(next, { source: 'operator', type: paused ? 'SIMULATION_PAUSED' : 'SIMULATION_RESUMED', objectName: 'Учебный симулятор',
        previousState: state.simulation.paused ? 'paused' : 'running', newState: paused ? 'paused' : 'running',
        message: paused ? 'Симуляция поставлена на паузу.' : 'Симуляция продолжена.', reason: 'Явная команда управления симуляцией.' });
    },
    setSimulationIntervalMs(interval) {
      if (!Number.isInteger(interval) || interval < 3000 || interval > 10000) return { ok: false, issue: 'invalid-interval' };
      if (state.settings.simulationIntervalMs === interval) return { ok: true, persisted: status.persistent };
      const next = snapshot(); next.settings.simulationIntervalMs = interval;
      return commit(next, { source: 'settings', type: 'SETTINGS_CHANGED', objectName: 'Интервал симуляции',
        previousState: `${state.settings.simulationIntervalMs / 1000} с`, newState: `${interval / 1000} с`,
        message: 'Изменён интервал учебной симуляции.', reason: 'Скорость применена без нового измерения; состояние паузы сохранено.' });
    },
    applyScenario(zoneId, scenarioId) {
      const input = buildScenarioReadings(state, zoneId, scenarioId);
      if (!input.ok) return input;
      const result = api.recordMeasurements(input.measurements, now(), { zoneId, source: 'scenario',
        type: scenarioId === 'restore' ? 'SCENARIO_RESTORED' : 'SCENARIO_APPLIED', objectName: 'Учебный сценарий',
        newState: input.name, message: `Учебный сценарий: ${input.name}.`,
        reason: 'Заданы воспроизводимые входные показания; режим и пороги сохранены, решения приняты общими правилами.' });
      const mode = state.zones.find((zone) => zone.id === zoneId).mode;
      return { ...result, message: result.ok ? `Учебный сценарий «${input.name}» применён. ${mode === 'auto' ? 'Auto пересчитан' : 'Manual сохранён: устройства включаются оператором'}${result.persisted ? '.' : ' в памяти; сохранить не удалось.'}` : 'Сценарий не применён: проверьте показания и время измерений.' };
    },
    recordMeasurements(measurements, timestamp, context = null) {
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
        if (!Number.isFinite(measurement.value) || measurement.value < range.min || measurement.value > range.max) {
          if (sensor.type === 'waterLevel' || automatic) {
            sensor.status = 'offline';
            continue;
          }
          // Reject a Manual frame before domain comparisons can coerce an invalid value.
          return { ok: false, issue: 'invalid-state', ...preserveMeasurementSafety(measurements, timestamp) };
        }
        sensor.value = measurement.value;
        sensor.lastUpdatedAt = timestamp;
      }
      next.simulation.lastTickAt = timestamp;
      next.history.push({ timestamp, sensors: next.sensors.map((sensor) => ({
        sensorId: sensor.id, value: sensor.value, status: sensor.status, lastUpdatedAt: sensor.lastUpdatedAt,
      })) });
      next.history = next.history.slice(-HISTORY_LIMIT);
      const result = commit(next, context);
      if (result.ok) return result;
      // Reject the history frame, but never discard independently trusted safety inputs.
      return { ...result, ...preserveMeasurementSafety(measurements, timestamp) };
    },
    reset() {
      const result = resetData(options);
      if (result.state) {
        state = result.state;
        status = result.status;
        writeBlocked = ['invalid-json', 'incompatible-schema', 'invalid-state', 'read-failed'].includes(status.issue);
        checkLoadedSafety();
        notify();
      }
      return { ok: result.ok, applied: Boolean(result.state), persisted: result.ok && status.persistent,
        issue: result.issue ?? result.status?.issue ?? null };
    },
  });
  return api;
}
