// Domain safety is independent of the DOM and applies to direct store commands too.
export function pumpBlockReason(state, zoneId) {
  const sensors = state.sensors.filter((sensor) => sensor.zoneId === zoneId && sensor.type === 'waterLevel');
  if (sensors.length !== 1) return 'Нет достоверного датчика уровня воды.';
  const sensor = sensors[0];
  if (sensor.status !== 'online') return 'Датчик уровня воды offline.';
  if (!Number.isFinite(sensor.value) || sensor.value < 0 || sensor.value > 100 || sensor.unit !== '%'
    || typeof sensor.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sensor.lastUpdatedAt))
    || new Date(sensor.lastUpdatedAt).toISOString() !== sensor.lastUpdatedAt) {
    return 'Недостоверное показание уровня воды.';
  }
  const critical = state.settings?.zones?.[zoneId]?.waterLevel?.critical;
  if (!Number.isFinite(critical) || critical < 0 || critical > 100) return 'Не задан корректный критический порог воды.';
  return sensor.value <= critical ? `Вода ${sensor.value}%: критический порог ${critical}%. Насос заблокирован.` : null;
}

export function deviceBlockReason(state, device) {
  const zone = state.zones.find((item) => item.id === device.zoneId);
  if (zone?.mode !== 'manual') return 'Auto пока не реализован. Выберите Manual.';
  if (device.type === 'pump') return pumpBlockReason(state, device.zoneId);
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
      device.source = 'system';
      device.changedAt = timestamp;
      changed = true;
    }
    if (reason) messages.push(`${device.zoneId}: ${reason}`);
  }
  return { changed, message: [...new Set(messages)].join(' ') };
}
