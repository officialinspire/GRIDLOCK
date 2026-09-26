/** Screen router: shows one `[data-screen]` section at a time, with a back stack. */
import { $$ } from './dom.js';
import { bus } from '../core/bus.js';

const stack = [];

export function currentScreen() {
  return stack[stack.length - 1] ?? null;
}

export function showScreen(name, { replace = false } = {}) {
  const screens = $$('section[data-screen]');
  const target = screens.find((s) => s.dataset.screen === name);
  if (!target) {
    console.warn(`[router] unknown screen "${name}"`);
    return;
  }
  if (replace) stack.pop();
  if (currentScreen() !== name) stack.push(name);
  // Keep the stack shallow: a screen already in it collapses back to that point.
  const first = stack.indexOf(name);
  if (first !== stack.length - 1) stack.splice(first + 1);

  for (const s of screens) s.hidden = s !== target;
  document.body.dataset.activeScreen = name;
  window.scrollTo(0, 0);

  const focusTarget = target.querySelector('[data-autofocus]') ?? target.querySelector('h1, h2, [role="heading"]');
  if (focusTarget) {
    if (!focusTarget.matches('button, input, select, a')) focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({ preventScroll: true });
  }
  bus.emit('screen:shown', { name });
}

export function goBack() {
  if (stack.length > 1) {
    stack.pop();
    showScreen(stack[stack.length - 1]);
  } else {
    showScreen('title');
  }
}

/** Resets history so `name` is the only entry (e.g. quitting to title). */
export function resetTo(name) {
  stack.length = 0;
  showScreen(name);
}

/** Wires up any `[data-nav]` buttons in the document. */
export function bindNavigation(root = document) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    e.preventDefault();
    const dest = btn.dataset.nav;
    if (dest === 'back') goBack();
    else showScreen(dest);
  });
}
