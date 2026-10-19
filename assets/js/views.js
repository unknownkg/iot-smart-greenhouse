import { SENSOR_TYPES, DEVICE_TYPES, HISTORY_LIMIT } from './data.js';
import { deviceBlockReason } from './safety.js';
import { evaluateAutomation } from './automation.js';
import { SCENARIOS } from './scenarios.js';
import { bindSettingsForm } from './settings-form.js';
import { bindMonitoringViews, recentEvents } from './monitoring-views.js';

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

export function modeLabel(state) {
  const modes = new Set(state.zones.map((zone) => zone.mode));
  return modes.size > 1 ? 'Mixed' : modes.has('auto') ? 'Auto' : 'Manual';
}

export function buildDashboardModel(state) {
  const averages = Object.fromEntries(['temperature', 'humidity', 'soil', 'waterLevel'].map((type) => {
    const values = state.sensors.filter((sensor) => sensor.type === type && sensor.status === 'online');
    return [type, values.length ? Math.round(values.reduce((sum, sensor) => sum + sensor.value, 0) / values.length * 10) / 10 : null];
  }));
  const open = state.alerts.filter((alert) => alert.status === 'open');
  return { ...averages, online: state.sensors.filter((sensor) => sensor.status === 'online').length, alerts: open.length,
    warning: open.filter((a) => a.severity === 'warning').length, critical: open.filter((a) => a.severity === 'critical').length };
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
    const unavailable = model[type] === null;
    const value = unavailable ? '—' : format(model[type]);
    const caption = type === 'alerts' ? `${model.warning} Warning · ${model.critical} Critical` : type === 'online'
      ? 'Виртуальные датчики' : unavailable ? 'Нет online-данных' : 'Среднее online · симуляция';
    return `<article class="kpi-card"><div class="kpi-top"><span>${name}</span>${icon(symbol)}</div>
      <p class="kpi-value mono${type === 'alerts' ? model.critical ? ' status-critical' : model.warning ? ' status-warning' : '' : ''}">${value}<span>${unit}</span></p><p class="kpi-bottom">${caption}</p></article>`;
  }).join('');
}

export function zoneCards(state, detailed = false) {
  return state.zones.map((zone) => {
    const values = readings(state, zone.id);
    const types = detailed ? SENSOR_TYPES : SENSOR_TYPES.filter((sensor) => ['temperature', 'humidity', 'waterLevel'].includes(sensor.type));
    const metrics = types.map((type) => `<div><dt>${type.name}</dt><dd class="mono">${reading(values[type.type])}</dd></div>`).join('');
    const online = state.sensors.filter((sensor) => sensor.zoneId === zone.id && sensor.status === 'online').length;
    const on = state.devices.filter((device) => device.zoneId === zone.id && device.isOn).length;
    const activeAlerts = state.alerts.filter((a) => a.zoneId === zone.id && a.status === 'open');
    return `<article class="zone-card"><div class="zone-head"><div>
      <p class="zone-id mono">${escape(zone.id)} / ${escape(zone.crop)}</p><h3>${escape(zone.name)}</h3></div>${badge('Симуляция', 'cyan')}</div>
      <div class="zone-visual">${icon('greenhouse', 'greenhouse')}<div><small>Влажность почвы</small>
      <strong class="mono">${format(values.soil.value)}<span> ${escape(values.soil.unit)}${values.soil.status === 'offline' ? ' (устар.)' : ''}</span></strong><span>Учебное измерение</span></div></div>
      <dl class="zone-metrics">${metrics}<div><dt>Режим</dt><dd>${zone.mode === 'auto' ? 'Auto' : 'Manual'}</dd></div><div><dt>Устройства</dt><dd>${on} / 6 устройств ON</dd></div><div><dt>Alerts</dt><dd class="${activeAlerts.some((a) => a.severity === 'critical') ? 'status-critical' : activeAlerts.length ? 'status-warning' : 'muted'}">${activeAlerts.length} активных</dd></div><div><dt>Риск</dt><dd class="muted">Не рассчитан</dd></div></dl>
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
  const automatic = state.zones.find((zone) => zone.id === zoneId).mode === 'auto';
  const decisions = evaluateAutomation(state, zoneId);
  return state.devices.filter((device) => device.zoneId === zoneId).map((device) => {
    const type = DEVICE_TYPES.find((item) => item.type === device.type);
    const reason = device.blockedReason ?? deviceBlockReason(state, device);
    const disabled = automatic || (!device.isOn && reason);
    const sources = { initial: 'Начальное состояние', manual: 'Оператор', system: 'Защита системы', automation: 'Автоматика' };
    return `<article class="device-card" data-device-id="${escape(device.id)}"><div class="device-top">${icon(type.icon)}
      <button class="switch" type="button" role="switch" aria-checked="${device.isOn}" data-device-command="${escape(device.id)}"
      aria-label="${type.name}: ${device.isOn ? 'выключить' : 'включить'}" aria-describedby="reason-${escape(device.id)}"${disabled ? ' disabled' : ''}></button></div>
      <h3>${type.name}</h3><p>${type.description}</p>${badge(reason ? 'BLOCKED · блокировка' : device.isOn ? 'ON · включено' : 'OFF · выключено', reason ? 'yellow' : device.isOn ? 'green' : '')}
      <dl class="device-meta"><div><dt>Источник:</dt><dd>${sources[device.source]}</dd></div>
      <div><dt>Изменено:</dt><dd><time datetime="${escape(device.changedAt)}">${time(device.changedAt)}</time></dd></div></dl>
      <p class="helper" id="reason-${escape(device.id)}">${escape(reason ?? decisions[device.type]?.reason ?? 'Manual · учебная модель')}${automatic ? ' Ручное переключение недоступно в Auto.' : ''}</p></article>`;
  }).join('');
}

function deviceSummary(state) {
  return DEVICE_TYPES.map((type) => {
    const devices = state.devices.filter((device) => device.type === type.type);
    const blocked = devices.filter((device) => device.blockedReason).length;
    return `<div class="device-row">${icon(type.icon)}<strong>${type.name}</strong><span>
      ${devices.filter((device) => device.isOn).length} / ${devices.length} ON${blocked ? ` · ${blocked} BLOCKED` : ''}</span></div>`;
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
  const feedback = documentRoot.querySelector('[data-control-feedback]');
  let selectedZone = initial.zones[0].id;
  const report = (result) => {
    if (feedback) {
      feedback.textContent = result.message;
      feedback.dataset.outcome = result.ok ? 'success' : 'error';
    }
  };
  const deviceContainer = documentRoot.querySelector('[data-device-cards]');
  deviceContainer?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-device-command]');
    if (!button || !deviceContainer.contains(button)) return;
    const device = store.getState().devices.find((item) => item.id === button.dataset.deviceCommand);
    if (device) report(store.setDeviceState(device.id, !device.isOn));
  });
  const modePicker = documentRoot.querySelector('[data-zone-mode]');
  modePicker?.addEventListener('change', () => report(store.setZoneMode(selectedZone, modePicker.value)));
  const scenarioPicker = documentRoot.querySelector('[data-scenario-select]');
  if (scenarioPicker) scenarioPicker.innerHTML = SCENARIOS.map((scenario) => `<option value="${scenario.id}">${scenario.name}</option>`).join('');
  documentRoot.querySelector('[data-apply-scenario]')?.addEventListener('click', () => report(store.applyScenario(selectedZone, scenarioPicker.value)));
  documentRoot.querySelector('[data-restore-scenario]')?.addEventListener('click', () => report(store.applyScenario(selectedZone, 'restore')));
  if (picker) {
    picker.innerHTML = initial.zones.map((zone) => `<option value="${escape(zone.id)}">${escape(zone.name)} · ${escape(zone.id)}</option>`).join('');
    picker.addEventListener('change', () => {
      selectedZone = picker.value;
      if (feedback) { feedback.textContent = 'Выбрана другая зона. Измерения и состояния устройств берутся из общей модели.'; delete feedback.dataset.outcome; }
      render();
    });
  }
  const settingsForm = bindSettingsForm(store, documentRoot);
  const monitoring = bindMonitoringViews(store, documentRoot);
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
    const status = store.getStatus();
    storageNotice.textContent = `${storageMessage(state, status)}${status.safetyMessage ? ` Защита: ${status.safetyMessage}` : ''}`;
    const indicator = documentRoot.querySelector('[data-mode-indicator]');
    if (indicator) indicator.textContent = modeLabel(state);
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
      fill('[data-recent-events]', recentEvents(state));
    } else if (page === 'zones') {
      fill('[data-zone-cards]', zoneCards(state, true));
      fill('[data-sensor-rows]', sensorRows(state, selectedZone));
    } else if (page === 'sensors') {
      fill('[data-sensor-rows]', sensorRows(state));
    } else if (page === 'control') {
      const focusedDevice = documentRoot.activeElement?.dataset?.deviceCommand;
      fill('[data-device-cards]', deviceCards(state, selectedZone));
      if (focusedDevice) {
        const replacement = documentRoot.querySelector(`[data-device-command="${focusedDevice}"]`);
        if (replacement && !replacement.disabled) replacement.focus();
        else picker.focus();
      }
      const zone = state.zones.find((item) => item.id === selectedZone);
      modePicker.value = zone.mode;
      documentRoot.querySelector('[data-zone-mode-summary]').textContent = `${zone.name}: ${zone.mode === 'auto' ? 'Auto — правила применяются по порогам, ручные команды заблокированы.' : 'Manual — устройствами управляет оператор.'}`;
    } else if (page === 'settings') {
      settingsForm.render(selectedZone);
    } else if (page === 'alerts' || page === 'event-log') {
      monitoring.render();
    }
  }
  render();
  return store.subscribe(render);
}
