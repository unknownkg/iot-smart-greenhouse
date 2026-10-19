import { SENSOR_TYPES, DEVICE_TYPES, HISTORY_LIMIT } from './data.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const format = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
const time = (value) => new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'medium',
}).format(new Date(value));
const icon = (type, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="assets/img/icons.svg#${type}"></use></svg>`;
const badge = (text, color = '') => `<span class="badge ${color ? `badge-${color}` : ''}">${escape(text)}</span>`;
const readings = (state, zoneId) => Object.fromEntries(state.sensors
  .filter((sensor) => sensor.zoneId === zoneId).map((sensor) => [sensor.type, sensor]));
const reading = (sensor) => `${format(sensor.value)} ${escape(sensor.unit)}${sensor.status === 'offline' ? ' (устар.)' : ''}`;

export function buildDashboardModel(state) {
  const averages = Object.fromEntries(['temperature', 'humidity', 'soil', 'waterLevel'].map((type) => {
    const values = state.sensors.filter((sensor) => sensor.type === type && sensor.status === 'online');
    return [type, values.length ? Math.round(values.reduce((sum, sensor) => sum + sensor.value, 0) / values.length * 10) / 10 : null];
  }));
  return { ...averages, online: state.sensors.filter((sensor) => sensor.status === 'online').length };
}

function kpiCards(state) {
  const model = buildDashboardModel(state);
  const definitions = [
    ['temperature', 'Температура', 'temperature', '°C'],
    ['humidity', 'Влажность воздуха', 'water', '%'],
    ['soil', 'Влажность почвы', 'soil', '%'],
    ['waterLevel', 'Запас воды', 'tank', '%'],
    ['alerts', 'Активные alerts', 'alert', ''],
    ['online', 'Датчиков online', 'sensor', '/ 18'],
  ];
  return definitions.map(([type, name, symbol, unit]) => {
    const unavailable = model[type] === null || type === 'alerts';
    const value = unavailable ? '—' : format(model[type]);
    const caption = type === 'alerts' ? 'Модуль не подключён' : type === 'online'
      ? 'Виртуальные датчики' : unavailable ? 'Нет online-данных' : 'Среднее online · симуляция';
    return `<article class="kpi-card"><div class="kpi-top"><span>${name}</span>${icon(symbol)}</div>
      <p class="kpi-value mono">${value}<span>${unit}</span></p><p class="kpi-bottom">${caption}</p></article>`;
  }).join('');
}

export function zoneCards(state, detailed = false) {
  return state.zones.map((zone) => {
    const values = readings(state, zone.id);
    const types = detailed ? SENSOR_TYPES : SENSOR_TYPES.filter((sensor) => ['temperature', 'humidity', 'waterLevel'].includes(sensor.type));
    const metrics = types.map((type) => `<div><dt>${type.name}</dt><dd class="mono">${reading(values[type.type])}</dd></div>`).join('');
    const online = state.sensors.filter((sensor) => sensor.zoneId === zone.id && sensor.status === 'online').length;
    return `<article class="zone-card"><div class="zone-head"><div>
      <p class="zone-id mono">${escape(zone.id)} / ${escape(zone.crop)}</p><h3>${escape(zone.name)}</h3></div>${badge('Симуляция', 'cyan')}</div>
      <div class="zone-visual">${icon('greenhouse', 'greenhouse')}<div><small>Влажность почвы</small>
      <strong class="mono">${format(values.soil.value)}<span> ${escape(values.soil.unit)}${values.soil.status === 'offline' ? ' (устар.)' : ''}</span></strong><span>Учебное измерение</span></div></div>
      <dl class="zone-metrics">${metrics}<div><dt>Риск</dt><dd class="muted">Не рассчитан</dd></div></dl>
      <div class="zone-footer"><span>${online} / 6 online · симуляция</span><span>${state.simulation.paused ? 'На паузе' : `Шаг ${state.settings.simulationIntervalMs / 1000} с`}</span></div></article>`;
  }).join('');
}

export function sensorRows(state, zoneId) {
  return state.sensors.filter((sensor) => !zoneId || sensor.zoneId === zoneId).map((sensor) => {
    const type = SENSOR_TYPES.find((item) => item.type === sensor.type);
    const zone = state.zones.find((item) => item.id === sensor.zoneId);
    return `<tr><td>${type.label}<br><small class="muted mono">${escape(sensor.id)}</small></td>
      <td>${escape(zone.name)}<br><small class="muted">${escape(zone.id)}</small></td>
      <td class="mono">${format(sensor.value)}${sensor.status === 'offline' ? '<br><small class="muted">Устаревшее</small>' : ''}</td><td>${escape(sensor.unit)}</td>
      <td>${badge(`${sensor.status} · симуляция`, sensor.status === 'online' ? 'green' : 'yellow')}</td>
      <td><time datetime="${escape(sensor.lastUpdatedAt)}">${time(sensor.lastUpdatedAt)}</time></td></tr>`;
  }).join('');
}

export function deviceCards(state, zoneId) {
  return state.devices.filter((device) => device.zoneId === zoneId).map((device) => {
    const type = DEVICE_TYPES.find((item) => item.type === device.type);
    return `<article class="device-card" data-device-id="${escape(device.id)}"><div class="device-top">${icon(type.icon)}
      <button class="switch" type="button" role="switch" aria-checked="${device.isOn}"
      aria-label="${type.name}: управление пока недоступно" disabled></button></div>
      <h3>${type.name}</h3><p>${type.description}</p>${badge(`${device.isOn ? 'Включено' : 'Выключено'} · демо`)}
      <p class="helper">Управление не подключено${device.blockedReason ? `: ${escape(device.blockedReason)}` : ''}.</p></article>`;
  }).join('');
}

function deviceSummary(state) {
  return DEVICE_TYPES.map((type) => {
    const devices = state.devices.filter((device) => device.type === type.type);
    return `<div class="device-row">${icon(type.icon)}<strong>${type.name}</strong><span>
      ${devices.filter((device) => device.isOn).length} / ${devices.length} включено · демо</span></div>`;
  }).join('');
}

function storageMessage(state, status) {
  if (status.persistent) return `Учебные измерения сохранены локально. Последнее сохранение: ${time(state.savedAt)}. ${state.simulation.paused ? 'Симуляция на паузе.' : 'Работает программный симулятор; реального оборудования нет.'}`;
  const invalid = ['invalid-json', 'invalid-state', 'incompatible-schema'].includes(status.issue);
  return invalid
    ? 'Сохранённые данные повреждены или несовместимы. Исходная запись сохранена нетронутой; показана временная демомодель в памяти. Для восстановления предусмотрен программный сброс.'
    : 'localStorage недоступен или запись не удалась. Показаны демоданные в памяти; сохранение между переходами и перезагрузками не гарантируется.';
}

export function renderDataPage(store, documentRoot = document, simulator = null) {
  const page = documentRoot.body.dataset.page;
  const initial = store.getState();
  const picker = documentRoot.querySelector('[data-zone-select]');
  let selectedZone = initial.zones[0].id;
  if (picker) {
    picker.innerHTML = initial.zones.map((zone) => `<option value="${escape(zone.id)}">${escape(zone.name)} · ${escape(zone.id)}</option>`).join('');
    picker.addEventListener('change', () => { selectedZone = picker.value; render(); });
  }
  const storageNotice = documentRoot.createElement('div');
  storageNotice.className = 'notice';
  storageNotice.setAttribute('role', 'status');
  documentRoot.querySelector('main > .notice').after(storageNotice);
  let simulationPanel;
  if (simulator) {
    simulationPanel = documentRoot.createElement('section');
    simulationPanel.className = 'panel simulation-panel';
    simulationPanel.setAttribute('aria-label', 'Управление учебной симуляцией');
    simulationPanel.innerHTML = `<div class="panel-heading"><div><h2>Учебный симулятор</h2>
      <p>Программные показания · оборудование не подключено</p></div><span class="badge badge-cyan" data-sim-status role="status"></span></div>
      <div class="form-actions"><button type="button" class="button" data-sim-action="pause">Пауза</button>
      <button type="button" class="button" data-sim-action="resume">Продолжить</button>
      <button type="button" class="button" data-sim-action="step">Один шаг</button></div>
      <p class="helper" data-sim-meta></p>`;
    storageNotice.after(simulationPanel);
    simulationPanel.querySelectorAll('[data-sim-action]').forEach((button) => {
      button.addEventListener('click', () => simulator[button.dataset.simAction]());
    });
  }
  const fill = (selector, markup) => {
    const container = documentRoot.querySelector(selector);
    if (container) container.innerHTML = markup;
  };

  function render() {
    const state = store.getState();
    storageNotice.textContent = storageMessage(state, store.getStatus());
    if (simulationPanel) {
      const paused = state.simulation.paused;
      simulationPanel.querySelector('[data-sim-status]').textContent = paused ? 'На паузе' : 'Работает';
      simulationPanel.querySelector('[data-sim-action="pause"]').disabled = paused;
      simulationPanel.querySelector('[data-sim-action="resume"]').disabled = !paused;
      simulationPanel.querySelector('[data-sim-action="step"]').disabled = !paused;
      simulationPanel.querySelector('[data-sim-meta]').textContent = `Интервал: ${state.settings.simulationIntervalMs / 1000} с · История: ${state.history.length} / ${HISTORY_LIMIT} срезов · Последнее измерение: ${state.simulation.lastTickAt ? time(state.simulation.lastTickAt) : 'ещё нет'}`;
    }
    if (page === 'dashboard') {
      fill('[data-kpis]', kpiCards(state));
      fill('[data-zone-cards]', zoneCards(state));
      fill('[data-device-summary]', deviceSummary(state));
    } else if (page === 'zones') {
      fill('[data-zone-cards]', zoneCards(state, true));
      fill('[data-sensor-rows]', sensorRows(state, selectedZone));
    } else if (page === 'sensors') {
      fill('[data-sensor-rows]', sensorRows(state));
    } else if (page === 'control') {
      fill('[data-device-cards]', deviceCards(state, selectedZone));
      const zone = state.zones.find((item) => item.id === selectedZone);
      const mode = documentRoot.querySelector('[data-zone-mode]');
      mode.textContent = `${zone.mode === 'auto' ? 'Auto' : 'Manual'} · не запущен`;
    } else if (page === 'settings') {
      const settings = state.settings.zones[selectedZone];
      documentRoot.querySelectorAll('[data-setting]').forEach((input) => {
        const [type, key] = input.dataset.setting.split('.');
        input.value = settings[type][key];
      });
    }
  }
  render();
  return store.subscribe(render);
}
