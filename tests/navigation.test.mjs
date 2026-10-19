import test from 'node:test';
import assert from 'node:assert/strict';
import { initNavigation } from '../assets/js/ui.js';

// Подменяются только события document/window и фокус; используется настоящий контроллер навигации.
function fixture(desktopInitially = true) {
  const eventTarget = (extra = {}) => ({ ...extra, listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    emit(type, event = {}) {
      const previous = globalThis.document; globalThis.document = doc;
      try { this.listeners.get(type)?.(event); } finally { globalThis.document = previous; }
    } });
  const classes = new Set();
  const doc = eventTarget({ activeElement: null, body: { classList: {
    contains: (name) => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
  } } });
  const focusable = () => ({ focus() { doc.activeElement = this; } });
  const links = [focusable(), focusable(), focusable()];
  const sidebar = { inert: false, contains: (node) => links.includes(node),
    querySelector: () => links[1], querySelectorAll: () => links };
  const toggle = eventTarget({ ...focusable(), attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const backdrop = eventTarget(); const desktop = eventTarget({ matches: desktopInitially });
  doc.querySelector = (selector) => ({ '#sidebar': sidebar, '[data-menu-toggle]': toggle, '[data-menu-backdrop]': backdrop })[selector];
  const oldDocument = globalThis.document; const oldWindow = globalThis.window;
  globalThis.document = doc; globalThis.window = { matchMedia: () => desktop };
  try { initNavigation(); } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
  return { doc, sidebar, toggle, backdrop, desktop, links,
    key(event) {
      const old = globalThis.document; globalThis.document = doc;
      try { doc.emit('keydown', event); } finally { globalThis.document = old; }
    },
    resize(matches) { desktop.matches = matches; desktop.emit('change'); } };
}

test('switching to mobile returns focus from the newly inert sidebar to the menu button', () => {
  const f = fixture(); f.links[1].focus(); f.resize(false);
  assert.equal(f.sidebar.inert, true);
  assert.equal(f.doc.activeElement, f.toggle);
  assert.equal(f.toggle.attributes['aria-expanded'], 'false');
});

test('mobile navigation supports open, Tab wrapping, Escape and backdrop without moving unrelated focus', () => {
  const f = fixture(false);
  assert.equal(f.sidebar.inert, true);
  f.toggle.emit('click'); assert.equal(f.sidebar.inert, false);
  assert.equal(f.doc.activeElement, f.links[1]);
  let prevented = 0;
  f.links.at(-1).focus(); f.key({ key: 'Tab', preventDefault() { prevented++; } });
  assert.equal(f.doc.activeElement, f.links[0]);
  f.key({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(f.doc.activeElement, f.links.at(-1)); assert.equal(prevented, 2);
  f.key({ key: 'Escape' }); assert.equal(f.doc.activeElement, f.toggle); assert.equal(f.sidebar.inert, true);
  f.toggle.emit('click'); f.backdrop.emit('click'); assert.equal(f.doc.activeElement, f.toggle);
  const other = {}; f.doc.activeElement = other; f.resize(true); f.resize(false);
  assert.equal(f.doc.activeElement, other);
});
