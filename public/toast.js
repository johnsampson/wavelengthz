// Growl-style toast notifications -- named after the classic macOS notifier
// this pattern is commonly called after. Appear at the top of the page,
// auto-dismiss after a few seconds, dismiss immediately on click.
const AUTO_DISMISS_MS = 5000;

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.id = 'wl-toast-root';
  // Screen readers announce new toasts without needing focus; the container
  // itself never intercepts clicks (pointer-events: none) so it doesn't sit
  // on top of the page's own content -- each toast re-enables it individually.
  container.setAttribute('aria-live', 'polite');
  container.className = 'pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-3';
  document.body.appendChild(container);
  return container;
}

export function showToast({ message, icon = '🔔', onClick } = {}) {
  const root = ensureContainer();
  const el = document.createElement('button');
  el.type = 'button';
  el.style.transition = 'opacity 200ms ease, transform 200ms ease';
  el.className =
    'pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-xl border border-white/10 bg-surface/95 p-3 text-left shadow-lg backdrop-blur transition active:scale-[0.98]';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'text-lg';
  iconSpan.textContent = icon;

  // textContent, not innerHTML -- message is currently always a static
  // string ("New match!"), but this keeps it safe even if a future caller
  // passes something derived from user content (a display name, etc.).
  const messageSpan = document.createElement('span');
  messageSpan.className = 'min-w-0 flex-1 truncate text-sm text-neutral-100';
  messageSpan.textContent = message;

  el.append(iconSpan, messageSpan);

  let dismissed = false;
  let timer;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    el.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => el.remove(), 200);
  };

  el.addEventListener('click', () => {
    dismiss();
    if (onClick) onClick();
  });

  root.appendChild(el);
  timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  return dismiss;
}
