/** Transient notifications pinned to the table. */
import { $, h } from './dom.js';

export function toast(message, { tone = 'info', duration = 2600 } = {}) {
  const stack = $('#toasts');
  if (!stack) return;
  const el = h('div', { class: `toast toast--${tone}` }, message);
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('toast--leaving');
    setTimeout(() => el.remove(), 300);
  }, duration);
}
