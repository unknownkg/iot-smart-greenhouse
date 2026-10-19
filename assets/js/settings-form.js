import { displayText } from './presentation.js';
import { SENSOR_TYPES } from './data.js';

export const THRESHOLD_FIELDS = Object.freeze(SENSOR_TYPES.flatMap((type) =>
  (['temperature', 'humidity', 'soil'].includes(type.type) ? ['min', 'max'] : [type.type === 'waterLevel' ? 'critical' : type.type === 'co2' ? 'max' : 'min'])
    .map((key) => Object.freeze({ path: `${type.type}.${key}`, type: type.type, key, min: type.min, max: type.max, name: type.name, unit: type.unit }))));

// Черновики принадлежат интерфейсу; действующие пороги берутся из общего хранилища состояния.
export function createSettingsEditor(store) {
  const drafts = new Map();
  const fromStore = (zoneId) => {
    const settings = store.getState().settings.zones[zoneId];
    return Object.fromEntries(THRESHOLD_FIELDS.map((field) => [field.path, String(settings[field.type][field.key])]));
  };
  return Object.freeze({
    values(zoneId) { return { ...(drafts.get(zoneId) ?? fromStore(zoneId)) }; },
    dirty(zoneId) { return drafts.has(zoneId); },
    setValue(zoneId, path, text) {
      if (!THRESHOLD_FIELDS.some((field) => field.path === path)) return;
      drafts.set(zoneId, { ...(drafts.get(zoneId) ?? fromStore(zoneId)), [path]: text });
    },
    discard(zoneId) { drafts.delete(zoneId); },
    clear() { drafts.clear(); },
    save(zoneId) {
      const values = drafts.get(zoneId) ?? fromStore(zoneId);
      const settings = store.getState().settings.zones[zoneId];
      const errors = {};
      for (const field of THRESHOLD_FIELDS) {
        const text = String(values[field.path]).trim();
        const value = text === '' ? NaN : Number(text);
        if (!Number.isFinite(value) || value < field.min || value > field.max) {
          errors[field.path] = `${field.name}: введите число от ${field.min} до ${field.max} ${field.unit}.`;
        } else settings[field.type][field.key] = value;
      }
      for (const type of ['temperature', 'humidity', 'soil']) {
        if (!errors[`${type}.min`] && !errors[`${type}.max`] && settings[type].min >= settings[type].max) {
          errors[`${type}.min`] = errors[`${type}.max`] = 'Минимум должен быть строго меньше максимума.';
        }
      }
      if (Object.keys(errors).length) return { ok: false, errors, message: 'Настройки не применены. Исправьте отмеченные поля.' };
      const result = store.updateZoneSettings(zoneId, settings);
      if (result.ok) drafts.delete(zoneId);
      return { ...result, errors: {}, message: result.ok
        ? `Настройки зоны сохранены${result.persisted ? ' в localStorage.' : ' только в памяти; запись в localStorage не удалась.'} Auto пересчитан по текущим измерениям.`
        : 'Настройки не применены: некорректная модель порогов.' };
    },
  });
}

export function bindSettingsForm(store, root) {
  const form = root.querySelector('[data-settings-form]');
  if (!form) return null;
  const editor = createSettingsEditor(store);
  const feedback = root.querySelector('[data-settings-feedback]');
  const fields = [...form.querySelectorAll('[data-setting]')];
  let zoneId = store.getState().zones[0].id;
  const errors = new Map();
  const show = (message, outcome = '') => {
    feedback.textContent = displayText(message);
    feedback.dataset.outcome = outcome;
  };
  for (const input of fields) {
    const field = THRESHOLD_FIELDS.find((item) => item.path === input.dataset.setting);
    input.min = String(field.min); input.max = String(field.max); input.step = 'any'; input.required = true;
    const error = root.createElement('span'); error.className = 'field-error'; error.hidden = true;
    error.id = `error-${field.type}-${field.key}`;
    input.setAttribute('aria-describedby', error.id);
    input.after(error); errors.set(field.path, error);
    input.addEventListener('input', () => {
      editor.setValue(zoneId, field.path, input.value);
      input.removeAttribute('aria-invalid'); error.hidden = true;
      show('Есть несохранённые изменения этой зоны. Тики симулятора не перезаписывают ввод.');
    });
  }
  const render = (selectedZone) => {
    const changedZone = zoneId !== selectedZone;
    zoneId = selectedZone;
    const values = editor.values(zoneId);
    for (const input of fields) {
      if (input.value !== values[input.dataset.setting]) input.value = values[input.dataset.setting];
      if (changedZone) { input.removeAttribute('aria-invalid'); errors.get(input.dataset.setting).hidden = true; }
    }
    if (changedZone) show(editor.dirty(zoneId) ? 'Восстановлен несохранённый черновик этой зоны.' : 'Загружены текущие пороги выбранной зоны.');
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = editor.save(zoneId);
    for (const input of fields) {
      const message = result.errors[input.dataset.setting];
      input.setAttribute('aria-invalid', String(Boolean(message)));
      const error = errors.get(input.dataset.setting); error.textContent = message ?? ''; error.hidden = !message;
    }
    show(result.message, result.ok ? 'success' : 'error');
    if (result.ok) render(zoneId);
    else fields.find((input) => result.errors[input.dataset.setting])?.focus();
  });
  form.querySelector('[data-discard-settings]').addEventListener('click', () => {
    editor.discard(zoneId);
    for (const input of fields) { input.removeAttribute('aria-invalid'); errors.get(input.dataset.setting).hidden = true; }
    render(zoneId); show('Черновик отменён. Показаны действующие пороги.');
  });
  return { render, reset() {
    editor.clear();
    for (const input of fields) { input.removeAttribute('aria-invalid'); errors.get(input.dataset.setting).hidden = true; }
    render(zoneId); show('Демонстрационные данные сброшены; показаны начальные пороги.');
  } };
}
