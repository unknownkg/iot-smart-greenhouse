import { displayText, zoneLabel, eventLabel } from './presentation.js';
import { EVENT_SOURCES } from './events.js';
import { SENSOR_TYPES, DEVICE_TYPES } from './data.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (value) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
const number = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
const sourceName = { operator: 'Оператор', auto: 'Автоматика', safety: 'Защита', scenario: 'Сценарий', settings: 'Настройки', system: 'Система' };
const badge = (label, color) => `<span class="badge badge-${color}">${escape(label)}</span>`;
const newest = (a, b) => b.timestamp.localeCompare(a.timestamp) || Number(b.id.split('-')[1]) - Number(a.id.split('-')[1]);
const zoneName = (state, id) => zoneLabel(state.zones.find((zone) => zone.id === id)?.name ?? 'Система');

export function filterAlerts(state, { zoneId = '', severity = '', status = '' } = {}) {
  return state.alerts.filter((a) => (!zoneId || a.zoneId === zoneId) && (!severity || a.severity === severity) && (!status || a.status === status))
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
      || Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.createdAt.localeCompare(a.createdAt)
      || Number(b.id.slice(6)) - Number(a.id.slice(6)));
}

export function filterEvents(state, { zoneId = '', source = '' } = {}) {
  return state.events.filter((e) => (!zoneId || e.zoneId === zoneId) && (!source || e.source === source)).sort(newest);
}

export function alertRows(state, filters = {}) {
  const alerts = filterAlerts(state, filters);
  if (!alerts.length) return '<tr><td class="table-empty" colspan="6">Нет предупреждений по выбранным фильтрам. Устранённые записи доступны через фильтр статуса.</td></tr>';
  return alerts.map((alert) => {
    const sensor = state.sensors.find((s) => s.id === alert.sensorId);
    const device = state.devices.find((d) => d.id === alert.deviceId);
    const object = device ? DEVICE_TYPES.find((d) => d.type === device.type).name : SENSOR_TYPES.find((s) => s.type === sensor.type).name;
    return `<tr><td>${badge(alert.severity === 'critical' ? 'Критическое' : 'Предупреждение', alert.severity === 'critical' ? 'red' : 'yellow')}</td>
      <td>${escape(zoneName(state, alert.zoneId))}<br><small>${escape(object)}</small><br><small class="mono">${escape(alert.deviceId ?? alert.sensorId)}</small></td>
      <td class="audit-description"><strong>${escape(displayText(alert.message))}</strong><p>${escape(displayText(alert.reason))}</p></td>
      <td>${alert.value === null ? 'Нет достоверного' : `${number(alert.value)} ${escape(sensor.unit)}`}<br><small class="muted">Порог: ${alert.threshold === null ? '—' : `${number(alert.threshold)} ${escape(sensor.unit)}`}</small></td>
      <td>${badge(alert.status === 'open' ? 'Активно' : 'Устранено', alert.status === 'open' ? alert.severity === 'critical' ? 'red' : 'yellow' : 'green')}</td>
      <td><time datetime="${alert.createdAt}">${time(alert.createdAt)}</time><br><small class="muted">${alert.resolvedAt ? `Устранено: ${time(alert.resolvedAt)}` : 'Ожидает устранения причины'}</small></td></tr>`;
  }).join('');
}

export function eventRows(state, filters = {}, limit = 30) {
  const events = filterEvents(state, filters).slice(0, limit);
  if (!events.length) return '<tr><td class="table-empty" colspan="5">Нет событий по выбранным фильтрам. Журнал фиксирует реальные действия и переходы состояний.</td></tr>';
  return events.map((event) => `<tr><td><time datetime="${event.timestamp}">${time(event.timestamp)}</time></td>
    <td>${escape(zoneName(state, event.zoneId))}</td><td>${badge(sourceName[event.source], event.source === 'safety' ? 'red' : event.source === 'auto' ? 'green' : 'cyan')}</td>
    <td>${escape(displayText(event.objectName))}<br><small class="muted mono">${escape(eventLabel(event.type))}</small></td>
    <td class="audit-description"><strong>${escape(displayText(event.message))}</strong><p>${escape(displayText(event.reason))}</p>${event.previousState !== null || event.newState !== null ? `<small class="muted">${escape(displayText(event.previousState ?? '—'))} → ${escape(displayText(event.newState ?? '—'))}</small>` : ''}</td></tr>`).join('');
}

export function recentEvents(state, limit = 5) {
  const events = filterEvents(state).slice(0, limit);
  if (!events.length) return '<p class="helper">Событий пока нет. Здесь появятся реальные действия и изменения предупреждений.</p>';
  return `<div class="event-feed">${events.map((event) => {
    const alert = state.alerts.find((a) => a.id === event.objectId);
    const level = alert ? badge(alert.severity === 'critical' ? 'Критическое' : 'Предупреждение', alert.severity === 'critical' ? 'red' : 'yellow') : '';
    return `<article class="event-item"><div>${level}${badge(sourceName[event.source], event.source === 'safety' ? 'red' : 'cyan')}<small class="muted">${escape(zoneName(state, event.zoneId))} · ${time(event.timestamp)}</small></div><p>${escape(displayText(event.message))}</p><small class="muted">${escape(displayText(event.reason))}</small></article>`;
  }).join('')}</div>`;
}

export function recentAlerts(state, limit = 3) {
  const resolved = state.alerts.filter((a) => a.status === 'resolved')
    .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt) || Number(b.id.slice(6)) - Number(a.id.slice(6)));
  const alerts = [...filterAlerts(state, { status: 'open' }), ...resolved].slice(0, limit);
  if (!alerts.length) return '<p class="helper">Предупреждений пока нет. Здесь будут предупреждения по данным модели, отдельно от журнала событий.</p>';
  return `<div class="event-feed">${alerts.map((alert) => `<article class="event-item"><div>
    ${badge(alert.severity === 'critical' ? 'Критическое' : 'Предупреждение', alert.severity === 'critical' ? 'red' : 'yellow')}
    ${badge(alert.status === 'open' ? 'Активно' : 'Устранено', alert.status === 'open' ? 'yellow' : 'green')}
    <strong>${escape(zoneName(state, alert.zoneId))}</strong><small class="muted">${time(alert.resolvedAt ?? alert.createdAt)}</small></div>
    <p>${escape(displayText(alert.message))}</p><small class="muted">${escape(displayText(alert.reason))}</small></article>`).join('')}</div>`;
}

export function notificationModel(state) {
  const open = state.alerts.filter((alert) => alert.status === 'open');
  const critical = open.filter((alert) => alert.severity === 'critical').length;
  return { count: open.length, critical, warning: open.length - critical, level: critical ? 'critical' : open.length ? 'warning' : 'normal' };
}

export function renderNotifications(state, link) {
  if (!link) return;
  const model = notificationModel(state);
  link.className = `badge notifications-link badge-${model.critical ? 'red' : model.count ? 'yellow' : 'green'}`;
  link.textContent = `Уведомления · ${model.count}`;
  link.setAttribute('aria-label', `Активные предупреждения: ${model.count}. Критических: ${model.critical}; Предупреждений: ${model.warning}. Открыть страницу предупреждений.`);
}

export function bindMonitoringViews(store, root) {
  const alertBody = root.querySelector('[data-alert-rows]');
  const eventBody = root.querySelector('[data-event-rows]');
  if (!alertBody && !eventBody) return null;
  const zone = root.querySelector('[data-filter-zone]');
  zone.innerHTML = '<option value="">Все зоны</option>' + store.getState().zones.map((z) => `<option value="${z.id}">${escape(zoneLabel(z.name))}</option>`).join('');
  const severity = root.querySelector('[data-filter-severity]');
  const status = root.querySelector('[data-filter-status]');
  const source = root.querySelector('[data-filter-source]');
  if (source) source.innerHTML = '<option value="">Все источники</option>' + EVENT_SOURCES.map((s) => `<option value="${s}">${sourceName[s]}</option>`).join('');
  const more = root.querySelector('[data-more-events]');
  let limit = 30;
  function render() {
    const state = store.getState();
    if (alertBody) {
      const filters = { zoneId: zone.value, severity: severity.value, status: status.value };
      alertBody.innerHTML = alertRows(state, filters);
      const open = state.alerts.filter((a) => a.status === 'open');
      root.querySelector('[data-warning-count]').textContent = open.filter((a) => a.severity === 'warning').length;
      root.querySelector('[data-critical-count]').textContent = open.filter((a) => a.severity === 'critical').length;
      root.querySelector('[data-alert-count]').textContent = `По фильтрам: ${filterAlerts(state, filters).length} · В истории: ${state.alerts.length}`;
    } else {
      const filters = { zoneId: zone.value, source: source.value };
      const total = filterEvents(state, filters).length;
      eventBody.innerHTML = eventRows(state, filters, limit);
      more.hidden = total <= limit;
      root.querySelector('[data-event-count]').textContent = `Показано ${Math.min(limit, total)} из ${total} по фильтрам · В журнале: ${state.events.length}`;
    }
  }
  for (const select of [zone, severity, status, source].filter(Boolean)) select.addEventListener('change', () => { limit = 30; render(); });
  more?.addEventListener('click', () => { limit += 30; render(); });
  return { render };
}
