// Only presentation and navigation live here. Domain modules join in later stages.
export function initNavigation() {
  const sidebar = document.querySelector('#sidebar');
  const toggle = document.querySelector('[data-menu-toggle]');
  const backdrop = document.querySelector('[data-menu-backdrop]');
  if (!sidebar || !toggle || !backdrop) return;

  const desktop = window.matchMedia('(min-width: 1001px)');
  const isOpen = () => document.body.classList.contains('sidebar-open');

  function setOpen(open, restoreFocus = false) {
    document.body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    sidebar.inert = !desktop.matches && !open;
    if (open) sidebar.querySelector('[aria-current="page"]')?.focus();
    else if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  backdrop.addEventListener('click', () => setOpen(false, true));
  desktop.addEventListener('change', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    if (event.key === 'Escape') setOpen(false, true);
    if (event.key !== 'Tab') return;
    const links = [...sidebar.querySelectorAll('a[href]')];
    const first = links[0];
    const last = links[links.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  setOpen(false);
}
