import { SENSOR_TYPES } from './data.js';

// Shared trust check: automation must never make decisions from offline/invalid inputs.
export function sensorBlockReason(state, zoneId, type) {
  const definition = SENSOR_TYPES.find((item) => item.type === type);
  const sensors = state.sensors.filter((sensor) => sensor.zoneId === zoneId && sensor.type === type);
  if (sensors.length !== 1) return `Нет достоверного датчика: ${definition.name}.`;
  const sensor = sensors[0];
  if (sensor.status !== 'online') return `${definition.name}: датчик offline, прежнее значение не используется.`;
  if (!Number.isFinite(sensor.value) || sensor.value < definition.min || sensor.value > definition.max || sensor.unit !== definition.unit
    || typeof sensor.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sensor.lastUpdatedAt))
    || new Date(sensor.lastUpdatedAt).toISOString() !== sensor.lastUpdatedAt) {
    return `Недостоверное показание: ${definition.name}.`;
  }
  return null;
}

// Domain safety is independent of the DOM and applies to direct store commands too.
export function pumpBlockReason(state, zoneId) {
  const issue = sensorBlockReason(state, zoneId, 'waterLevel');
  if (issue) return issue;
  const sensor = state.sensors.find((item) => item.zoneId === zoneId && item.type === 'waterLevel');
  const critical = state.settings?.zones?.[zoneId]?.waterLevel?.critical;
  if (!Number.isFinite(critical) || critical < 0 || critical > 100) return 'Не задан корректный критический порог воды.';
  return sensor.value <= critical ? `Вода ${sensor.value}%: критический порог ${critical}%. Насос заблокирован.` : null;
}

export function deviceBlockReason(state, device) {
  const zone = state.zones.find((item) => item.id === device.zoneId);
  if (device.type === 'pump') {
    const issue = pumpBlockReason(state, device.zoneId);
    if (issue) return issue;
  }
  if (zone?.mode === 'auto') {
    const input = { pump: 'soil', fan: 'temperature', heater: 'temperature', growLight: 'light', humidifier: 'humidity', vent: 'co2' }[device.type];
    const issue = sensorBlockReason(state, device.zoneId, input);
    if (issue) return issue;
    if (device.type === 'vent' && state.devices.some((item) => item.zoneId === device.zoneId && item.type === 'heater' && item.isOn)) {
      return 'Auto: форточка закрыта, приоритет обогрева.';
    }
  }
  const conflict = device.type === 'fan' ? 'heater' : device.type === 'heater' ? 'fan' : null;
  if (conflict && state.devices.some((item) => item.zoneId === device.zoneId && item.type === conflict && item.isOn)) {
    return conflict === 'heater' ? 'Сначала выключите обогреватель.' : 'Сначала выключите вентилятор.';
  }
  return null;
}

// Mutates only a candidate owned by the store, before validation/persistence/publication.
export function enforceDeviceSafety(state, timestamp, recoveryReason = null) {
  let changed = false;
  const messages = [];
  for (const zone of state.zones) {
    const pair = state.devices.filter((device) => device.zoneId === zone.id && ['heater', 'fan'].includes(device.type));
    if (pair.length === 2 && pair.every((device) => device.isOn)) {
      for (const device of pair) {
        device.isOn = false;
        device.source = 'system';
        device.changedAt = timestamp;
      }
      changed = true;
      messages.push(`${zone.name}: восстановлен конфликт Heater/Fan, оба устройства выключены.`);
    }
  }
  for (const device of state.devices) {
    const reason = recoveryReason ?? deviceBlockReason(state, device);
    if ((reason && device.isOn) || device.blockedReason !== reason) {
      if (reason) device.isOn = false;
      device.blockedReason = reason;
      // Clearing an old blocker after an Auto ON must not erase its real command source.
      if (reason || !device.isOn) {
        device.source = 'system';
        device.changedAt = timestamp;
      }
      changed = true;
    }
    if (reason) messages.push(`${device.zoneId}: ${reason}`);
  }
  return { changed, message: [...new Set(messages)].join(' ') };
}
