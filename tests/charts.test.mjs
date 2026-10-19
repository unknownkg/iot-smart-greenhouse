import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createInitialState } from '../assets/js/data.js';
import { buildChartData, chartConfigurations, createCharts, loadChart } from '../assets/js/charts.js';

const FIRST = '2026-10-19T12:00:00.000Z';
function data() {
  const state = createInitialState(FIRST);
  state.history = [0, 5, 10].map((seconds) => {
    const timestamp = new Date(Date.parse(FIRST) + seconds * 1000).toISOString();
    return { timestamp, sensors: state.sensors.map((s) => ({ sensorId: s.id, value: s.value, status: 'online', lastUpdatedAt: timestamp })) };
  });
  return state;
}

test('four history series use the selected zone and original saved timestamps without fake points', () => {
  const state = data(); const before = structuredClone(state);
  const result = buildChartData(state, 'ZONE-02');
  assert.deepEqual(result.temperature.values, [25.2, 25.2, 25.2]);
  assert.deepEqual(result.temperature.labels, state.history.map((s) => s.timestamp));
  assert.deepEqual(result.co2.values, [910, 910, 910]);
  assert.deepEqual(result.water.values, [72, 68, 81]);
  assert.deepEqual(state, before);
});

test('offline, absent, duplicate and unreliable samples create gaps and are never zero-filled', () => {
  const state = data();
  state.history[0].sensors.find((s) => s.sensorId === 'ZONE-01-S-temperature').status = 'offline';
  state.history[1].sensors = state.history[1].sensors.filter((s) => s.sensorId !== 'ZONE-01-S-temperature');
  state.history[2].sensors.find((s) => s.sensorId === 'ZONE-01-S-temperature').value = NaN;
  assert.deepEqual(buildChartData(state, 'ZONE-01').temperature.values, [null, null, null]);
  state.sensors.find((s) => s.id === 'ZONE-01-S-waterLevel').status = 'offline';
  assert.equal(buildChartData(state, 'ZONE-01').water.values[0], null);
  const config = chartConfigurations(state, 'ZONE-01')[0]; assert.equal(config.data.datasets[0].spanGaps, false);
});

test('empty history stays empty, water bar satisfies teacher requirement and all axes identify units', () => {
  const state = createInitialState(FIRST); const configs = chartConfigurations(state, 'ZONE-01');
  assert.equal(configs.length, 5); assert.equal(configs.filter((c) => c.type === 'line').length, 4);
  assert.equal(configs.find((c) => c.key === 'water').type, 'bar');
  for (const config of configs) {
    assert.ok(config.options.scales.y.title.text); assert.equal(config.options.animation, false);
    if (config.type === 'line') assert.equal(config.data.datasets[0].data.length, 0);
  }
});

// Подменяется только отрисовка canvas/Chart; подготовка данных и адаптер выполняются настоящим кодом.
function boundary(loadOverride = null) {
  const nodes = new Map(); const live = new Set(); const status = [];
  const root = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, { textContent: '' }); return nodes.get(selector); } };
  class Drawing {
    static version = '4.5.1';
    constructor(canvas, config) { assert.ok(canvas); this.data = config.data; this.options = config.options; this.config = config; live.add(this); }
    update(mode) { assert.equal(mode, 'none'); }
    destroy() { live.delete(this); }
  }
  const charts = createCharts(root, { load: loadOverride ?? (() => Promise.resolve(Drawing)), onStatus: (...args) => status.push(args) });
  return { charts, live, status, Drawing, summaryWater: () => nodes.get('[data-chart-summary="water"]').textContent };
}

test('adapter reuses five instances and switches actual datasets on zone changes; teardown releases canvases', async () => {
  const b = boundary(); const state = data();
  await b.charts.render(state, 'ZONE-01'); const instances = [...b.live]; assert.equal(instances.length, 5);
  assert.match(b.summaryWater(), /Томаты: 72 %/);
  await b.charts.render(state, 'ZONE-02'); assert.deepEqual([...b.live], instances);
  assert.deepEqual(instances[0].data.datasets[0].data, [25.2, 25.2, 25.2]);
  b.charts.destroy(); assert.equal(b.live.size, 0);
  await b.charts.render(state, 'ZONE-03'); assert.equal(b.live.size, 5);
  assert.deepEqual([...b.live][0].data.datasets[0].data, [22.4, 22.4, 22.4]);
  b.charts.destroy();
});

test('late loader results cannot redraw a stale zone or resurrect destroyed charts', async () => {
  let finish; const ready = new Promise((resolve) => { finish = resolve; });
  const b = boundary(() => ready); const state = data();
  const first = b.charts.render(state, 'ZONE-01'); const second = b.charts.render(state, 'ZONE-02');
  finish(b.Drawing); await Promise.all([first, second]);
  assert.equal(b.live.size, 5); assert.deepEqual([...b.live][0].data.datasets[0].data, [25.2, 25.2, 25.2]);
  const pending = b.charts.render(state, 'ZONE-03'); b.charts.destroy(); await pending; assert.equal(b.live.size, 0);
});

test('library load, constructor and update failures are contained and clean up charts', async () => {
  const failed = boundary(() => Promise.reject(new Error('not available')));
  await assert.doesNotReject(() => failed.charts.render(data(), 'ZONE-01'));
  assert.equal(failed.live.size, 0); assert.equal(failed.status.at(-1)[0], 'error');
  class Broken { static version = '4.5.1'; constructor() { throw new Error('canvas failure'); } }
  const badCanvas = boundary(() => Promise.resolve(Broken));
  await assert.doesNotReject(() => badCanvas.charts.render(data(), 'ZONE-01')); assert.equal(badCanvas.status.at(-1)[0], 'error');
  const b = boundary(); await b.charts.render(data(), 'ZONE-01');
  [...b.live][0].update = () => { throw new Error('update failed'); };
  await assert.doesNotReject(() => b.charts.render(data(), 'ZONE-02'));
  assert.equal(b.live.size, 0); assert.equal(b.status.at(-1)[0], 'error');
});

test('loader requests the pinned local resource once and reports a missing/wrong library', async () => {
  const scripts = [];
  const doc = { defaultView: {}, createElement: () => ({}), head: { append: (script) => scripts.push(script) } };
  const first = loadChart(doc); const second = loadChart(doc);
  assert.equal(scripts.length, 1); assert.match(scripts[0].src, /assets\/vendor\/chartjs\/chart\.umd\.min\.js$/);
  doc.defaultView.Chart = { version: '4.5.1' }; scripts[0].onload();
  assert.equal(await first, await second);
  const bad = { defaultView: {}, createElement: () => ({}), head: { append: (script) => { queueMicrotask(() => script.onerror()); } } };
  await assert.rejects(loadChart(bad));
});

test('a Chart instance without a usable canvas context is released and reported unavailable', async () => {
  let destroyed = 0;
  class NoContext {
    static version = '4.5.1';
    constructor() { this.canvas = null; this.ctx = null; }
    destroy() { destroyed++; }
  }
  const b = boundary(() => Promise.resolve(NoContext));
  await assert.doesNotReject(() => b.charts.render(data(), 'ZONE-01'));
  assert.equal(b.status.at(-1)[0], 'error');
  assert.equal(destroyed, 1);
});

test('a constructor that registers its canvas before throwing cannot leak a Chart instance', async () => {
  const registered = new Map();
  let destroyed = 0;
  class Partial {
    static version = '4.5.1';
    static getChart(canvas) { return registered.get(canvas); }
    constructor(canvas) { this.canvas = canvas; registered.set(canvas, this); throw new Error('initialization failed after registration'); }
    destroy() { registered.delete(this.canvas); destroyed++; }
  }
  const b = boundary(() => Promise.resolve(Partial));
  for (const zone of ['ZONE-01', 'ZONE-02']) {
    await assert.doesNotReject(() => b.charts.render(data(), zone));
    assert.equal(b.status.at(-1)[0], 'error');
    assert.equal(registered.size, 0);
  }
  assert.equal(destroyed, 2);
});

test('vendored official UMD actually loads version4.5.1 and matches recorded hash and license', () => {
  const bytes = readFileSync(new URL('../assets/vendor/chartjs/chart.umd.min.js', import.meta.url));
  const provenance = JSON.parse(readFileSync(new URL('../assets/vendor/chartjs/SOURCE.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.bundleSha256);
  const scope = {}; vm.runInNewContext(bytes.toString(), scope);
  assert.equal(scope.Chart.version, '4.5.1');
  const license = readFileSync(new URL('../assets/vendor/chartjs/LICENSE.md', import.meta.url), 'utf8');
  assert.match(license, /MIT License/); assert.match(license, /Copyright/);
});

test('history time labels keep readable spacing when the actual Chart.js layout becomes narrow', () => {
  const scope = {};
  vm.runInNewContext(readFileSync(new URL('../assets/vendor/chartjs/chart.umd.min.js', import.meta.url), 'utf8'), scope);
  const state = data();
  state.history = Array.from({ length: 240 }, (_, index) => ({
    ...state.history[0], timestamp: new Date(Date.parse(FIRST) + index * 5000).toISOString(),
  }));
  const before = structuredClone(state);
  // Подменяются только отрисовка canvas и метрики шрифта; раскладку и autoSkip выполняет закреплённая UMD-версия.
  for (const width of [298, 305, 467, 743]) {
    for (const config of chartConfigurations(state, 'ZONE-01').filter((item) => item.type === 'line')) {
      const canvas = { width, height: 260 };
      const measureText = (text) => ({ width: String(text).length * 6.5 });
      const context = new Proxy({ canvas, measureText, getLineDash: () => [] }, {
        get(target, key) { return key in target ? target[key] : () => {}; },
      });
      canvas.getContext = () => context;
      const chart = new scope.Chart(canvas, { ...config, options: { ...config.options, responsive: false } });
      try {
        const axis = chart.scales.x;
        assert.ok(axis.ticks.length >= 2, `${config.key}, ${width}px: time axis must remain useful`);
        for (let i = 1; i < axis.ticks.length; i++) {
          const gap = axis.getPixelForTick(i) - axis.getPixelForTick(i - 1)
            - (measureText(axis.ticks[i].label).width + measureText(axis.ticks[i - 1].label).width) / 2;
          assert.ok(gap >= 16, `${config.key}, ${width}px: adjacent time labels only ${gap.toFixed(1)}px apart`);
        }
        assert.equal(chart.data.datasets[0].data.length, 240, 'skip labels, never measurements');
      } finally { chart.destroy(); }
    }
  }
  assert.deepEqual(state, before);
});
