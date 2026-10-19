import { ALERT_LIMIT, SENSOR_TYPES, humidityRecovery } from './data.js';
import { sensorBlockReason, pumpBlockReason } from './safety.js';
import { appendEvent, nextAuditId, auditDate, auditText } from './events.js';

const RULES = Object.freeze([
  ['temperature-low', 'temperature', 'min', 'Низкая температура', 'low'],
  ['temperature-high', 'temperature', 'max', 'Высокая температура', 'high'],
  ['humidity-low', 'humidity', 'min', 'Низкая влажность воздуха', 'low'],
  ['humidity-high', 'humidity', 'max', 'Высокая влажность воздуха', 'high'],
  ['soil-low', 'soil', 'min', 'Сухая почва', 'low'],
  ['light-low', 'light', 'min', 'Недостаточная освещённость', 'low'],
  ['co2-high', 'co2', 'max', 'Высокий CO₂', 'high'],
  ['water-critical', 'waterLevel', 'critical', 'Критически мало воды', 'critical'],
]);
const alertKey = (item) => `${item.zoneId}|${item.type}|${item.sensorId ?? item.deviceId}`;

function conditions(state) {
  const result = [];
  for (const zone of state.zones) {
    const settings = state.settings.zones[zone.id];
    for (const [type, sensorType, bound, title, direction] of RULES) {
      const sensor = state.sensors.find((s) => s.zoneId === zone.id && s.type === sensorType);
      const issue = sensorBlockReason(state, zone.id, sensorType);
      const threshold = settings[sensorType][bound];
      const limits = SENSOR_TYPES.find((s) => s.type === sensorType);
      let gap;
      if (sensorType === 'temperature') gap = Math.min(1, (settings.temperature.max - settings.temperature.min) / 2);
      else if (['humidity', 'soil'].includes(sensorType)) gap = Math.min(3, (settings[sensorType].max - settings[sensorType].min) / 2);
      else gap = sensorType === 'light' ? Math.min(600, limits.max - threshold)
        : sensorType === 'co2' ? Math.min(100, threshold) : Math.min(2, limits.max - threshold);
      const value = sensor.value;
      const starts = direction === 'critical' ? value <= threshold : direction === 'low' ? value < threshold : value > threshold;
      const humidityBand = sensorType === 'humidity' ? humidityRecovery(settings.humidity) : null;
      const recovered = direction === 'critical' ? value > threshold && value >= threshold + gap
        : direction === 'low' ? value >= (humidityBand?.low ?? threshold + gap) : value <= (humidityBand?.high ?? threshold - gap);
      result.push({ zoneId: zone.id, type, sensorId: sensor.id, deviceId: null,
        severity: direction === 'critical' ? 'critical' : 'warning', message: `${zone.name}: ${title}.`,
        reason: issue ? `${issue} Ожидается достоверное измерение для проверки восстановления.`
          : `${limits.name}: ${value} ${limits.unit}; порог ${direction === 'critical' ? '≤' : direction === 'low' ? '<' : '>'} ${threshold} ${limits.unit}.`,
        value: issue ? null : value, threshold, starts: !issue && starts, recovered: !issue && recovered });
    }
    for (const sensor of state.sensors.filter((s) => s.zoneId === zone.id)) {
      const issue = sensorBlockReason(state, zone.id, sensor.type);
      result.push({ zoneId: zone.id, type: 'sensor-unavailable', sensorId: sensor.id, deviceId: null,
        severity: sensor.type === 'waterLevel' ? 'critical' : 'warning', message: `${zone.name}: датчик недоступен или недостоверен.`,
        reason: issue ?? 'Получен достоверный online-статус датчика.', value: issue ? null : sensor.value, threshold: null,
        starts: Boolean(issue), recovered: !issue });
    }
    const pump = state.devices.find((d) => d.zoneId === zone.id && d.type === 'pump');
    const issue = pumpBlockReason(state, zone.id);
    const water = state.sensors.find((s) => s.zoneId === zone.id && s.type === 'waterLevel');
    result.push({ zoneId: zone.id, type: 'pump-blocked', sensorId: water.id, deviceId: pump.id, severity: 'critical',
      message: `${zone.name}: насос заблокирован защитой по воде.`, reason: issue ?? 'Вода допускает работу насоса.',
      value: sensorBlockReason(state, zone.id, 'waterLevel') ? null : water.value, threshold: settings.waterLevel.critical,
      starts: Boolean(issue && pump.blockedReason), recovered: !issue });
  }
  return result;
}

export function syncAlerts(state, timestamp) {
  const open = new Map(state.alerts.filter((a) => a.status === 'open').map((a) => [alertKey(a), a]));
  for (const { starts, recovered, ...condition } of conditions(state)) {
    const previous = open.get(alertKey(condition));
    if (!previous && !starts) continue;
    if (previous) {
      Object.assign(previous, condition);
      if (!recovered) continue;
      previous.status = 'resolved'; previous.resolvedAt = timestamp;
      appendEvent(state, { zoneId: previous.zoneId, source: 'system', type: 'ALERT_RESOLVED', objectId: previous.id,
        objectName: previous.message, previousState: 'open', newState: 'resolved', message: 'Предупреждение устранено.', reason: previous.reason }, timestamp);
    } else {
      const alert = { ...condition, id: nextAuditId(state, 'ALERT'), status: 'open', createdAt: timestamp, resolvedAt: null };
      state.alerts.push(alert);
      appendEvent(state, { zoneId: alert.zoneId, source: 'system', type: 'ALERT_OPENED', objectId: alert.id,
        objectName: alert.message, previousState: null, newState: 'open', message: `${alert.severity === 'critical' ? 'Critical' : 'Warning'}: ${alert.message}`, reason: alert.reason }, timestamp);
    }
  }
  if (state.alerts.length > ALERT_LIMIT) {
    const remove = new Set(state.alerts.filter((a) => a.status === 'resolved')
      .sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || Number(a.id.slice(6)) - Number(b.id.slice(6)))
      .slice(0, state.alerts.length - ALERT_LIMIT).map((a) => a.id));
    state.alerts = state.alerts.filter((a) => !remove.has(a.id));
  }
}

export function validateAlerts(state) {
  if (!Array.isArray(state.alerts) || state.alerts.length > ALERT_LIMIT) return false;
  const ids = new Set(); const active = new Set();
  for (const alert of state.alerts) {
    if (!alert || typeof alert.id !== 'string' || !/^ALERT-[1-9]\d*$/.test(alert.id) || ids.has(alert.id) || Number(alert.id.slice(6)) >= state.audit.nextId
      || !state.zones.some((z) => z.id === alert.zoneId) || !['warning', 'critical'].includes(alert.severity)
      || !['open', 'resolved'].includes(alert.status) || !auditDate(alert.createdAt)
      || (alert.status === 'open' ? alert.resolvedAt !== null : !auditDate(alert.resolvedAt) || alert.resolvedAt < alert.createdAt)
      || !auditText(alert.message) || !auditText(alert.reason)
      || ![alert.value, alert.threshold].every((v) => v === null || Number.isFinite(v))) return false;
    const sensor = state.sensors.find((s) => s.id === alert.sensorId && s.zoneId === alert.zoneId);
    const device = state.devices.find((d) => d.id === alert.deviceId && d.zoneId === alert.zoneId);
    const rule = RULES.find((r) => r[0] === alert.type);
    if (!sensor || (rule ? sensor.type !== rule[1] || alert.deviceId !== null
      : alert.type === 'sensor-unavailable' ? alert.deviceId !== null
        : alert.type !== 'pump-blocked' || sensor.type !== 'waterLevel' || device?.type !== 'pump')) return false;
    if (alert.status === 'open') { const key = alertKey(alert); if (active.has(key)) return false; active.add(key); }
    ids.add(alert.id);
  }
  return true;
}
