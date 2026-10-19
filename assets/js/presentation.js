// Перевод применяется только при отображении; исходная модель и сохранённые записи не меняются.
const zoneNames = Object.freeze({ Tomatoes: 'Томаты', Cucumbers: 'Огурцы', Greens: 'Зелень' });
export const zoneLabel = (name) => Object.hasOwn(zoneNames, name) ? zoneNames[name] : name;

const labels = Object.freeze({
  Manual: 'Ручной', Auto: 'Авто', Mixed: 'Смешанный', ON: 'Включено', OFF: 'Выключено',
  online: 'На связи', offline: 'Нет связи', Warning: 'Предупреждение', Critical: 'Критическое',
  Open: 'Активно', Resolved: 'Устранено', Info: 'Информация', Low: 'Низкий',
  Moderate: 'Умеренный', High: 'Высокий', BLOCKED: 'Блокировка', AVAILABLE: 'Доступно',
  Alerts: 'Предупреждения', Heater: 'Обогреватель', Fan: 'Вентилятор', safety: 'защита',
  Tomatoes: 'Томаты', Cucumbers: 'Огурцы', Greens: 'Зелень', Settings: 'настройки',
  paused: 'На паузе', running: 'Работает', pump: 'Насос', growLight: 'Фитолампа', humidifier: 'Увлажнитель', vent: 'Форточка',
});
const tokens = new Map(Object.entries(labels).map(([key, value]) => [key.toLowerCase(), value]));
export function displayText(value) {
  return String(value ?? '').replace(/Открытый Warning/g, 'Активное предупреждение').replace(/Открытый Critical/g, 'Активное критическое предупреждение')
    .replace(/Risk Score/g, 'Индекс риска').replace(/Event Log/g, 'Журнал событий')
    .replace(/Целевой датчик offline/g, 'Нет связи с целевым датчиком')
    .replace(/датчик offline/g, 'нет связи с датчиком')
    .replace(/[Вв] Auto/g, 'в автоматическом режиме').replace(/[Вв] Manual/g, 'в ручном режиме')
    .replace(/Auto пересчитан/g, 'Автоматическое управление пересчитано')
    .replace(/используется действующий Settings/g, 'используются действующие настройки')
    .replace(/определяется safety и/g, 'определяется защитой и').replace(/в обход safety/g, 'в обход защиты')
    .replace(/Нет достоверного online-показания/g, 'Нет достоверного показания от датчика на связи')
    .replace(/Датчик отмечен online/g, 'Связь с датчиком подтверждена')
    .replace(/Получен достоверный online-статус датчика/g, 'Получено достоверное подтверждение связи с датчиком')
    .replace(/\b(?:Manual|Auto|Mixed|ON|OFF|online|offline|Warning|Critical|Open|Resolved|Info|Low|Moderate|High|BLOCKED|AVAILABLE|Alerts|Heater|Fan|safety|Tomatoes|Cucumbers|Greens|Settings|paused|running|pump|growLight|humidifier|vent)\b/gi,
      (token) => tokens.get(token.toLowerCase()));
}

const eventNames = Object.freeze({
  DEVICE_ON: 'Включение устройства', DEVICE_OFF: 'Выключение устройства', DEVICE_BLOCKED: 'Блокировка устройства',
  DEVICE_UNBLOCKED: 'Снятие блокировки', MODE_CHANGED: 'Смена режима', COMMAND_REJECTED: 'Отказ в выполнении команды',
  SCENARIO_APPLIED: 'Применение сценария', SCENARIO_RESTORED: 'Восстановление условий', SETTINGS_CHANGED: 'Изменение настроек',
  ALERT_OPENED: 'Появление предупреждения', ALERT_RESOLVED: 'Устранение предупреждения', SIMULATION_PAUSED: 'Пауза симуляции',
  SIMULATION_RESUMED: 'Продолжение симуляции', SENSOR_STATUS_CHANGED: 'Изменение связи с датчиком', STATE_MIGRATED: 'Обновление формата данных',
});
export const eventLabel = (type) => Object.hasOwn(eventNames, type) ? eventNames[type] : type;
