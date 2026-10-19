import { SENSOR_TYPES } from './data.js';

const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('ru-RU');

// Фильтруем только представление, не изменяя и не удаляя сущности модели.
export function filterSensors(state, { query = '', zoneId = '', status = '' } = {}) {
  const text = normalize(query);
  return state.sensors.filter((sensor) => {
    const type = SENSOR_TYPES.find((item) => item.type === sensor.type);
    return (!zoneId || sensor.zoneId === zoneId) && (!status || sensor.status === status)
      && (!text || normalize(`${sensor.id} ${sensor.type} ${type.label} ${type.name}`).includes(text));
  });
}

export function filterZones(state, query = '') {
  const text = normalize(query);
  return state.zones.filter((zone) => !text || normalize(`${zone.id} ${zone.name} ${zone.crop}`).includes(text));
}
