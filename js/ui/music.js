/**
 * Recorded music: one controller for the game's two themes.
 *
 *   menu   "Cardboard City": start screen, menus and the pause menu
 *   game   "Paper Blocks":   gameplay
 *
 * (Adapted from the INSPIRE Bird Mahjong music controller.)
 *
 * Why media elements: each theme is a few minutes long. Decoding one into an AudioBuffer
 * costs tens of MB; an <audio> element streams it. Each element is routed through Web Audio
 * (MediaElementSource → its own gain → the music bus), so master volume, the Music switch,
 * its volume and mute (all on the buses in js/ui/audio.js) apply as for every other sound.
 *
 * Seamless looping: each theme has two "voices" (elements). Shortly before the playing voice
 * ends, its twin starts from the top and they overlap briefly (LOOP_OVERLAP), so there is
 * never a gap, including the silent padding MP3 encoders add at the end of a file.
 *
 * Crossfades: switching themes ramps the new voice up and every other voice down over
 * CROSSFADE seconds. Each fade starts from the voice's current level and cancels whatever was
 * scheduled before, so quick screen changes never stack themes: one voice is heading up, the
 * rest are heading to silence (and are paused once there). Going back to a theme that is still
 * fading out turns it around without restarting it.
 *
 * play() can be refused: NotAllowedError (no user gesture yet) is retried on the next gesture
 * via retry(); anything else (unsupported, missing file, network) marks the theme failed, and
 * the game simply carries on without that music.
 */

export const CROSSFADE = 1.2; // seconds
export const LOOP_OVERLAP = 0.35; // seconds of overlap at the loop point
const WATCH_MS = 100; // loop-point check interval
const SILENT = 0.0001;

export function createMusicController({
  tracks, // { menu: url, game: url }
  ctx, // AudioContext (already unlocked)
  bus, // the music bus GainNode
  createAudio = (url) => new Audio(url),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const voices = new Map(); // track url -> [voice, voice]
  const failed = new Set(); // urls that can't play
  const lastVoice = new Map(); // track url -> the voice that last played it
  let active = null; // the voice heading to full volume
  let blocked = false; // play() refused for lack of a gesture
  let hidden = false;
  let watcher = null;

  /* ---------------- voices ---------------- */

  function makeVoice(url, n) {
    const el = createAudio(url);
    el.preload = 'auto';
    el.loop = false; // looping is done by the twin voice (see above)
    const gain = ctx.createGain();
    gain.gain.value = SILENT;
    try {
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(bus);
    } catch {
      gain.fallback = true; // no MediaElementSource: the element's own volume instead
    }
    const voice = { url, n, el, gain, level: 0, token: 0, playing: false };
    el.addEventListener('error', () => fail(url));
    // Safety net: a voice that reaches its end before the loop watcher caught it loops at once.
    el.addEventListener('ended', () => {
      voice.playing = false;
      if (active === voice && !hidden) loopFrom(voice);
    });
    return voice;
  }

  function voicesFor(url) {
    if (!voices.has(url)) voices.set(url, [makeVoice(url, 0), makeVoice(url, 1)]);
    return voices.get(url);
  }

  /** Ramps a voice from wherever it is now to `target` over `seconds`. */
  function fadeTo(voice, target, seconds) {
    const token = ++voice.token;
    voice.level = target;
    if (voice.gain.fallback) {
      voice.el.volume = target;
    } else {
      const p = voice.gain.gain;
      const t = ctx.currentTime;
      if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
      else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
      p.linearRampToValueAtTime(Math.max(target, SILENT), t + seconds);
    }
    if (target === 0) {
      // Pause once silent, unless another fade has taken over meanwhile.
      timers.setTimeout(() => { if (voice.token === token) pauseVoice(voice); }, seconds * 1000 + 60);
    }
  }

  function pauseVoice(voice) {
    voice.playing = false;
    try { voice.el.pause(); } catch { /* ignore */ }
  }

  function playVoice(voice, { fromStart = false } = {}) {
    if (failed.has(voice.url)) return false;
    if (fromStart) {
      try { voice.el.currentTime = 0; } catch { /* not seekable yet */ }
    }
    voice.playing = true;
    let result;
    try {
      result = voice.el.play();
    } catch (error) {
      refused(voice, error);
      return false;
    }
    result?.catch?.((error) => refused(voice, error));
    return true;
  }

  function refused(voice, error) {
    voice.playing = false;
    if (error?.name === 'NotAllowedError') { blocked = true; return; } // retried on the next gesture
    if (error?.name === 'AbortError') return; // superseded by pause(): harmless
    fail(voice.url);
  }

  function fail(url) {
    if (failed.has(url)) return;
    failed.add(url);
    for (const v of voices.get(url) ?? []) pauseVoice(v);
    if (active?.url === url) active = null;
  }

  /* ---------------- looping ---------------- */

  function watch() {
    if (watcher !== null) return;
    watcher = timers.setInterval(() => {
      if (!active || hidden || !active.playing) return;
      const { el } = active;
      const d = el.duration;
      if (!Number.isFinite(d) || d <= LOOP_OVERLAP * 2) return;
      if (d - el.currentTime <= LOOP_OVERLAP + WATCH_MS / 1000) loopFrom(active);
    }, WATCH_MS);
  }

  /** Hands over from a voice near (or at) its end to its twin, from the top. */
  function loopFrom(outgoing) {
    const [a, b] = voicesFor(outgoing.url);
    const twin = outgoing === a ? b : a;
    active = twin;
    lastVoice.set(twin.url, twin);
    playVoice(twin, { fromStart: true });
    fadeTo(twin, 1, LOOP_OVERLAP);
    fadeTo(outgoing, 0, LOOP_OVERLAP);
  }

  function fadeAllOut(seconds = CROSSFADE) {
    for (const list of voices.values()) for (const v of list) if (v.playing || v.level > 0) fadeTo(v, 0, seconds);
    active = null;
  }

  /* ---------------- public ---------------- */

  return {
    /**
     * Goes to a theme (`menu` | `game`) with a crossfade, or fades everything out (null).
     * The theme already heading up: nothing happens. One still fading out turns around.
     */
    play(theme) {
      const url = tracks[theme];
      if (!url || failed.has(url)) {
        fadeAllOut();
        return false;
      }
      if (active?.url === url && active.level === 1 && active.playing) return true; // no restart
      const [a, b] = voicesFor(url);
      // Prefer a voice of this theme still sounding (fading out), then the one that last played
      // it (so it carries on from the same place).
      const target = [a, b].find((v) => v.playing) ?? lastVoice.get(url) ?? a;
      for (const list of voices.values()) {
        for (const v of list) if (v !== target && (v.playing || v.level > 0)) fadeTo(v, 0, CROSSFADE);
      }
      active = target;
      lastVoice.set(url, target);
      fadeTo(target, 1, CROSSFADE);
      if (!hidden && !target.playing) playVoice(target); // hidden: starts on resume()
      watch();
      return true;
    },
    /** Fades everything out (e.g. the INSPIRE intro, or the Music switch turned off). */
    stop(seconds = CROSSFADE) {
      fadeAllOut(seconds);
    },
    /** Tab hidden: pause the elements, keeping their place. */
    suspend() {
      hidden = true;
      for (const list of voices.values()) for (const v of list) {
        if (v.playing) { v.resumeOnShow = true; try { v.el.pause(); } catch { /* ignore */ } }
      }
    },
    /** Tab visible again: carry on from the same place. */
    resume() {
      hidden = false;
      for (const list of voices.values()) for (const v of list) {
        if (v.resumeOnShow) { v.resumeOnShow = false; if (v.level > 0) playVoice(v); else v.playing = false; }
      }
      if (active && !active.playing && active.level > 0) playVoice(active);
    },
    /** A new user gesture: retry anything the browser refused to autoplay. */
    retry() {
      if (!blocked) return;
      blocked = false;
      if (active && !hidden && !failed.has(active.url)) playVoice(active);
    },
    /** For tests and ?debug. */
    get state() {
      const all = [...voices.values()].flat();
      const theme = (url) => Object.keys(tracks).find((k) => tracks[k] === url);
      return {
        active: active ? theme(active.url) : null,
        playing: all.filter((v) => v.playing).map((v) => `${theme(v.url)}#${v.n}`),
        failed: [...failed].map(theme),
        blocked,
      };
    },
  };
}
