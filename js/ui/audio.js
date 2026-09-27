/**
 * Audio manager: synthesised sound effects and a procedural tabletop/city
 * ambience (Web Audio, no files to download).
 *
 *   context → master (volume, mute) → limiter → speakers
 *               ├─ sfx bus (effects volume)
 *               └─ ambience bus (ambience volume; faded by scene/pause/visibility)
 *
 * - No autoplay: the AudioContext is created only after a user gesture, and
 *   ambience only plays on the game screen once the player has interacted.
 * - Every volume change, pause and resume ramps smoothly (no clicks).
 * - Reduced motion (the game setting or the OS preference) keeps sounds calmer:
 *   capture chains escalate less and ambience has fewer, static-panned sounds.
 * - Unsupported browsers, blocked audio or any node error: silently no sound.
 *
 * Gameplay never depends on audio; everything it signals is also shown on screen.
 */

const FADE = 0.35; // seconds (time constant) for ambience fades
const QUICK = 0.06; // seconds for volume/mute changes

export const SOUND_NAMES = Object.freeze(['tick', 'pave', 'capture', 'build', 'upgrade', 'coins', 'event', 'error', 'win']);

/** Semitone steps a capture chain climbs, per extra capture, and the cap (calmer with reduced motion). */
export const CHAIN = Object.freeze({ STEP: 2, MAX_STEPS: 4, REDUCED_MAX_STEPS: 1 });

const semis = (f, n) => f * 2 ** (n / 12);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Low-level voices scheduled on a destination node. Each returns when it ends (s).
 * Envelopes use exponential ramps from/to near-silence to avoid clicks.
 */
function voices(ac, noiseBuffer, hasPanner) {
  const envelope = (param, t, { attack = 0.005, peak, hold = 0, release }) => {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    if (hold) param.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release;
  };
  const route = (node, out, pan) => {
    if (pan && hasPanner) {
      const p = ac.createStereoPanner();
      if (Array.isArray(pan)) {
        p.pan.setValueAtTime(pan[0], pan[2]);
        p.pan.linearRampToValueAtTime(pan[1], pan[3]);
      } else {
        p.pan.value = pan;
      }
      node.connect(p).connect(out);
    } else {
      node.connect(out);
    }
  };
  const filtered = (src, { type, freq, q = 0.7, to, t, end }) => {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, end);
    f.Q.value = q;
    src.connect(f);
    return f;
  };

  return {
    tone(out, t, { freq, to, type = 'sine', gain, attack, hold, release, detune = 0, filter, pan }) {
      const osc = ac.createOscillator();
      const amp = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.value = detune;
      const end = envelope(amp.gain, t, { attack, peak: gain, hold, release });
      if (to) osc.frequency.exponentialRampToValueAtTime(to, end);
      const src = filter ? filtered(osc, { ...filter, t, end }) : osc;
      src.connect(amp);
      route(amp, out, pan);
      osc.start(t);
      osc.stop(end + 0.03);
      return end;
    },
    noise(out, t, { gain, attack, hold, release, filter, pan, rate = 1 }) {
      const src = ac.createBufferSource();
      const amp = ac.createGain();
      src.buffer = noiseBuffer;
      src.loop = true;
      src.playbackRate.value = rate;
      const end = envelope(amp.gain, t, { attack, peak: gain, hold, release });
      const shaped = filter ? filtered(src, { ...filter, t, end }) : src;
      shaped.connect(amp);
      route(amp, out, pan);
      src.start(t, Math.random() * 0.5);
      src.stop(end + 0.03);
      return end;
    },
    /** Struck metal: inharmonic partials decaying at different rates. */
    bell(out, t, { freq, gain, release = 1.2, pan }) {
      let end = t;
      [[1, 1, 1], [2.76, 0.45, 0.6], [5.4, 0.22, 0.35], [8.93, 0.1, 0.2]].forEach(([ratio, g, r]) => {
        end = Math.max(end, this.tone(out, t, { freq: freq * ratio, gain: gain * g, attack: 0.003, release: release * r, pan }));
      });
      return end;
    },
  };
}

/** Sound recipes: (voice API, output bus, start time, params) → end time. Distinct timbres per action. */
const RECIPES = {
  // Soft wooden tap (road preview on touch screens).
  tick(v, out, t) {
    v.noise(out, t, { gain: 0.05, attack: 0.001, release: 0.025, filter: { type: 'highpass', freq: 3200 } });
    return v.tone(out, t, { freq: 1400, gain: 0.035, attack: 0.002, release: 0.04 });
  },
  // A card road tile set down: low thump, paper scrape, tiny click.
  pave(v, out, t) {
    v.tone(out, t, { freq: 150, to: 85, type: 'triangle', gain: 0.24, attack: 0.004, release: 0.14 });
    v.noise(out, t, { gain: 0.1, attack: 0.004, release: 0.09, filter: { type: 'bandpass', freq: 1900, to: 900, q: 1.2 } });
    return v.tone(out, t + 0.05, { freq: 2400, gain: 0.03, attack: 0.001, release: 0.025 });
  },
  // Rising major arpeggio; longer chains climb higher and add layers.
  capture(v, out, t, { intensity = 1, reduced }) {
    const chainSteps = Math.min(Math.max(0, Math.round(intensity) - 1), reduced ? CHAIN.REDUCED_MAX_STEPS : CHAIN.MAX_STEPS);
    const root = semis(523.25, chainSteps * CHAIN.STEP);
    const notes = [0, 4, 7];
    if (intensity >= 2) notes.push(12);
    if (intensity >= 3) notes.push(16);
    const gain = 0.13 * (1 + chainSteps * 0.07);
    let end = t;
    notes.forEach((n, i) => {
      const at = t + i * 0.07;
      v.tone(out, at, { freq: semis(root, n), type: 'triangle', gain, attack: 0.004, release: 0.18 });
      end = v.tone(out, at, { freq: semis(root, n + 12), gain: gain * 0.3, attack: 0.004, release: 0.12 });
    });
    if (intensity >= 2) {
      v.noise(out, end - 0.05, { gain: 0.03 + chainSteps * 0.006, attack: 0.01, release: 0.3, filter: { type: 'highpass', freq: 6500 } });
      end = Math.max(end, v.tone(out, end - 0.04, { freq: semis(root, 24), gain: 0.03, attack: 0.003, release: 0.35 }));
    }
    if (intensity >= 3 && !reduced) v.tone(out, t, { freq: 65, gain: 0.16, attack: 0.01, release: 0.45 });
    return end;
  },
  // Two wooden knocks, then a warm settled chord.
  build(v, out, t) {
    for (const at of [t, t + 0.09]) {
      v.noise(out, at, { gain: 0.09, attack: 0.002, release: 0.05, filter: { type: 'bandpass', freq: 950, q: 2 } });
      v.tone(out, at, { freq: 190, type: 'triangle', gain: 0.12, attack: 0.002, release: 0.07 });
    }
    let end = t;
    for (const f of [392, 493.88, 587.33]) end = v.tone(out, t + 0.2, { freq: f, gain: 0.055, attack: 0.006, release: 0.42 });
    return end;
  },
  // One knock, then a brassy rising fanfare (distinct from a capture's pure arpeggio).
  upgrade(v, out, t) {
    v.noise(out, t, { gain: 0.09, attack: 0.002, release: 0.05, filter: { type: 'bandpass', freq: 950, q: 2 } });
    let end = t;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      end = v.tone(out, t + 0.1 + i * 0.075, {
        freq: f, type: 'sawtooth', gain: 0.045, attack: 0.008, hold: i === 3 ? 0.12 : 0, release: 0.2,
        filter: { type: 'lowpass', freq: 2300, q: 0.9 },
      });
    });
    v.noise(out, end - 0.2, { gain: 0.02, attack: 0.01, release: 0.3, filter: { type: 'highpass', freq: 7000 } });
    return end;
  },
  // Three metallic coin clinks.
  coins(v, out, t) {
    let end = t;
    [[0, 1], [0.07, 1.06], [0.15, 0.97]].forEach(([dt, k]) => {
      v.tone(out, t + dt, { freq: 2093 * k, gain: 0.05, attack: 0.001, release: 0.16 });
      v.tone(out, t + dt, { freq: 2637 * k * 1.01, gain: 0.03, attack: 0.001, release: 0.12 });
      end = v.tone(out, t + dt, { freq: 3520 * k, gain: 0.018, attack: 0.001, release: 0.09 });
    });
    return end;
  },
  // City event: bright bells for boons, a soft two-tone siren for emergencies, low minor bells for downturns.
  event(v, out, t, { kind }) {
    if (kind === 'emergency') {
      let end = t;
      [660, 520, 660, 520].forEach((f, i) => {
        end = v.tone(out, t + i * 0.19, {
          freq: f, type: 'sawtooth', gain: 0.04, attack: 0.02, hold: 0.1, release: 0.07,
          filter: { type: 'lowpass', freq: 1300, q: 0.7 },
        });
      });
      return end;
    }
    const [a, b] = kind === 'boon' ? [880, 1174.66] : kind === 'downturn' ? [392, 311.13] : [659.25, 523.25];
    v.bell(out, t, { freq: a, gain: 0.07, release: 1.1 });
    return v.bell(out, t + 0.22, { freq: b, gain: 0.07, release: 1.3 });
  },
  // Muted "bonk": falling low tone, no harsh buzz.
  error(v, out, t) {
    v.noise(out, t, { gain: 0.05, attack: 0.002, release: 0.06, filter: { type: 'lowpass', freq: 500 } });
    return v.tone(out, t, { freq: 220, to: 130, type: 'square', gain: 0.07, attack: 0.004, release: 0.17, filter: { type: 'lowpass', freq: 900 } });
  },
  // Fanfare, a held chord and a little sparkle.
  win(v, out, t, { reduced }) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      v.tone(out, t + i * 0.12, { freq: f, type: 'triangle', gain: 0.13, attack: 0.005, release: 0.18 });
    });
    let end = t;
    for (const f of [523.25, 659.25, 783.99, 1046.5]) {
      end = v.tone(out, t + 0.5, { freq: f, gain: 0.045, attack: 0.04, hold: 0.45, release: 0.9 });
    }
    if (!reduced) v.noise(out, t + 0.5, { gain: 0.025, attack: 0.05, hold: 0.2, release: 0.8, filter: { type: 'highpass', freq: 7500 } });
    return end;
  },
};

/** Ambient one-shots over the bed, every few seconds. */
const AMBIENT_EVENTS = {
  // A car passing in the distance (panned across unless reduced motion).
  car(v, out, t, { reduced, random }) {
    const dir = random() < 0.5 ? -1 : 1;
    return v.noise(out, t, {
      gain: 0.05, attack: 1.1, release: 1.4,
      filter: { type: 'bandpass', freq: 420, to: 760, q: 1.4 },
      pan: reduced ? dir * 0.3 : [-0.8 * dir, 0.8 * dir, t, t + 2.5],
    });
  },
  // A bird on a lamp post: two or three quick chirps.
  bird(v, out, t, { random }) {
    const pan = random() * 1.2 - 0.6;
    const count = 2 + Math.floor(random() * 2);
    let end = t;
    for (let i = 0; i < count; i++) {
      end = v.tone(out, t + i * 0.13, { freq: 2900 + random() * 500, to: 3700, gain: 0.012, attack: 0.01, release: 0.07, pan });
    }
    return end;
  },
  // A far-off church/city-hall bell.
  bell(v, out, t, { random }) {
    return v.bell(out, t, { freq: random() < 0.5 ? 523.25 : 587.33, gain: 0.012, release: 2.2, pan: random() * 0.8 - 0.4 });
  },
  // Paper shifting on the table.
  rustle(v, out, t) {
    return v.noise(out, t, { gain: 0.018, attack: 0.03, release: 0.25, filter: { type: 'highpass', freq: 2600 } });
  },
};

/**
 * @param deps  injectable environment (the defaults use the browser): AudioContext
 *              class, timers, random source and the OS reduced-motion preference.
 */
export function createAudioManager({
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  random = Math.random,
  osReducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
} = {}) {
  const prefs = { sound: true, masterVolume: 80, sfxVolume: 80, ambience: true, ambienceVolume: 50, reducedMotion: false };
  const scene = { name: 'title', paused: false, hidden: false };
  let ac = null;
  let bus = null; // { master, sfx, ambience, noise, brown, v }
  let unlocked = false;
  let failed = false;
  let amb = null; // running ambience: { sources, timer, stopTimer }

  const reduced = () => prefs.reducedMotion || osReducedMotion();
  const masterLevel = () => (prefs.sound && !scene.hidden ? clamp01(prefs.masterVolume / 100) : 0);
  const sfxLevel = () => clamp01(prefs.sfxVolume / 100);
  const ambienceWanted = () => prefs.sound && prefs.ambience && prefs.ambienceVolume > 0
    && scene.name === 'game' && !scene.paused && !scene.hidden;
  // Ambience is a quiet background layer: full slider = 45% of effects loudness.
  const ambienceLevel = () => (ambienceWanted() ? clamp01(prefs.ambienceVolume / 100) * 0.45 : 0);

  const safely = (fn) => {
    if (failed) return undefined;
    try {
      return fn();
    } catch {
      return undefined; // audio is optional
    }
  };

  function makeNoise(seconds, brown) {
    const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }
    return buffer;
  }

  /** Creates the context and buses. Only ever called from a user gesture (or after one). */
  function ensureContext() {
    if (ac || failed) return ac;
    if (!AudioContextClass || !unlocked) return null;
    try {
      ac = new AudioContextClass();
      const master = ac.createGain();
      master.gain.value = 0;
      const limiter = ac.createDynamicsCompressor?.();
      if (limiter) {
        limiter.threshold.value = -10;
        limiter.ratio.value = 6;
        master.connect(limiter).connect(ac.destination);
      } else {
        master.connect(ac.destination);
      }
      const sfx = ac.createGain();
      const ambience = ac.createGain();
      ambience.gain.value = 0;
      sfx.connect(master);
      ambience.connect(master);
      const noise = makeNoise(1, false);
      bus = { master, sfx, ambience, noise, brown: makeNoise(4, true), v: voices(ac, noise, typeof ac.createStereoPanner === 'function') };
      apply(true);
    } catch {
      failed = true;
      ac = null;
      bus = null;
    }
    return ac;
  }

  /** Smoothly moves every bus to where the current preferences and scene say it should be. */
  function apply(immediate = false) {
    safely(() => {
      if (!ac) return;
      const now = ac.currentTime;
      const glide = (param, value, tc) => {
        if (immediate) param.setValueAtTime(value, now);
        else param.setTargetAtTime(value, now, tc);
      };
      glide(bus.master.gain, masterLevel(), QUICK);
      glide(bus.sfx.gain, sfxLevel(), QUICK);
      glide(bus.ambience.gain, ambienceLevel(), FADE);
      if (ambienceWanted()) startAmbience();
      else stopAmbienceSoon();
      if (scene.hidden) suspendSoon();
      else if (ac.state === 'suspended') ac.resume().catch(() => {});
    });
  }

  let suspendTimer = null;
  function suspendSoon() {
    clearTimer(suspendTimer);
    // Let the fade finish, then stop the audio clock entirely (saves battery in the background).
    suspendTimer = setTimer(() => safely(() => { if (scene.hidden && ac.state === 'running') ac.suspend().catch(() => {}); }), 400);
  }

  function startAmbience() {
    if (!ac || amb?.sources) {
      if (amb) { clearTimer(amb.stopTimer); amb.stopTimer = null; }
      return;
    }
    const loop = (buffer, filter, gain) => {
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = filter.type;
      f.frequency.value = filter.freq;
      f.Q.value = filter.q ?? 0.7;
      const g = ac.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(bus.ambience);
      src.start();
      return { src, g };
    };
    // Tabletop room tone and a low, slowly swelling city hum (traffic in the distance).
    const bed = loop(bus.brown, { type: 'lowpass', freq: 320 }, 0.32);
    const hum = loop(bus.brown, { type: 'bandpass', freq: 150, q: 0.8 }, 0.14);
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 0.06;
    depth.gain.value = 0.07;
    lfo.connect(depth).connect(hum.g.gain);
    lfo.start();
    amb = { sources: [bed.src, hum.src, lfo], timer: null, stopTimer: null };
    scheduleAmbientEvent();
  }

  function scheduleAmbientEvent() {
    if (!amb?.sources) return;
    const [min, max] = reduced() ? [9, 18] : [5, 12];
    amb.timer = setTimer(() => {
      safely(() => {
        if (!amb?.sources || !ambienceWanted()) return;
        const names = Object.keys(AMBIENT_EVENTS);
        const pick = names[Math.floor(random() * names.length)];
        AMBIENT_EVENTS[pick](bus.v, bus.ambience, ac.currentTime + 0.05, { reduced: reduced(), random });
      });
      scheduleAmbientEvent();
    }, (min + random() * (max - min)) * 1000);
  }

  function stopAmbienceSoon() {
    if (!amb?.sources || amb.stopTimer) return;
    // Keep the nodes through the fade-out, then release them.
    amb.stopTimer = setTimer(() => {
      if (ambienceWanted() || !amb) return;
      clearTimer(amb.timer);
      safely(() => amb.sources.forEach((s) => s.stop()));
      amb = null;
    }, FADE * 5 * 1000);
  }

  return {
    /** Call from the first user gesture (pointer/key). Safe to call repeatedly. */
    unlock() {
      unlocked = true;
      if (ensureContext() && ac.state === 'suspended' && !scene.hidden) ac.resume().catch(() => {});
      apply();
    },
    /** Applies saved settings: { sound, masterVolume, sfxVolume, ambience, ambienceVolume, reducedMotion }. */
    configure(settings = {}) {
      for (const key of Object.keys(prefs)) if (key in settings) prefs[key] = settings[key];
      apply();
    },
    /** 'title' | 'game' | …: ambience plays only in the game. */
    setScene(name) {
      scene.name = name;
      apply();
    },
    /** Pause menu open: ambience fades out; resumes smoothly on close. */
    setPaused(paused) {
      scene.paused = Boolean(paused);
      apply();
    },
    /** Tab/app in the background: fade everything out and suspend; fade back in on return. */
    setHidden(hidden) {
      scene.hidden = Boolean(hidden);
      apply();
    },
    /**
     * @param name   one of SOUND_NAMES
     * @param opts   { intensity: capture chain length, kind: event kind }
     */
    play(name, { intensity = 1, kind } = {}) {
      if (!RECIPES[name] || !prefs.sound || !unlocked || scene.hidden) return false;
      return Boolean(safely(() => {
        if (!ensureContext()) return false;
        if (ac.state === 'suspended') ac.resume().catch(() => {});
        RECIPES[name](bus.v, bus.sfx, ac.currentTime + 0.01, { intensity, kind, reduced: reduced() });
        return true;
      }));
    },
    /** Snapshot for tests and ?debug. */
    state() {
      return {
        unlocked,
        supported: Boolean(AudioContextClass) && !failed,
        contextState: ac?.state ?? 'none',
        scene: { ...scene },
        ambienceRunning: Boolean(amb?.sources),
        levels: { master: masterLevel(), sfx: sfxLevel(), ambience: ambienceLevel() },
        reduced: reduced(),
      };
    },
  };
}

/** The game's single audio manager. */
export const audio = createAudioManager();

/**
 * Wires the manager to the page: unlocks on user gestures, follows screens and
 * visibility. (Settings are applied by settingsView via audio.configure.)
 */
export function initAudio({ bus }) {
  const unlock = () => audio.unlock();
  for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => audio.setHidden(document.visibilityState === 'hidden'));
  bus.on('screen:shown', ({ name }) => audio.setScene(name));
}

/** Shorthand used by the game views. */
export const play = (name, opts) => audio.play(name, opts);
