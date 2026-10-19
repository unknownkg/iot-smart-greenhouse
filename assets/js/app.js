import { initNavigation } from './ui.js';
import { createStore } from './store.js';
import { renderDataPage } from './views.js';

// Stage 2: one persisted demo snapshot; no simulator, timers or device commands.
initNavigation();
const store = createStore();
renderDataPage(store);
