import { SENSOR_TYPES } from './data.js';

// Natural drift only. Future actuator influence belongs here, using state.devices;
// the store remains the sole owner of readings, timestamps and history.
const STEPS = Object.freeze({ temperature: 0.2, humidity: 0.5, soil: 0.2, light: 200, co2: 8 });
export function simulateReadings(state, { random = Math.random } = {}) {
  return state.sensors.filter((sensor) => sensor.status === 'online').map((sensor) => {
    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw > 1) throw new RangeError('Invalid random sample');
    const type = SENSOR_TYPES.find((item) => item.type === sensor.type);
    const delta = sensor.type === 'waterLevel' ? -(0.02 + draw * 0.06) : (draw * 2 - 1) * STEPS[sensor.type];
    const decimals = sensor.type === 'waterLevel' ? 2 : ['light', 'co2'].includes(sensor.type) ? 0 : 1;
    const value = Math.min(type.max, Math.max(type.min, sensor.value + delta));
    return { id: sensor.id, value: +value.toFixed(decimals) };
  });
}

const controllers = new WeakMap();
export function createSimulator(store, {
  random = Math.random,
  now = () => new Date().toISOString(),
  setInterval = globalThis.setInterval.bind(globalThis),
  clearInterval = globalThis.clearInterval.bind(globalThis),
} = {}) {
  if (controllers.has(store)) return controllers.get(store);
  let timer = null;
  let delay = null;
  let started = false;
  let disposed = false;

  function tick() {
    try {
      return store.recordMeasurements(simulateReadings(store.getState(), { random }), now());
    } catch {
      return { ok: false, issue: 'simulation-failed' };
    }
  }
  function clear() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    delay = null;
  }
  function reconcile() {
    const state = store.getState();
    if (!started || disposed || state.simulation.paused) { clear(); return; }
    if (timer !== null && delay === state.settings.simulationIntervalMs) return;
    clear();
    delay = state.settings.simulationIntervalMs;
    timer = setInterval(() => {
      if (started && !disposed && !store.getState().simulation.paused) tick();
    }, delay);
  }
  const unsubscribe = store.subscribe(reconcile);
  const controller = Object.freeze({
    start() { if (!disposed) { started = true; reconcile(); } },
    stop() { started = false; clear(); },
    pause() { return store.setSimulationPaused(true); },
    resume() {
      if (disposed) return { ok: false, issue: 'disposed' };
      started = true;
      const result = store.setSimulationPaused(false);
      reconcile();
      return result;
    },
    step() {
      if (disposed || !store.getState().simulation.paused) return { ok: false, issue: 'not-paused' };
      return tick();
    },
    dispose() { disposed = true; started = false; clear(); unsubscribe(); controllers.delete(store); },
  });
  controllers.set(store, controller);
  return controller;
}
