import { createInitialState, SENSOR_TYPES, humidityRecovery } from './data.js';

export const SCENARIOS = Object.freeze([
  { id: 'dry-soil', name: 'Сухая почва', input: 'soil' },
  { id: 'low-water', name: 'Критически мало воды', input: 'waterLevel' },
  { id: 'overheat', name: 'Перегрев', input: 'temperature' },
  { id: 'cold', name: 'Холод', input: 'temperature' },
  { id: 'low-light', name: 'Недостаток света', input: 'light' },
  { id: 'low-humidity', name: 'Низкая влажность воздуха', input: 'humidity' },
  { id: 'high-co2', name: 'Высокий CO₂', input: 'co2' },
].map(Object.freeze));

export function buildScenarioReadings(state, zoneId, scenarioId) {
  const zone = state.zones.find((item) => item.id === zoneId);
  const scenario = SCENARIOS.find((item) => item.id === scenarioId);
  if (!zone || (!scenario && scenarioId !== 'restore')) return { ok: false, message: 'Неизвестная зона или учебный сценарий.' };
  if (scenario && state.sensors.some((s) => s.zoneId === zoneId && s.type === scenario.input && s.status !== 'online')) {
    return { ok: false, message: 'Целевой датчик offline. Сценарий не восстанавливает связь и не подменяет устаревшее показание.' };
  }
  const t = state.settings.zones[zoneId];
  const seed = createInitialState(state.createdAt).sensors.filter((s) => s.zoneId === zoneId);
  const values = Object.fromEntries(seed.map((s) => [s.type, s.value]));
  const gap = Math.min(1, (t.temperature.max - t.temperature.min) / 2);
  // Условия устойчивого восстановления делают демонстрацию независимой от ранее сработавших блокировок.
  values.temperature = Math.min(t.temperature.max - gap, Math.max(t.temperature.min + gap, values.temperature));
  values.soil = t.soil.max;
  const humidityBand = humidityRecovery(t.humidity);
  values.humidity = Math.min(humidityBand.high, Math.max(humidityBand.low, values.humidity));
  values.light = Math.max(values.light, Math.min(200000, t.light.min + 600));
  values.co2 = Math.min(values.co2, Math.max(0, t.co2.max - 100));
  values.waterLevel = Math.max(values.waterLevel, Math.min(100, t.waterLevel.critical + 10));
  const requested = {
    'dry-soil': t.soil.min - 5, 'low-water': t.waterLevel.critical,
    overheat: t.temperature.max + 2, cold: t.temperature.min - 2,
    'low-light': t.light.min * 0.9, 'low-humidity': t.humidity.min - 5, 'high-co2': t.co2.max + 150,
  }[scenarioId];
  if (scenario) {
    const range = SENSOR_TYPES.find((item) => item.type === scenario.input);
    const target = Math.max(range.min, Math.min(range.max, requested));
    const impossible = (scenarioId === 'dry-soil' && target >= t.soil.min)
      || (scenarioId === 'low-humidity' && target >= t.humidity.min)
      || (scenarioId === 'cold' && target >= t.temperature.min)
      || (scenarioId === 'overheat' && target <= t.temperature.max)
      || (scenarioId === 'high-co2' && target <= t.co2.max)
      || (scenarioId === 'low-light' && target >= t.light.min)
      || (scenarioId === 'dry-soil' && t.waterLevel.critical === 100);
    if (impossible) return { ok: false, message: 'Сценарий невозможен при текущих крайних порогах. Измените Settings; значения не будут подменены.' };
    values[scenario.input] = target;
  }
  return { ok: true, name: scenario?.name ?? 'Восстановление учебных условий', measurements: state.sensors
    .filter((s) => s.status === 'online').map((s) => ({ id: s.id, value: s.zoneId === zoneId ? values[s.type] : s.value })) };
}
