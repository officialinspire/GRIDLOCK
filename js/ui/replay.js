/**
 * Plays a CSS animation again from its start without forcing a layout.
 *
 *   replayAnimation(el, 'is-bumped')
 *
 * The usual trick (remove the class, read el.offsetWidth, add the class back) makes the browser
 * recalculate style and layout in the middle of a tap or a CPU step, on a phone often for the
 * whole page. Instead the element keeps its animation class and toggles `is-replay`: the CSS gives
 * the replay the same keyframes under a second name (css/game.css, "…-replay"), and a changed
 * animation-name starts a fresh animation at the next style update, in the frame that shows the
 * change, as the trick did. No class is ever missing for a frame, so nothing flickers.
 *
 * - The first time it just adds the class (the animation starts as it appears).
 * - At most one toggle per element per frame: a second toggle before the browser looks would
 *   bring the old name back and cancel the restart (two captures in one step, a burst of CPU
 *   steps in one frame). One restart per frame looks the same as several.
 * - In a hidden page nothing restarts: nobody sees it, and it would only play late, on return.
 * - Reduced motion needs nothing here: the CSS turns animations off, both names included.
 *
 * The browser hooks can be replaced (tests use fakes).
 */
export const REPLAY_CLASS = 'is-replay';

export function createReplayer({
  requestFrame = (fn) => requestAnimationFrame(fn),
  isHidden = () => document.hidden,
} = {}) {
  const thisFrame = new Set(); // elements already restarted for the coming frame
  let framePending = false;

  const nextFrame = () => {
    if (framePending) return;
    framePending = true;
    requestFrame(() => {
      framePending = false;
      thisFrame.clear();
    });
  };

  return function replayAnimation(el, className) {
    if (!el) return;
    if (!el.classList.contains(className)) {
      el.classList.add(className);
    } else {
      if (isHidden() || thisFrame.has(el)) return;
      el.classList.toggle(REPLAY_CLASS);
    }
    thisFrame.add(el);
    nextFrame();
  };
}

export const replayAnimation = createReplayer();
