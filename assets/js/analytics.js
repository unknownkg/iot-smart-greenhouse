import { SENSOR_TYPES } from './data.js';
import { sensorBlockReason, pumpBlockReason } from './safety.js';

// First five weights are the teacher's example; the rest are explicit teaching extensions.
export const RISK_WEIGHTS = Object.freeze({ 'temperature-high': 25, 'temperature-low': 20,
  'soil-low': 25, 'water-critical': 30, 'co2-high': 15, 'soil-high': 10,
  'humidity-low': 10, 'humidity-high': 10, 'light-low': 10, unavailable: 10, 'water-unavailable': 30 });
export const JUMP_FLOORS = Object.freeze({ temperature: 2, humidity: 5, soil: 5, light: 3000, co2: 150, waterLevel: 2 });
export const RISK_LEVELS = Object.freeze({ low: 'Low · низкий', moderate: 'Moderate · умеренный', high: 'High · высокий',
  critical: 'Critical · критический', unknown: 'Неполные данные' });

const canonicalDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const readingText = (value, unit) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${unit}`;

// Never forward-fill an offline/missing/invalid historical sample.
export function historyValue(sample, sensor) {
  if (!sensor || !sample || !canonicalDate(sample.timestamp) || !Array.isArray(sample.sensors)) return null;
  const definition = SENSOR_TYPES.find((type) => type.type === sensor.type);
  const matches = sample.sensors.filter((value) => value?.sensorId === sensor.id);
  if (!definition || matches.length !== 1) return null;
  const value = matches[0];
  return value.status === 'online' && value.lastUpdatedAt === sample.timestamp && Number.isFinite(value.value)
    && value.value >= definition.min && value.value <= definition.max ? value.value : null;
}

function rules(settings) {
  return [
    ['temperature-high', 'temperature', settings.temperature.max, '>', 'Перегрев'],
    ['temperature-low', 'temperature', settings.temperature.min, '<', 'Холод'],
    ['humidity-low', 'humidity', settings.humidity.min, '<', 'Низкая влажность воздуха'],
    ['humidity-high', 'humidity', settings.humidity.max, '>', 'Высокая влажность воздуха'],
    ['soil-low', 'soil', settings.soil.min, '<', 'Сухая почва'],
    ['soil-high', 'soil', settings.soil.max, '>', 'Высокая влажность почвы'],
    ['light-low', 'light', settings.light.min, '<', 'Недостаток света'],
    ['co2-high', 'co2', settings.co2.max, '>', 'Высокий CO₂'],
    ['water-critical', 'waterLevel', settings.waterLevel.critical, '≤', 'Критическая вода'],
  ];
}
const violates = (value, threshold, operator) => operator === '<' ? value < threshold : operator === '>' ? value > threshold : value <= threshold;

function historicalFindings(state, zoneId, definitions) {
  const anomalies = []; let validPairs = 0;
  const maxGap = state.settings.simulationIntervalMs * 2;
  const history = state.history;
  for (const definition of SENSOR_TYPES) {
    const sensor = state.sensors.find((s) => s.zoneId === zoneId && s.type === definition.type);
    const points = history.map((sample) => ({ timestamp: sample?.timestamp, value: historyValue(sample, sensor) }));
    let latestJump = null;
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]; const current = points[i];
      const deltaTime = Date.parse(current.timestamp) - Date.parse(previous.timestamp);
      if (previous.value === null || current.value === null || !(deltaTime > 0 && deltaTime <= maxGap)) continue;
      validPairs++;
      const absolute = Math.abs(current.value - previous.value);
      const percent = previous.value === 0 ? 0 : Math.abs((current.value - previous.value) / previous.value) * 100;
      if (percent >= 30 && absolute >= JUMP_FLOORS[definition.type]) latestJump = {
        type: 'sudden-change', sensorType: definition.type, timestamp: current.timestamp, priority: 'warning',
        description: `Резкое изменение в истории: ${definition.name}.`,
        evidence: `${previous.timestamp} → ${current.timestamp}: ${readingText(previous.value, definition.unit)} → ${readingText(current.value, definition.unit)}; ${percent.toFixed(1)}%, абсолютное изменение ≥ ${JUMP_FLOORS[definition.type]} ${definition.unit}. Учебный сценарий также может создавать такой переход.`,
      };
    }
    if (latestJump) anomalies.push(latestJump);
    const relevant = definitions.filter((rule) => rule[1] === definition.type);
    const last = points.at(-1);
    const currentRule = last?.value !== null && relevant.find((rule) => violates(last?.value, rule[2], rule[3]));
    if (!last || !currentRule) continue;
    let first = points.length - 1;
    while (first > 0) {
      const previous = points[first - 1]; const current = points[first];
      const elapsed = Date.parse(current.timestamp) - Date.parse(previous.timestamp);
      if (previous.value === null || !violates(previous.value, currentRule[2], currentRule[3]) || !(elapsed > 0 && elapsed <= maxGap)) break;
      first--;
    }
    const duration = Date.parse(last.timestamp) - Date.parse(points[first].timestamp);
    if (points.length - first >= 3 && duration >= 60000) anomalies.push({
      type: 'sustained', sensorType: definition.type, timestamp: last.timestamp, priority: definition.type === 'waterLevel' ? 'critical' : 'warning',
      description: `Длительное отклонение в доступной истории: ${definition.name}.`,
      evidence: `${points[first].timestamp} → ${last.timestamp}: ${Math.round(duration / 1000)} с вне текущего порога ${currentRule[3]} ${currentRule[2]} ${definition.unit}. Исторические пороги не сохранялись; используется действующий Settings.`,
    });
  }
  return { anomalies, historyStatus: validPairs ? 'available' : 'insufficient', validPairs };
}

export function analyzeZone(state, zoneId, storageStatus = {}) {
  const zone = state.zones.find((item) => item.id === zoneId);
  if (!zone) return { zoneId, score: null, level: 'unknown', complete: false, validInputs: 0, factors: [], anomalies: [], recommendations: [], historyStatus: 'insufficient' };
  const settings = state.settings.zones[zoneId];
  const definitions = rules(settings);
  const factors = new Map(); const issues = new Map(); const current = [];
  let validInputs = 0;
  function add(sensorType, weight, condition, evidence, source, severity = 'warning') {
    const previous = factors.get(sensorType);
    if (!previous) factors.set(sensorType, { sensorType, weight, condition, evidence: [evidence], sources: [source], severity });
    else {
      previous.weight = Math.max(previous.weight, weight);
      if (!previous.evidence.includes(evidence)) previous.evidence.push(evidence);
      if (!previous.sources.includes(source)) previous.sources.push(source);
      if (severity === 'critical') previous.severity = 'critical';
    }
  }
  for (const definition of SENSOR_TYPES) {
    const issue = sensorBlockReason(state, zoneId, definition.type);
    if (issue) {
      issues.set(definition.type, issue);
      add(definition.type, definition.type === 'waterLevel' ? RISK_WEIGHTS['water-unavailable'] : RISK_WEIGHTS.unavailable,
        'unavailable', issue, 'quality', definition.type === 'waterLevel' ? 'critical' : 'warning');
      current.push({ type: 'unavailable', sensorType: definition.type, priority: definition.type === 'waterLevel' ? 'critical' : 'warning', description: `${definition.name}: недостаточно достоверных данных.`, evidence: issue });
      continue;
    }
    validInputs++;
    const sensor = state.sensors.find((s) => s.zoneId === zoneId && s.type === definition.type);
    for (const [condition, type, threshold, operator, title] of definitions.filter((rule) => rule[1] === definition.type)) {
      if (!violates(sensor.value, threshold, operator)) continue;
      const evidence = `${definition.name}: ${readingText(sensor.value, definition.unit)}; порог ${operator} ${threshold} ${definition.unit}.`;
      const severity = type === 'waterLevel' ? 'critical' : 'warning';
      add(type, RISK_WEIGHTS[condition], condition, evidence, 'sensor', severity);
      current.push({ type: 'threshold', sensorType: type, priority: severity, description: title, evidence });
    }
  }
  const openAlerts = state.alerts.filter((a) => a.zoneId === zoneId && a.status === 'open');
  for (const alert of openAlerts) {
    const sensor = state.sensors.find((s) => s.id === alert.sensorId);
    const type = alert.type === 'pump-blocked' ? 'waterLevel' : sensor?.type;
    if (!type) continue;
    const weight = alert.type === 'pump-blocked' ? 30 : alert.type === 'sensor-unavailable'
      ? type === 'waterLevel' ? 30 : 10 : RISK_WEIGHTS[alert.type];
    if (weight === undefined) continue;
    add(type, weight, alert.type, `Открытый ${alert.severity === 'critical' ? 'Critical' : 'Warning'}: ${alert.reason}`, 'alert', alert.severity);
  }
  const allFactors = [...factors.values()];
  const trusted = !['invalid-json', 'invalid-state', 'incompatible-schema', 'read-failed'].includes(storageStatus.issue);
  const complete = validInputs === 6 && trusted;
  const score = trusted ? Math.min(100, Math.max(0, allFactors.reduce((sum, f) => sum + f.weight, 0))) : null;
  const critical = allFactors.some((factor) => factor.severity === 'critical');
  const level = !trusted ? 'unknown' : critical ? 'critical' : !complete ? 'unknown' : score >= 70 ? 'critical' : score >= 40 ? 'high' : score >= 20 ? 'moderate' : 'low';
  const history = historicalFindings(state, zoneId, definitions);
  const pumpIssue = pumpBlockReason(state, zoneId);
  const heating = state.devices.some((d) => d.zoneId === zoneId && d.type === 'heater' && d.isOn);
  const mode = zone.mode === 'auto' ? 'Auto' : 'Manual';
  const recommendations = allFactors.map((factor) => {
    const type = factor.sensorType; const issue = issues.get(type);
    const device = { temperature: 'fan', soil: 'pump', light: 'growLight', humidity: 'humidifier', co2: 'vent' }[type];
    const deviceOn = state.devices.find((d) => d.zoneId === zoneId && d.type === device)?.isOn;
    let action;
    if (issue) action = `Проверьте доступность и достоверность измерений. В ${mode} не делайте выводов по последнему устаревшему значению; safety имеет приоритет.`;
    else if (type === 'waterLevel') action = 'Проверьте запас и пополнение воды. Не обходите защиту насоса; разрешение работы определяется safety и режимом зоны.';
    else if (type === 'soil') action = pumpIssue ? 'Сначала проверьте воду и причину блокировки насоса. Не пытайтесь включать насос в обход safety.'
      : factor.condition === 'soil-high' ? 'Проверьте влажность и пороги, избегайте дополнительного полива до проверки причины.'
        : `Проверьте полив и запас воды. ${mode}: насос ${deviceOn ? 'уже включён' : 'выключен'}; сопоставьте показание и пороги, учитывая гистерезис.`;
    else if (type === 'temperature') action = `Проверьте температуру, пороги и ${factor.condition === 'temperature-low' ? 'обогрев' : 'вентиляцию'}. Текущий режим ${mode}; Heater и Fan несовместимы. Не включайте конфликтующие устройства.`;
    else if (type === 'co2') action = heating ? `Проверьте CO₂ и обогрев. В Auto форточка закрыта при обогреве: проверьте приоритет и входные данные, не обходите защитные ограничения.`
      : `Проверьте проветривание, CO₂ и пороги. ${mode}: форточка ${deviceOn ? 'открыта' : 'закрыта'}; сопоставьте это с правилом и гистерезисом.`;
    else if (type === 'light') action = `Проверьте фитолампу и пороги освещённости. ${mode}: фитолампа ${deviceOn ? 'включена' : 'выключена'}.`;
    else action = `Проверьте влажность воздуха и пороги. ${mode}: увлажнитель ${deviceOn ? 'включён' : 'выключен'}; не увеличивайте увлажнение без проверки причины.`;
    return { zoneId, zoneName: zone.name, sensorType: type, condition: issue ? 'unavailable' : factor.condition,
      evidence: factor.evidence.join(' '), priority: factor.severity, action };
  });
  if (history.anomalies.some((a) => a.type === 'sudden-change')) recommendations.push({ zoneId, zoneName: zone.name, sensorType: null,
    condition: 'historical-change', priority: 'info', evidence: 'В сохранённой истории обнаружен скачок по правилу 30% и абсолютному порогу.',
    action: 'Проверьте время и учебные сценарии, которыми могли быть заданы входы. Исторический скачок не является командой устройствам.' });
  if (!trusted) recommendations.unshift({ zoneId, zoneName: zone.name, sensorType: null, condition: 'untrusted-model', priority: 'critical',
    evidence: 'Сохранённая модель не восстановлена; показана временная учебная модель.', action: 'Восстановите корректные данные перед оценкой безопасности. Числовой Risk Score недоступен.' });
  return { zoneId, zoneName: zone.name, score, level, complete, validInputs, factors: allFactors,
    anomalies: [...current, ...history.anomalies], recommendations, historyStatus: history.historyStatus,
    historySamples: state.history.length, validPairs: history.validPairs, openAlerts: openAlerts.length,
    lastMeasurementAt: state.sensors.filter((s) => s.zoneId === zoneId && !sensorBlockReason(state, zoneId, s.type))
      .map((s) => s.lastUpdatedAt).sort().at(-1) ?? null };
}
