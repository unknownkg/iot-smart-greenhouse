import { analyzeZone, RISK_LEVELS } from './analytics.js';
import { SENSOR_TYPES, HISTORY_LIMIT } from './data.js';
import { createCharts } from './charts.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (value) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
const priority = (value) => value === 'critical' ? 'Critical' : value === 'warning' ? 'Warning' : 'Info';
const conditions = Object.freeze({ 'temperature-high': 'Перегрев', 'temperature-low': 'Низкая температура',
  'humidity-low': 'Низкая влажность воздуха', 'humidity-high': 'Высокая влажность воздуха',
  'soil-low': 'Сухая почва', 'soil-high': 'Высокая влажность почвы', 'light-low': 'Недостаток света',
  'co2-high': 'Высокий CO₂', 'water-critical': 'Критический запас воды', unavailable: 'Недостоверные измерения',
  'sensor-unavailable': 'Недоступный датчик', 'pump-blocked': 'Насос заблокирован защитой',
  'historical-change': 'Скачок в истории', 'untrusted-model': 'Модель не восстановлена' });

export function riskCard(result) {
  return `<div data-risk-level="${escape(result.level)}"><div class="risk-placeholder"><div class="risk-ring mono">${result.score ?? '—'}</div>
    <div><h3>${escape(RISK_LEVELS[result.level])}</h3><p>${escape(result.zoneName ?? result.zoneId)} · ${result.score === null ? 'Числовая оценка недоступна' : `${result.score} / 100`}</p>
    <p class="helper">Достоверные входы: ${result.validInputs} / 6.${result.complete ? '' : ' Неполные данные: низкое число не подтверждает безопасность.'}</p></div></div>
    ${result.factors.length ? `<ul class="analytics-list">${result.factors.map((factor) => `<li><strong>${escape(SENSOR_TYPES.find((type) => type.type === factor.sensorType)?.name ?? factor.sensorType)} · +${factor.weight}</strong><p>${escape(factor.evidence.join(' '))}</p><small class="muted">Источники: ${factor.sources.includes('sensor') ? 'показание' : ''}${factor.sources.includes('quality') ? ' достоверность' : ''}${factor.sources.includes('alert') ? ' Alerts' : ''}; один физический фактор учитывается один раз.</small></li>`).join('')}</ul>`
      : `<p class="helper">${result.complete ? 'Текущие пороги не нарушены. Исторические аномалии оцениваются отдельно.' : 'Для оценки требуются достоверные данные.'}</p>`}
    <p class="helper">Учебная эвристическая модель 0–100. Классификация Critical также применяется при критическом условии, без дополнительных баллов. Не сертифицированная агрономическая оценка.</p></div>`;
}

export function recommendationsMarkup(result) {
  if (!result.recommendations.length) return '<p class="helper">По доступным текущим факторам специальных действий не предложено. Продолжайте наблюдение; оценка не гарантирует физических результатов.</p>';
  return `<ol class="analytics-list">${result.recommendations.map((item) => `<li><span class="badge badge-${item.priority === 'critical' ? 'red' : item.priority === 'warning' ? 'yellow' : 'cyan'}">${priority(item.priority)}</span>
    <strong>${escape(item.zoneName)} · ${escape(conditions[item.condition] ?? item.condition)}</strong><p>${escape(item.evidence)}</p><p>${escape(item.action)}</p></li>`).join('')}</ol>`;
}

export function anomaliesMarkup(result) {
  const insufficient = result.historyStatus === 'insufficient' ? '<p class="notice">Недостаточно данных для сравнения соседних измерений. Текущие отклонения показаны независимо от истории.</p>' : '';
  return insufficient + (result.anomalies.length ? `<ul class="analytics-list">${result.anomalies.map((item) => `<li><strong>${escape(item.description)}</strong><p>${escape(item.evidence)}</p></li>`).join('')}</ul>`
    : '<p class="helper">В доступных данных аналитические отклонения не обнаружены. Это не подтверждение полной безопасности.</p>');
}

export function bindAnalytics(store, root) {
  const risk = root.querySelector('[data-risk-card]');
  if (!risk) return null;
  const status = root.querySelector('[data-chart-status]');
  const charts = createCharts(root, { onStatus(kind, message) {
    if (status.textContent !== message) status.textContent = message;
    status.dataset.state = kind;
  } });
  return {
    render(zoneId) {
      const state = store.getState(); const result = analyzeZone(state, zoneId, store.getStatus());
      risk.innerHTML = riskCard(result);
      root.querySelector('[data-analytics-anomalies]').innerHTML = anomaliesMarkup(result);
      root.querySelector('[data-analytics-recommendations]').innerHTML = recommendationsMarkup(result);
      root.querySelector('[data-analytics-meta]').textContent = `${result.zoneName} · История: ${result.historySamples} / ${HISTORY_LIMIT} срезов · Последнее достоверное показание: ${result.lastMeasurementAt ? time(result.lastMeasurementAt) : 'нет'} · ${state.simulation.paused ? 'Симуляция на паузе' : 'Симуляция работает'}`;
      void charts.render(state, zoneId);
    },
    suspend() { charts.destroy(); },
  };
}
