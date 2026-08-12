// Growl-style toast notifications -- named after the classic macOS notifier
// this pattern is commonly called after. Appear at the top of the page,
// auto-dismiss after a few seconds, dismiss immediately on click.
const AUTO_DISMISS_MS = 5000;

// 'error' is visually distinct (red-tinted) from the default 'info' style
// used for new-match/new-message growls, so a failure reads as a failure at
// a glance rather than looking like another notification. Every
// action-triggered failure across the app (send/save/join/report/etc.)
// uses this instead of the old page-scoped `<p x-show="error">` inline
// banner pattern -- that pattern sits wherever it was written in the DOM,
// which is easy to scroll right past (e.g. composing at the bottom of a
// long chat while the banner sits up at the top of the page).
const VARIANT_CLASSES = {
  info: 'border-white/10 bg-surface/95',
  error: 'border-red-500/40 bg-red-950/90',
};

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

export function showToast({ message, icon, variant = 'info', onClick } = {}) {
  const root = ensureContainer();
  const el = document.createElement('button');
  el.type = 'button';
  el.style.transition = 'opacity 200ms ease, transform 200ms ease';
  el.className = `pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-xl border p-3 text-left shadow-lg backdrop-blur transition active:scale-[0.98] ${VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.info}`;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'text-lg';
  iconSpan.textContent = icon ?? (variant === 'error' ? '⚠️' : '🔔');

  // textContent, not innerHTML -- message is often a static string ("New
  // match!") but this keeps it safe even for a caller passing something
  // derived from user content (a display name, etc.).
  //
  // No `truncate` here (unlike the info-toast styling this replaced) --
  // error messages are frequently full sentences ("Finish setting up
  // messaging in Settings → Messaging before sending."), not short labels,
  // and silently clipping the actual reason for a failure defeats the
  // point of surfacing it at all.
  const messageSpan = document.createElement('span');
  messageSpan.className = 'min-w-0 flex-1 text-sm text-neutral-100';
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

// Shorthand for the overwhelmingly common case (a plain failure message, no
// click handler) -- used at every "this action failed" call site across the
// app, so this is the one that actually gets typed dozens of times, not
// showToast itself.
export function showErrorToast(message) {
  return showToast({ message, variant: 'error' });
}
