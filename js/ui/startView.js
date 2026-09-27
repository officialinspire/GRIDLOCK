/**
 * Start screen ("Tap to start" / "Press Enter to start") and the INSPIRE intro, once per browser
 * session, like the other INSPIRE games:
 *
 *   start screen → (first tap / click / key) → INSPIRE intro video → main menu
 *
 * The first gesture also unlocks sound (js/ui/audio.js), so the menu theme can play after the
 * intro. A reload in the same session (including the update prompt's Reload) goes straight to
 * the main menu, so a game in progress is one tap from Continue.
 */
import { $ } from './dom.js';
import { showScreen, resetTo, currentScreen } from './router.js';
import { createIntro } from './intro.js';

export const SESSION_KEY = 'gridlock.session.v1';
export const INTRO_SRC = 'assets/media/inspiresoftwareintro.mp4';
/** Keys that never start the game (they move focus or are modifiers). */
const IGNORED_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape']);

function sessionStore() {
  try {
    const s = globalThis.sessionStorage;
    s.setItem(`${SESSION_KEY}:probe`, '1');
    s.removeItem(`${SESSION_KEY}:probe`);
    return s;
  } catch {
    return null; // blocked: remember in memory for this page only
  }
}

let started = false;
const store = sessionStore();

/** Has the player already passed the start screen in this browser session? */
export function sessionStarted() {
  if (started) return true;
  try { return store?.getItem(SESSION_KEY) === 'started'; } catch { return false; }
}

function markStarted() {
  started = true;
  try { store?.setItem(SESSION_KEY, 'started'); } catch { /* memory only */ }
}

/**
 * @param getSettings  current settings (sound on/off and volumes shape the intro's own audio)
 * @param onMenu       called once the main menu is showing (after the intro, or at once)
 */
export function initStartView({ getSettings, onMenu }) {
  const screen = $('[data-screen="start"]');
  const video = $('#intro-video');
  const toMenu = () => {
    resetTo('title');
    onMenu?.();
  };
  const intro = createIntro({
    video,
    skipButton: $('#intro-skip'),
    src: INTRO_SRC,
    onDone: () => { if (currentScreen() === 'intro') toMenu(); },
  });

  // Tell touch players to tap and keyboard players to press Enter.
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches;
  $('#start-prompt').textContent = coarse ? 'Tap to start' : 'Click or press Enter to start';

  function begin() {
    if (currentScreen() !== 'start') return; // only the first tap/key counts
    markStarted();
    showScreen('intro');
    const s = getSettings();
    intro.play({ muted: !s.sound, volume: (s.masterVolume / 100) * 0.9 });
  }

  screen.addEventListener('click', begin);
  document.addEventListener('keydown', (e) => {
    const where = currentScreen();
    if (where === 'intro' && intro.active && ['Escape', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      intro.skip();
      return;
    }
    if (where !== 'start' || e.repeat || IGNORED_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    // The key that starts must not also press the menu button that gets focus next.
    const key = e.key;
    const swallow = (up) => {
      if (up.key !== key) return;
      up.preventDefault();
      up.stopPropagation();
      document.removeEventListener('keyup', swallow, true);
    };
    document.addEventListener('keyup', swallow, true);
    begin();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && intro.active) intro.finish('hidden');
  });

  return {
    /** Shows the start screen for a new session; otherwise straight to the main menu. */
    show() {
      if (sessionStarted()) toMenu();
      else showScreen('start');
    },
    intro,
  };
}
