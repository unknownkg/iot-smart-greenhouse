export const SCHEMA_VERSION = 2;
// 240 whole-greenhouse samples: about 20 minutes at the default 5 second interval.
export const HISTORY_LIMIT = 240;

export const SENSOR_TYPES = Object.freeze([
  { type: 'temperature', label: 'Temperature', name: 'Температура', unit: '°C', min: -50, max: 80 },
  { type: 'humidity', label: 'Air Humidity', name: 'Влажность воздуха', unit: '%', min: 0, max: 100 },
  { type: 'soil', label: 'Soil Moisture', name: 'Влажность почвы', unit: '%', min: 0, max: 100 },
  { type: 'light', label: 'Light', name: 'Освещённость', unit: 'lux', min: 0, max: 200000 },
  { type: 'co2', label: 'CO₂', name: 'Уровень CO₂', unit: 'ppm', min: 0, max: 100000 },
  { type: 'waterLevel', label: 'Water Level', name: 'Запас воды', unit: '%', min: 0, max: 100 },
].map(Object.freeze));

export const DEVICE_TYPES = Object.freeze([
  { type: 'pump', name: 'Насос', icon: 'water', description: 'Полив и подача воды' },
  { type: 'fan', name: 'Вентилятор', icon: 'fan', description: 'Вентиляция и охлаждение' },
  { type: 'growLight', name: 'Фитолампа', icon: 'light', description: 'Дополнительное освещение' },
  { type: 'humidifier', name: 'Увлажнитель', icon: 'water', description: 'Влажность воздуха' },
  { type: 'heater', name: 'Обогреватель', icon: 'heater', description: 'Поддержание температуры' },
  { type: 'vent', name: 'Форточка', icon: 'vent', description: 'Естественная вентиляция' },
].map(Object.freeze));

export const ZONE_DEFINITIONS = Object.freeze([
  { id: 'ZONE-01', name: 'Tomatoes', crop: 'Томаты' },
  { id: 'ZONE-02', name: 'Cucumbers', crop: 'Огурцы' },
  { id: 'ZONE-03', name: 'Greens', crop: 'Зелень' },
].map(Object.freeze));

// Educational examples, not universal crop thresholds or physical measurements.
export function createInitialState(timestamp = new Date().toISOString()) {
  const readings = [
    [24.8, 67, 42, 18400, 820, 72],
    [25.2, 72, 58, 16500, 910, 68],
    [22.4, 64, 51, 21000, 650, 81],
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    isDemo: true,
    createdAt: timestamp,
    savedAt: null,
    simulation: { paused: false, lastTickAt: null },
    zones: ZONE_DEFINITIONS.map((zone) => ({ ...zone, mode: 'manual' })),
    sensors: ZONE_DEFINITIONS.flatMap((zone, index) => SENSOR_TYPES.map((sensor, typeIndex) => ({
      id: `${zone.id}-S-${sensor.type}`,
      zoneId: zone.id,
      type: sensor.type,
      value: readings[index][typeIndex],
      unit: sensor.unit,
      status: 'online',
      lastUpdatedAt: timestamp,
    }))),
    devices: ZONE_DEFINITIONS.flatMap((zone) => DEVICE_TYPES.map((device) => ({
      id: `${zone.id}-D-${device.type}`,
      zoneId: zone.id,
      type: device.type,
      isOn: false,
      source: 'initial',
      changedAt: timestamp,
      blockedReason: null,
    }))),
    settings: {
      theme: 'dark',
      simulationIntervalMs: 5000,
      zones: Object.fromEntries(ZONE_DEFINITIONS.map((zone) => [zone.id, {
        temperature: { min: 20, max: 28 },
        humidity: { min: 50, max: 80 },
        soil: { min: 35, max: 75 },
        light: { min: 12000 },
        waterLevel: { critical: 15 },
        co2: { max: 1500 },
      }])),
    },
    // Operational alerts/events remain reserved for later stages.
    alerts: [],
    events: [],
    history: [],
  };
}
