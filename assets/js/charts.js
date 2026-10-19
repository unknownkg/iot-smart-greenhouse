import { zoneLabel } from './presentation.js';
import { historyValue } from './analytics.js';
import { sensorBlockReason } from './safety.js';

export const CHART_VERSION = '4.5.1';
export const CHART_SERIES = Object.freeze([
  { key: 'temperature', title: 'Температура', unit: '°C', color: '#f2b16c' },
  { key: 'humidity', title: 'Влажность воздуха', unit: '%', color: '#79cde4' },
  { key: 'soil', title: 'Влажность почвы', unit: '%', color: '#5edf8b' },
  { key: 'co2', title: 'CO₂', unit: 'ppm', color: '#c4a2ec' },
]);
const timestampLabel = (value) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : 'Нет времени';

export function buildChartData(state, zoneId) {
  const result = Object.fromEntries(CHART_SERIES.map(({ key }) => {
    const sensor = state.sensors.find((s) => s.zoneId === zoneId && s.type === key);
    return [key, { labels: state.history.map((sample) => sample?.timestamp ?? ''), values: state.history.map((sample) => historyValue(sample, sensor)) }];
  }));
  result.water = { labels: state.zones.map((zone) => zone.name), values: state.zones.map((zone) => {
    if (sensorBlockReason(state, zone.id, 'waterLevel')) return null;
    return state.sensors.find((s) => s.zoneId === zone.id && s.type === 'waterLevel').value;
  }) };
  return result;
}

export function chartConfigurations(state, zoneId) {
  const data = buildChartData(state, zoneId);
  const zone = state.zones.find((item) => item.id === zoneId);
  return [...CHART_SERIES, { key: 'water', title: 'Текущая вода по зонам', unit: '%', color: ['#5edf8b', '#79cde4', '#c4a2ec'] }].map((series) => {
    const bar = series.key === 'water';
    return { key: series.key, type: bar ? 'bar' : 'line', data: { labels: bar ? data.water.labels.map(zoneLabel) : [...data[series.key].labels], datasets: [{
      label: `${bar ? 'Текущая модель' : zoneLabel(zone?.name ?? zoneId)} · ${series.title}, ${series.unit}`,
      data: [...data[series.key].values], borderColor: series.color, backgroundColor: series.color,
      borderWidth: 2, pointRadius: data[series.key].values.length <= 1 ? 3 : 1, pointHoverRadius: 4,
      tension: 0, spanGaps: false,
    }] }, options: { responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { labels: { color: '#dce2ec', font: { size: 12, family: 'Segoe UI, sans-serif' }, boxWidth: 12 } },
        tooltip: { callbacks: { title(items) { return bar ? items[0]?.label ?? '' : timestampLabel(items[0]?.label); } } } },
      scales: {
        x: { type: 'category', title: { display: true, text: bar ? 'Зона' : 'Время измерения · местное', color: '#96a2b4' },
          grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#96a2b4', maxTicksLimit: bar ? 3 : 5, maxRotation: 0,
            // Chart.js пересчитывает autoSkip при изменении размера; пропускаются только подписи, а не измерения.
            ...(bar ? {} : { autoSkip: true, autoSkipPadding: 48 }),
            callback(value) { const label = this.getLabelForValue(value); return bar ? label : timestampLabel(label).split(' ').at(-1); } } },
        y: { title: { display: true, text: series.unit, color: '#96a2b4' }, grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { color: '#96a2b4' }, ...(series.unit === '%' ? { min: 0, max: 100 } : {}) },
      },
    } };
  });
}

const libraryLoads = new WeakMap();
export function loadChart(documentRoot = document) {
  if (libraryLoads.has(documentRoot)) return libraryLoads.get(documentRoot);
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      const Chart = documentRoot.defaultView?.Chart;
      if (Chart?.version === CHART_VERSION) resolve(Chart);
      else reject(new Error('Pinned Chart.js is unavailable'));
    };
    if (documentRoot.defaultView?.Chart) { check(); return; }
    const script = documentRoot.createElement('script');
    script.src = new URL('../vendor/chartjs/chart.umd.min.js', import.meta.url).href;
    script.onload = check;
    script.onerror = () => reject(new Error('Local Chart.js could not be loaded'));
    documentRoot.head.append(script);
  });
  libraryLoads.set(documentRoot, ready);
  return ready;
}

// Экземплярами графиков управляет только этот адаптер; единственный источник истории — хранилище состояния.
export function createCharts(root, { load = () => loadChart(root.ownerDocument ?? root), onStatus = () => {} } = {}) {
  const instances = new Map(); let revision = 0;
  function release() {
    for (const chart of instances.values()) { try { chart.destroy(); } catch { /* Остальные экземпляры графиков также нужно освободить. */ } }
    instances.clear();
  }
  return Object.freeze({
    async render(state, zoneId) {
      const current = ++revision;
      const configs = chartConfigurations(state, zoneId);
      for (const config of configs) {
        const summary = root.querySelector(`[data-chart-summary="${config.key}"]`);
        const values = config.data.datasets[0].data.filter((value) => value !== null);
        if (summary) summary.textContent = config.key === 'water' ? `Достоверных значений: ${values.length} / ${state.zones.length}. ${config.data.labels.map((label, i) => `${label}: ${config.data.datasets[0].data[i] === null ? 'нет достоверного показания' : `${config.data.datasets[0].data[i]} %`}`).join('; ')}. Текущая модель, не история.`
          : `Срезов: ${state.history.length}; достоверных точек: ${values.length}; пропусков: ${state.history.length - values.length}.${values.length ? ` Мин: ${Math.min(...values)}, макс: ${Math.max(...values)} ${config.options.scales.y.title.text}.` : ' История пуста или нет достоверных измерений.'}`;
      }
      onStatus('loading', 'Загрузка локального Chart.js…');
      try {
        const Chart = await load();
        if (current !== revision) return;
        if (Chart?.version !== CHART_VERSION || typeof Chart !== 'function') throw new Error('Unexpected chart version');
        for (const { key, ...config } of configs) {
          const chart = instances.get(key);
          if (chart) { chart.data = config.data; chart.options = config.options; chart.update('none'); }
          else {
            const canvas = root.querySelector(`[data-chart="${key}"]`);
            if (!canvas) throw new Error('Chart canvas not found');
            let created;
            try { created = new Chart(canvas, config); }
            catch (error) {
              // Ошибка инициализации может возникнуть после регистрации canvas в Chart.js.
              const partial = Chart.getChart?.(canvas);
              if (partial) instances.set(key, partial);
              throw error;
            }
            instances.set(key, created);
            // Если у canvas нет контекста, Chart.js может вернуть нерабочий экземпляр без исключения.
            if (created.ctx === null || created.canvas === null) throw new Error('Canvas context unavailable');
          }
        }
        onStatus(state.history.length ? 'ready' : 'empty', state.history.length
          ? `Chart.js ${CHART_VERSION}: сохранённая история и текущая вода. Пропуски не соединяются.`
          : `История пуста: четыре графика ожидают измерения. Вода показана из текущей модели. Chart.js ${CHART_VERSION}.`);
      } catch {
        if (current !== revision) return;
        release();
        onStatus('error', 'Графики недоступны: проверьте локальный файл Chart.js и поддержку canvas. Расчёты риска, рекомендации и управление продолжают работать.');
      }
    },
    destroy() { revision++; release(); },
  });
}
