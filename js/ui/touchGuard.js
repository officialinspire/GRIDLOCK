/**
 * Accidental-touch guard for tap-through on touch screens.
 *
 * A quick double tap can land its second tap on whatever appeared under the
 * finger: "Develop Now" opens the build panel with category buttons in the same
 * spot, and closing a dialog reveals the board's roads. For touch input only,
 * taps inside a dialog in the first moments after it opens, and taps on the board
 * right after a dialog closes, are ignored. Mouse, pen and keyboard are unaffected.
 */

/** Android's double-tap timeout; deliberate taps on a fresh dialog take longer (you read it first). */
export const GUARD_MS = 300;

/**
 * Decides whether a click is an accidental tap-through.
 * @param c.pointerType     type of the pointer that produced the click ('touch', 'mouse', 'pen', '')
 * @param c.keyboard        true for keyboard-activated clicks
 * @param c.now             current time (ms)
 * @param c.dialogOpenedAt  when the dialog containing the target opened, or null if not in a dialog
 * @param c.onBoard         the target is on the game board
 * @param c.lastDialogClosedAt  when any dialog last closed
 */
export function isTapThrough({ pointerType, keyboard, now, dialogOpenedAt, onBoard, lastDialogClosedAt }) {
  if (keyboard || pointerType !== 'touch') return false;
  if (dialogOpenedAt != null) return now - dialogOpenedAt < GUARD_MS;
  return Boolean(onBoard) && now - lastDialogClosedAt < GUARD_MS;
}

export function initTouchGuard(root = document) {
  let pointerType = '';
  let lastDialogClosedAt = -Infinity;
  const openedAt = new WeakMap();

  root.addEventListener('pointerdown', (e) => { pointerType = e.pointerType; }, { capture: true, passive: true });

  const watch = (dialog) => {
    new MutationObserver(() => {
      if (dialog.open) openedAt.set(dialog, performance.now());
      else lastDialogClosedAt = performance.now();
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  };
  root.querySelectorAll('dialog').forEach(watch);

  root.addEventListener('click', (e) => {
    const dialog = e.target.closest?.('dialog[open]');
    const swallow = isTapThrough({
      pointerType: e.pointerType ?? pointerType,
      keyboard: e.detail === 0,
      now: performance.now(),
      dialogOpenedAt: dialog ? openedAt.get(dialog) ?? null : null,
      onBoard: Boolean(e.target.closest?.('#board')),
      lastDialogClosedAt,
    });
    if (swallow) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
}
