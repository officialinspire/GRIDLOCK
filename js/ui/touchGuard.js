/**
 * Accidental-touch guard for tap-through on touch screens.
 *
 * A quick double tap can land its second tap on whatever appeared under the
 * finger: "Develop Now" opens the build panel with category buttons in the same
 * spot, and closing a dialog reveals the board's roads. For touch input only,
 * taps inside a dialog in the first moments after it opens, and taps on the board
 * right after a dialog closes, are ignored. Mouse, pen and keyboard are unaffected.
 *
 * Repeats: a button marked [data-no-repeat] (End Turn) takes one press at a time. A second
 * touch tap on it within REPEAT_MS, or the second click of a mouse double-click, is the same
 * press: taken twice it would end the next mayor's turn before they have seen it (the handoff
 * card absorbs that tap, but Quick Handoff skips the card). Separate clicks and the keyboard
 * are unaffected.
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

/** A second tap on the same turn button this soon is a double tap, not a decision. */
export const REPEAT_MS = 500;

/**
 * Decides whether a click on a [data-no-repeat] button repeats the last press on it.
 * @param c.pointerType  type of the pointer that produced the click
 * @param c.keyboard     true for keyboard-activated clicks
 * @param c.detail       the click's count (2 for the second click of a double-click)
 * @param c.now          current time (ms)
 * @param c.lastPressAt  when the last press on this button was taken
 */
export function isRepeatPress({ pointerType, keyboard, detail, now, lastPressAt }) {
  if (keyboard) return false;
  if (detail >= 2) return true;
  return pointerType === 'touch' && now - lastPressAt < REPEAT_MS;
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

  const pressedAt = new WeakMap(); // [data-no-repeat] button → when its last press was taken
  root.addEventListener('click', (e) => {
    const dialog = e.target.closest?.('dialog[open]');
    const now = performance.now();
    const type = e.pointerType ?? pointerType;
    const keyboard = e.detail === 0;
    let swallow = isTapThrough({
      pointerType: type,
      keyboard,
      now,
      dialogOpenedAt: dialog ? openedAt.get(dialog) ?? null : null,
      onBoard: Boolean(e.target.closest?.('#board')),
      lastDialogClosedAt,
    });
    const single = e.target.closest?.('[data-no-repeat]');
    if (single && !swallow) {
      swallow = isRepeatPress({ pointerType: type, keyboard, detail: e.detail, now, lastPressAt: pressedAt.get(single) ?? -Infinity });
      if (!swallow) pressedAt.set(single, now);
    }
    if (swallow) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
}
