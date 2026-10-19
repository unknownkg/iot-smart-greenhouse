// Общие настройки используют существующее хранилище состояния и симулятор без отдельного контроллера или таймера.
export const RESET_WARNING = 'Сбросить демонстрационные данные IoT Smart Greenhouse? Будут сброшены датчики, настройки, устройства, сценарии, предупреждения, журнал событий и история измерений. Несохранённые правки порогов будут удалены. Данные других приложений не затрагиваются. Это действие нельзя отменить.';

export function createApplicationSettings(store, simulator, { confirmReset } = {}) {
  return Object.freeze({
    setInterval(interval) {
      const result = store.setSimulationIntervalMs(interval);
      return { ...result, message: !result.ok ? 'Интервал не изменён. Допустимо от 3 до 10 секунд.'
        : result.persisted ? `Интервал ${interval / 1000} с сохранён. Пауза и показания не изменены.`
          : `Интервал ${interval / 1000} с применён только в памяти; сохранить не удалось.` };
    },
    reset() {
      let confirmed;
      try { confirmed = confirmReset(RESET_WARNING); }
      catch { return { ok: false, applied: false, message: 'Подтверждение недоступно. Данные не изменены.' }; }
      if (confirmed !== true) return { ok: false, applied: false, cancelled: true, message: 'Сброс отменён. Данные не изменены.' };
      simulator?.stop();
      try {
        const result = store.reset();
        return { ...result, message: !result.applied ? 'Сброс не выполнен: хранилище не разрешило удаление. Прежние данные сохранены.'
          : result.persisted ? 'Демонстрационные данные сброшены и сохранены. Восстановлены начальные настройки и выключенные устройства.'
            : 'Начальная модель показана только в памяти. Сохранение не удалось; состояние после F5 не гарантируется. Проверьте предупреждение хранилища.' };
      } finally { simulator?.start(); }
    },
  });
}

export function bindApplicationSettings(store, root, simulator, { onReset = () => {} } = {}) {
  const interval = root.querySelector('[data-simulation-interval]');
  if (!interval) return null;
  const reset = root.querySelector('[data-reset-demo]');
  const feedback = root.querySelector('[data-application-settings-feedback]');
  const currentInterval = root.querySelector('[data-current-interval]');
  const settings = createApplicationSettings(store, simulator, { confirmReset: (message) => root.defaultView.confirm(message) });
  const show = (result) => {
    feedback.textContent = result.message;
    feedback.dataset.outcome = result.cancelled ? '' : result.ok ? 'success' : 'error';
  };
  const render = () => {
    const value = store.getState().settings.simulationIntervalMs;
    if (currentInterval) {
      const custom = value % 1000 !== 0;
      currentInterval.hidden = !custom;
      currentInterval.value = custom ? String(value) : '';
      currentInterval.textContent = custom ? `${value / 1000} с — сохранённое значение` : '';
    }
    interval.value = String(value);
  };
  interval.addEventListener('change', () => { show(settings.setInterval(Number(interval.value))); render(); });
  reset.addEventListener('click', () => {
    const result = settings.reset();
    if (result.applied) onReset();
    render(); show(result);
  });
  return { render };
}
