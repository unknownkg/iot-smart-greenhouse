import { initNavigation } from './ui.js';
import { createStore } from './store.js';
import { renderDataPage } from './views.js';
import { createSimulator } from './simulator.js';

// Stage 6: one simulator; store reconciles devices, Alerts and Event Log before publishing.
initNavigation();
const store = createStore();
const simulator = createSimulator(store);
renderDataPage(store, document, simulator);
simulator.start();
// Suspend before leaving, and restart safely if restored from the back/forward cache.
window.addEventListener('pagehide', () => simulator.stop());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    simulator.stop();
    store.reload();
  }
  simulator.start();
});
