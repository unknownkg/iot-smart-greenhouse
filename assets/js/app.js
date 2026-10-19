import { initNavigation } from './ui.js';
import { createStore } from './store.js';
import { renderDataPage } from './views.js';
import { createSimulator } from './simulator.js';

// Аналитика только читает снимки состояния; измерениями управляет единственный таймер симулятора.
initNavigation();
const store = createStore();
const simulator = createSimulator(store);
const rendering = renderDataPage(store, document, simulator);
simulator.start();
// При уходе приостанавливаем работу; при возврате из кэша переходов безопасно возобновляем её.
window.addEventListener('pagehide', () => { simulator.stop(); rendering.suspend(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    simulator.stop();
    store.reload();
  }
  simulator.start();
});
