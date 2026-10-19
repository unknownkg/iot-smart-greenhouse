import { EVENT_LIMIT, DEVICE_TYPES } from './data.js';
import { evaluateAutomation } from './automation.js';

export const EVENT_SOURCES = Object.freeze(['operator', 'auto', 'safety', 'scenario', 'settings', 'system']);
export const EVENT_TYPES = Object.freeze(['DEVICE_ON', 'DEVICE_OFF', 'DEVICE_BLOCKED', 'DEVICE_UNBLOCKED',
  'MODE_CHANGED', 'COMMAND_REJECTED', 'SCENARIO_APPLIED', 'SCENARIO_RESTORED', 'SETTINGS_CHANGED',
  'ALERT_OPENED', 'ALERT_RESOLVED', 'SIMULATION_PAUSED', 'SIMULATION_RESUMED', 'SENSOR_STATUS_CHANGED', 'STATE_MIGRATED']);
export const auditDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const auditText = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
export const nextAuditId = (state, prefix) => `${prefix}-${state.audit.nextId++}`;

export function thresholdSummary(settings) {
  return `Температура ${settings.temperature.min}…${settings.temperature.max} °C; влажность ${settings.humidity.min}…${settings.humidity.max}%; `
    + `почва ${settings.soil.min}…${settings.soil.max}%; свет ≥${settings.light.min} lux; вода >${settings.waterLevel.critical}%; CO₂ ≤${settings.co2.max} ppm`;
}

export function appendEvent(state, event, timestamp) {
  const dedupeKey = event.dedupeKey ?? null;
  if (dedupeKey && state.events.some((old) => old.dedupeKey === dedupeKey
    && timestamp >= old.timestamp && Date.parse(timestamp) - Date.parse(old.timestamp) < 30000)) return false;
  state.events.push({ id: nextAuditId(state, 'EVENT'), timestamp, zoneId: null, source: 'system',
    type: event.type, objectId: null, objectName: 'Система', previousState: null, newState: null,
    message: event.message, reason: event.reason, ...event, dedupeKey });
  state.events = state.events.slice(-EVENT_LIMIT);
  return true;
}

export function recordDeviceEvents(previous, next, timestamp, context = {}) {
  for (const device of next.devices) {
    const old = previous.devices.find((item) => item.id === device.id);
    const name = DEVICE_TYPES.find((item) => item.type === device.type).name;
    if (old.isOn !== device.isOn) {
      const action = context.deviceActions?.[device.id];
      const source = action?.source ?? (device.source === 'automation' ? 'auto' : device.source === 'manual' ? 'operator' : 'safety');
      const decision = evaluateAutomation(next, device.zoneId)[device.type];
      appendEvent(next, { zoneId: device.zoneId, source, type: device.isOn ? 'DEVICE_ON' : 'DEVICE_OFF',
        objectId: device.id, objectName: name, previousState: old.isOn ? 'ON' : 'OFF', newState: device.isOn ? 'ON' : 'OFF',
        message: `${name}: ${device.isOn ? 'включено' : 'выключено'}.`,
        reason: action?.reason ?? device.blockedReason ?? (source === 'auto' ? decision.reason : source === 'safety'
          ? context.safetyReason || 'Устройство отключено защитной проверкой модели.' : context.reason ?? 'Ручная команда оператора.') }, timestamp);
    }
    if (device.type === 'pump' && Boolean(old.blockedReason) !== Boolean(device.blockedReason)) {
      appendEvent(next, { zoneId: device.zoneId, source: 'safety', type: device.blockedReason ? 'DEVICE_BLOCKED' : 'DEVICE_UNBLOCKED',
        objectId: device.id, objectName: name, previousState: old.blockedReason ? 'BLOCKED' : 'AVAILABLE',
        newState: device.blockedReason ? 'BLOCKED' : 'AVAILABLE', message: `Насос: ${device.blockedReason ? 'защитная блокировка' : 'блокировка снята'}.`,
        reason: device.blockedReason ?? 'Причина защитной блокировки устранена; дальнейшее управление согласно режиму зоны.' }, timestamp);
    }
  }
}

export function validateJournal(state) {
  if (!state.audit || Object.keys(state.audit).length !== 1 || !Number.isSafeInteger(state.audit.nextId) || state.audit.nextId < 1
    || !Array.isArray(state.events) || state.events.length > EVENT_LIMIT) return false;
  const ids = new Set();
  for (const event of state.events) {
    if (!event || !/^EVENT-[1-9]\d*$/.test(event.id) || ids.has(event.id) || Number(event.id.slice(6)) >= state.audit.nextId
      || !auditDate(event.timestamp) || !(event.zoneId === null || state.zones.some((z) => z.id === event.zoneId))
      || !EVENT_SOURCES.includes(event.source) || !EVENT_TYPES.includes(event.type)
      || !(event.objectId === null || auditText(event.objectId, 64)) || !auditText(event.objectName, 120)
      || ![event.previousState, event.newState].every((value) => value === null || auditText(value))
      || !auditText(event.message) || !auditText(event.reason)
      || !(event.dedupeKey === null || auditText(event.dedupeKey, 150))) return false;
    ids.add(event.id);
  }
  return true;
}
