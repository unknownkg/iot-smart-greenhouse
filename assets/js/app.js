import { initNavigation } from './ui.js';
import { createStore } from './store.js';
import { renderDataPage } from './views.js';
import { createSimulator } from './simulator.js';

// Stage 7: analytics only reads snapshots; the existing simulator remains the only timer.
initNavigation();
const store = createStore();
const simulator = createSimulator(store);
const rendering = renderDataPage(store, document, simulator);
simulator.start();
// Suspend before leaving, and restart safely if restored from the back/forward cache.
window.addEventListener('pagehide', () => { simulator.stop(); rendering.suspend(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    simulator.stop();
    store.reload();
  }
  simulator.start();
});
