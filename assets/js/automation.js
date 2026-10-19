import { sensorBlockReason, pumpBlockReason } from './safety.js';
import { humidityRecovery } from './data.js';

// Pure decisions for one zone. Store owns all mutations, safety and persistence.
export function evaluateAutomation(state, zoneId) {
  const zone = state.zones.find((item) => item.id === zoneId);
  if (zone?.mode !== 'auto') return {};
  const settings = state.settings.zones[zoneId];
  const values = Object.fromEntries(state.sensors.filter((s) => s.zoneId === zoneId).map((s) => [s.type, s.value]));
  const on = (type) => state.devices.some((d) => d.zoneId === zoneId && d.type === type && d.isOn);
  const decisions = {};
  const decide = (device, input, start, stop, description, extraIssue = null) => {
    const issue = extraIssue ?? sensorBlockReason(state, zoneId, input);
    const isOn = issue ? false : start ? true : stop ? false : on(device);
    decisions[device] = { isOn, reason: issue ?? `Auto: ${description}; ${isOn ? 'ON' : 'OFF'}${!start && !stop ? ' · удержание в полосе гистерезиса' : ''}.` };
  };
  decide('pump', 'soil', values.soil < settings.soil.min, values.soil >= settings.soil.max,
    `почва ${values.soil}%; ON < ${settings.soil.min}%, OFF ≥ ${settings.soil.max}%`, pumpBlockReason(state, zoneId));
  const temperatureGap = Math.min(1, (settings.temperature.max - settings.temperature.min) / 2);
  const fanRelease = settings.temperature.max - temperatureGap;
  const heaterRelease = settings.temperature.min + temperatureGap;
  decide('fan', 'temperature', values.temperature > settings.temperature.max, values.temperature <= fanRelease,
    `температура ${values.temperature} °C; ON > ${settings.temperature.max}, OFF ≤ ${fanRelease}`);
  decide('heater', 'temperature', values.temperature < settings.temperature.min, values.temperature >= heaterRelease,
    `температура ${values.temperature} °C; ON < ${settings.temperature.min}, OFF ≥ ${heaterRelease}`);
  const lightRelease = Math.min(200000, settings.light.min + 600);
  decide('growLight', 'light', values.light < settings.light.min, values.light >= lightRelease,
    `свет ${values.light} lux; ON < ${settings.light.min}, OFF ≥ ${lightRelease}`);
  const humidityRelease = humidityRecovery(settings.humidity).low;
  decide('humidifier', 'humidity', values.humidity < settings.humidity.min, values.humidity >= humidityRelease,
    `влажность ${values.humidity}%; ON < ${settings.humidity.min}%, OFF ≥ ${humidityRelease}%`);
  const co2Release = Math.max(0, settings.co2.max - 100);
  decide('vent', 'co2', values.co2 > settings.co2.max, values.co2 <= co2Release,
    `CO₂ ${values.co2} ppm; ON > ${settings.co2.max}, OFF ≤ ${co2Release}`,
    decisions.heater.isOn ? 'Auto: форточка закрыта, приоритет обогрева.' : null);
  return decisions;
}
