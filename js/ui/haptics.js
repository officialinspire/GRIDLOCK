/**
 * Optional haptic feedback (navigator.vibrate) for touch devices.
 *
 * - Only on devices whose primary pointer is touch *and* that support vibration
 *   (Android browsers; iPhone Safari has no Vibration API, so it's simply off).
 *   Desktop behaviour is unchanged: no calls, and the setting row stays hidden.
 * - Never required: every buzz accompanies feedback that is already on screen.
 * - Only after the player has interacted (browsers block vibration before that),
 *   only while the page is visible, and any error is silently ignored.
 */

/** Vibration patterns in ms: [buzz, pause, buzz, …]. Each action has its own feel. */
export const PATTERNS = Object.freeze({
  arm: [8], // road previewed (tap-twice-to-pave): barely there
  pave: [18], // road paved: short tap
  capture: [30, 40, 45], // block claimed: stronger double
  chain: [30, 40, 30, 40, 60], // capture chain (2+): three rising pulses
  build: [14, 60, 26], // construction confirmed
  upgrade: [14, 50, 14, 50, 34], // upgrade confirmed: one more tick
  error: [60, 60, 60], // refused: two firm buzzes
  event: [90, 70, 40, 70, 40], // a city event arrives: long + two short
  win: [40, 50, 40, 50, 40, 50, 180], // city complete: drum roll + long
});

/**
 * @param deps  injectable environment (tests); defaults use the browser
 */
export function createHaptics({
  nav = globalThis.navigator,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  isVisible = () => globalThis.document?.visibilityState !== 'hidden',
} = {}) {
  let enabled = true;
  let interacted = false;

  const supported = () => typeof nav?.vibrate === 'function' && Boolean(matchMedia?.('(pointer: coarse)').matches);
  const activated = () => interacted || Boolean(nav?.userActivation?.hasBeenActive);

  return {
    supported,
    /** Applies the saved "haptics" setting. */
    configure({ haptics } = {}) {
      if (typeof haptics === 'boolean') enabled = haptics;
    },
    /** Marks that the player has interacted (pointer/key), for browsers without navigator.userActivation. */
    noteInteraction() {
      interacted = true;
    },
    /**
     * @param name   key of PATTERNS ('capture' escalates to 'chain' for intensity ≥ 2)
     * @returns true if a vibration was requested
     */
    buzz(name, { intensity = 1 } = {}) {
      const key = name === 'capture' && intensity >= 2 ? 'chain' : name;
      if (!enabled || !PATTERNS[key] || !supported() || !activated() || !isVisible()) return false;
      try {
        return nav.vibrate([...PATTERNS[key]]) !== false;
      } catch {
        return false; // haptics are optional
      }
    },
  };
}

/** The game's single haptics controller. */
export const haptics = createHaptics();

/** Records the first interaction and applies settings; call once at startup. */
export function initHaptics(settings) {
  haptics.configure(settings);
  const note = () => haptics.noteInteraction();
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, note, { capture: true, passive: true, once: true });
}

export const buzz = (name, opts) => haptics.buzz(name, opts);
