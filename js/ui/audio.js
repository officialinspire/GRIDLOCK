/**
 * Audio manager: synthesised sound effects, a procedural tabletop/city ambience
 * (Web Audio, no files to download) and the two recorded music themes (js/ui/music.js).
 *
 *   context → master (volume, mute) → limiter → speakers
 *               ├─ sfx bus (effects volume)
 *               ├─ ambience bus (ambience volume; faded by scene/pause/visibility)
 *               └─ music bus (music volume): "Cardboard City" on the start screen, menus
 *                  and the pause menu; "Paper Blocks" in play; silent during the intro video
 *
 * - Music crossfades between themes (~1.2 s) whenever the screen or pause state changes,
 *   and fades out/in with the tab's visibility.
 * - No autoplay: the AudioContext is created only after a user gesture, and
 *   ambience only plays on the game screen once the player has interacted.
 * - Every volume change, pause and resume ramps smoothly (no clicks).
 * - Reduced motion (the game setting or the OS preference) keeps sounds calmer:
 *   capture chains escalate less and ambience has fewer, static-panned sounds.
 * - Unsupported browsers, blocked audio or any node error: silently no sound.
 *
 * Gameplay never depends on audio; everything it signals is also shown on screen.
 */

import { createMusicController } from './music.js';

const FADE = 0.35; // seconds (time constant) for ambience fades
const QUICK = 0.06; // seconds for volume/mute changes

export const SOUND_NAMES = Object.freeze(['tick', 'click', 'select', 'turn', 'pave', 'capture', 'build', 'upgrade', 'coins', 'event', 'error', 'win']);

/** Music themes (js/ui/music.js) and which screens use them. */
export const MUSIC_TRACKS = Object.freeze({ menu: 'assets/media/cardboard-city.mp3', game: 'assets/media/paper-blocks.mp3' });
/** Music sits under the effects: full slider = this share of effects loudness. */
const MUSIC_MIX = 0.55;

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
  // Button press: a crisp card-stock click with a tiny wooden knock under it.
  click(v, out, t) {
    v.noise(out, t, { gain: 0.06, attack: 0.001, release: 0.025, filter: { type: 'highpass', freq: 2500 } });
    return v.tone(out, t, { freq: 620, to: 480, type: 'triangle', gain: 0.08, attack: 0.001, release: 0.05 });
  },
  // Choosing an option (radio, switch, preset): a bright two-note "pip-pip".
  select(v, out, t) {
    v.tone(out, t, { freq: 987.77, type: 'triangle', gain: 0.05, attack: 0.002, release: 0.06 });
    return v.tone(out, t + 0.06, { freq: 1318.51, type: 'triangle', gain: 0.05, attack: 0.002, release: 0.1 });
  },
  // A new mayor's turn: a card sliding across the table, then a gentle "your move" chime.
  turn(v, out, t) {
    v.noise(out, t, { gain: 0.035, attack: 0.02, release: 0.14, filter: { type: 'bandpass', freq: 2400, to: 1200, q: 0.9 } });
    v.tone(out, t + 0.12, { freq: 783.99, gain: 0.045, attack: 0.004, release: 0.35 });
    return v.tone(out, t + 0.21, { freq: 1046.5, gain: 0.04, attack: 0.004, release: 0.45 });
  },
  // A card road tile set down: low thump, paper scrape, tiny click.
  pave(v, out, t) {
    v.tone(out, t, { freq: 150, to: 85, type: 'triangle', gain: 0.24, attack: 0.004, release: 0.14 });
    v.noise(out, t, { gain: 0.1, attack: 0.004, release: 0.09, filter: { type: 'bandpass', freq: 1900, to: 900, q: 1.2 } });
    return v.tone(out, t + 0.05, { freq: 2400, gain: 0.03, attack: 0.001, release: 0.025 });
  },
  // A rubber "CLAIMED" stamp thuds onto the block, then a rising major arpeggio; longer chains
  // climb higher and add layers.
  capture(v, out, t, { intensity = 1, reduced }) {
    v.tone(out, t, { freq: 120, to: 60, type: 'sine', gain: 0.16, attack: 0.002, release: 0.12 });
    v.noise(out, t, { gain: 0.07, attack: 0.001, release: 0.06, filter: { type: 'lowpass', freq: 1400 } });
    t += 0.06;
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
  // Construction: each building type has its own little building-site sound (CONSTRUCTION).
  build(v, out, t, { id, reduced }) {
    return (CONSTRUCTION[id] ?? CONSTRUCTION.default)(v, out, t, { reduced });
  },
  // An upgrade: a shorter burst of that type's building site, then a brassy rising fanfare.
  upgrade(v, out, t, { id, reduced }) {
    if (CONSTRUCTION[id]) {
      const site = CONSTRUCTION[id](v, out, t, { reduced, short: true });
      return RECIPES.levelUp(v, out, Math.max(t + 0.18, site - 0.25));
    }
    return RECIPES.levelUp(v, out, t);
  },
  // One knock, then a brassy rising fanfare (distinct from a capture's pure arpeggio).
  levelUp(v, out, t) {
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
  // City event: its own sound (EVENT_SOUNDS, by event id); otherwise by kind: bright bells for
  // boons, a soft two-tone siren for emergencies, low minor bells for downturns.
  event(v, out, t, { kind, id, reduced }) {
    if (EVENT_SOUNDS[id]) return EVENT_SOUNDS[id](v, out, t, { reduced });
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

/** Wooden hammer knocks (a nail going in): count, spacing and pitch vary per trade. */
function knocks(v, out, t, { count = 3, gap = 0.11, freq = 190, gain = 0.1 } = {}) {
  let end = t;
  for (let i = 0; i < count; i++) {
    const at = t + i * gap;
    v.noise(out, at, { gain: gain * 0.8, attack: 0.002, release: 0.05, filter: { type: 'bandpass', freq: 950 + i * 60, q: 2 } });
    end = v.tone(out, at, { freq: freq * (1 + i * 0.04), type: 'triangle', gain, attack: 0.002, release: 0.07 });
  }
  return end;
}

/**
 * Building-site sounds, one per category, each ending in that building's "personality".
 * `short` (upgrades) keeps just the site noise before the level-up fanfare.
 */
const CONSTRUCTION = {
  // Houses: a hammer driving nails, then a friendly "ding-dong" doorbell.
  residential(v, out, t, { short }) {
    const end = knocks(v, out, t, { count: 3, gap: 0.12, freq: 210 });
    if (short) return end;
    v.bell(out, end + 0.05, { freq: 784, gain: 0.06, release: 0.7 });
    return v.bell(out, end + 0.33, { freq: 622.25, gain: 0.06, release: 0.9 });
  },
  // Shops: a power drill whirr, then the cash register "ka-ching".
  commercial(v, out, t, { short }) {
    const end = v.tone(out, t, { freq: 180, to: 420, type: 'sawtooth', gain: 0.03, attack: 0.02, hold: 0.18, release: 0.08, filter: { type: 'lowpass', freq: 1400 } });
    v.noise(out, t, { gain: 0.03, attack: 0.02, hold: 0.18, release: 0.08, filter: { type: 'bandpass', freq: 3000, q: 1.5 } });
    if (short) return end;
    v.noise(out, end + 0.04, { gain: 0.06, attack: 0.001, release: 0.05, filter: { type: 'highpass', freq: 3000 } });
    v.bell(out, end + 0.08, { freq: 1760, gain: 0.05, release: 0.6 });
    return v.bell(out, end + 0.14, { freq: 2637, gain: 0.04, release: 0.7 });
  },
  // Parks: two shovels of earth, a leafy rustle, then birdsong over a bright pentatonic lift.
  park(v, out, t, { short, reduced }) {
    let end = t;
    for (const at of [t, t + 0.22]) {
      end = v.noise(out, at, { gain: 0.07, attack: 0.01, release: 0.14, filter: { type: 'bandpass', freq: 700, to: 300, q: 1.1 } });
    }
    if (short) return end;
    v.noise(out, end, { gain: 0.03, attack: 0.04, release: 0.3, filter: { type: 'highpass', freq: 4200 } });
    [587.33, 659.25, 880, 987.77].forEach((f, i) => { end = v.tone(out, end + 0.02 + i * 0.07, { freq: f, gain: 0.04, attack: 0.004, release: 0.25 }); });
    if (!reduced) for (let i = 0; i < 3; i++) v.tone(out, t + 0.45 + i * 0.1, { freq: 3100 + i * 180, to: 3900, gain: 0.014, attack: 0.008, release: 0.06, pan: 0.3 });
    return end;
  },
  // Civic buildings: a heavy stone block set down, then a stately brass call.
  civic(v, out, t, { short }) {
    v.tone(out, t, { freq: 95, to: 55, gain: 0.2, attack: 0.003, release: 0.25 });
    let end = v.noise(out, t, { gain: 0.06, attack: 0.002, release: 0.18, filter: { type: 'lowpass', freq: 600 } });
    if (short) return end;
    [[392, 0], [523.25, 0.16], [659.25, 0.32]].forEach(([f, dt]) => {
      end = v.tone(out, t + 0.28 + dt, { freq: f, type: 'sawtooth', gain: 0.04, attack: 0.02, hold: dt === 0.32 ? 0.2 : 0.05, release: 0.25, filter: { type: 'lowpass', freq: 1800 } });
    });
    return end;
  },
  // Industry: clanking metal, a hiss of steam and a low machine hum spinning up.
  industrial(v, out, t, { short }) {
    [0, 0.13, 0.2].forEach((dt, i) => v.bell(out, t + dt, { freq: 330 + i * 70, gain: 0.05, release: 0.25 }));
    let end = v.noise(out, t + 0.28, { gain: 0.03, attack: 0.05, release: 0.4, filter: { type: 'bandpass', freq: 4500, q: 0.8 } });
    if (short) return end;
    end = Math.max(end, v.tone(out, t + 0.25, { freq: 55, to: 90, type: 'sawtooth', gain: 0.05, attack: 0.08, hold: 0.2, release: 0.3, filter: { type: 'lowpass', freq: 400 } }));
    return end;
  },
  // Landmarks: a crane swinging into place (rising whoosh) and a big celebratory fanfare.
  landmark(v, out, t, { short, reduced }) {
    let end = v.noise(out, t, { gain: 0.05, attack: 0.2, release: 0.2, filter: { type: 'bandpass', freq: 400, to: 2400, q: 1.2 } });
    if (short) return end;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      end = v.tone(out, end + i * 0.09, { freq: f, type: 'triangle', gain: 0.09, attack: 0.004, hold: i === 3 ? 0.15 : 0, release: 0.2 });
    });
    v.bell(out, end - 0.1, { freq: 1046.5, gain: 0.05, release: 1.1 });
    if (!reduced) v.noise(out, end - 0.1, { gain: 0.03, attack: 0.02, release: 0.6, filter: { type: 'highpass', freq: 7000 } });
    return end;
  },
  // Anything else (a redevelopment restore, unknown type): two knocks and a warm chord.
  default(v, out, t) {
    const at = knocks(v, out, t, { count: 2, gap: 0.09, freq: 190, gain: 0.12 });
    let end = at;
    for (const f of [392, 493.88, 587.33]) end = v.tone(out, at + 0.11, { freq: f, gain: 0.055, attack: 0.006, release: 0.42 });
    return end;
  },
};

/** A city event's own sound, by event id (config.js CITY_EVENTS). */
const EVENT_SOUNDS = {
  // Rain drumming on the table, with a far roll of thunder.
  'heavy-rain'(v, out, t, { reduced }) {
    v.tone(out, t, { freq: 70, to: 45, gain: 0.08, attack: 0.3, release: 1.2 });
    let end = v.noise(out, t, { gain: 0.05, attack: 0.2, hold: 0.6, release: 0.6, filter: { type: 'highpass', freq: 1800 } });
    if (!reduced) for (let i = 0; i < 8; i++) end = Math.max(end, v.tone(out, t + 0.1 + i * 0.13, { freq: 1800 + (i % 3) * 400, gain: 0.02, attack: 0.001, release: 0.03 }));
    return end;
  },
  // A howling wind and sleigh bells.
  snowstorm(v, out, t, { reduced }) {
    let end = v.noise(out, t, { gain: 0.12, attack: 0.3, hold: 0.3, release: 0.7, filter: { type: 'bandpass', freq: 500, to: 1400, q: 2.5 }, pan: reduced ? 0 : [-0.6, 0.6, t, t + 1.3] });
    for (let i = 0; i < 6; i++) end = Math.max(end, v.tone(out, t + 0.3 + i * 0.09, { freq: 3520 + (i % 2) * 330, gain: 0.03, attack: 0.001, release: 0.12 }));
    return end;
  },
  // A fire engine's two-tone siren over crackling flames.
  fire(v, out, t, { reduced }) {
    let end = t;
    [740, 587.33, 740, 587.33].forEach((f, i) => {
      end = v.tone(out, t + i * 0.22, { freq: f, type: 'square', gain: 0.03, attack: 0.02, hold: 0.14, release: 0.05, filter: { type: 'lowpass', freq: 1600 } });
    });
    if (!reduced) for (let i = 0; i < 7; i++) v.noise(out, t + 0.05 + i * 0.12, { gain: 0.04, attack: 0.001, release: 0.03, filter: { type: 'bandpass', freq: 2500 + i * 200, q: 3 } });
    return end;
  },
  // An electric zap, then everything winding down to a click.
  'power-outage'(v, out, t) {
    v.noise(out, t, { gain: 0.06, attack: 0.001, release: 0.1, filter: { type: 'bandpass', freq: 4000, q: 4 } });
    v.tone(out, t, { freq: 120, type: 'sawtooth', gain: 0.04, attack: 0.001, release: 0.12, filter: { type: 'lowpass', freq: 3000 } });
    const end = v.tone(out, t + 0.12, { freq: 440, to: 60, type: 'triangle', gain: 0.07, attack: 0.01, release: 0.8 });
    return v.tone(out, end, { freq: 1500, gain: 0.03, attack: 0.001, release: 0.03 });
  },
  // Party horns, fireworks popping and a festive arpeggio.
  'city-festival'(v, out, t, { reduced }) {
    v.tone(out, t, { freq: 440, to: 660, type: 'sawtooth', gain: 0.035, attack: 0.02, release: 0.25, filter: { type: 'lowpass', freq: 2000 } });
    let end = t;
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => { end = v.tone(out, t + 0.25 + i * 0.07, { freq: f, type: 'triangle', gain: 0.07, attack: 0.003, release: 0.18 }); });
    if (!reduced) for (let i = 0; i < 3; i++) v.noise(out, t + 0.35 + i * 0.2, { gain: 0.07, attack: 0.001, release: 0.12, filter: { type: 'lowpass', freq: 900 }, pan: i - 1 });
    return end;
  },
  // A busy building site: a flurry of hammers and a "ta-da!".
  'housing-boom'(v, out, t) {
    const at = knocks(v, out, t, { count: 5, gap: 0.08, freq: 230, gain: 0.08 });
    v.tone(out, at + 0.05, { freq: 783.99, type: 'triangle', gain: 0.07, attack: 0.004, release: 0.12 });
    return v.tone(out, at + 0.17, { freq: 1046.5, type: 'triangle', gain: 0.08, attack: 0.004, hold: 0.12, release: 0.35 });
  },
  // Sparkling chimes cascading up, with birdsong.
  'beautification-grant'(v, out, t, { reduced }) {
    let end = t;
    [1174.66, 1318.51, 1567.98, 1760, 2093].forEach((f, i) => { end = v.bell(out, t + i * 0.08, { freq: f, gain: 0.03, release: 0.6 }); });
    if (!reduced) for (let i = 0; i < 3; i++) v.tone(out, t + 0.5 + i * 0.11, { freq: 3000 + i * 250, to: 3800, gain: 0.014, attack: 0.008, release: 0.06 });
    return end;
  },
  // A cash register "ka-ching" and a shower of coins.
  'economic-boom'(v, out, t) {
    v.noise(out, t, { gain: 0.06, attack: 0.001, release: 0.05, filter: { type: 'highpass', freq: 3000 } });
    v.bell(out, t + 0.05, { freq: 1760, gain: 0.06, release: 0.6 });
    let end = t;
    for (let i = 0; i < 6; i++) end = v.tone(out, t + 0.25 + i * 0.06, { freq: 2093 * (1 + (i % 3) * 0.06), gain: 0.04, attack: 0.001, release: 0.12 });
    return end;
  },
  // The sad trombone: "wah, wah, wah, waaah".
  recession(v, out, t) {
    let end = t;
    [[392, 0], [369.99, 0.3], [349.23, 0.6]].forEach(([f, dt]) => {
      end = v.tone(out, t + dt, { freq: f, type: 'sawtooth', gain: 0.045, attack: 0.03, hold: 0.14, release: 0.08, filter: { type: 'lowpass', freq: 900 } });
    });
    return v.tone(out, t + 0.9, { freq: 329.63, to: 300, type: 'sawtooth', gain: 0.045, attack: 0.03, hold: 0.45, release: 0.3, filter: { type: 'lowpass', freq: 900 } });
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
  setRepeat = (fn, ms) => setInterval(fn, ms),
  clearRepeat = (id) => clearInterval(id),
  random = Math.random,
  osReducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  createAudio = typeof globalThis.Audio === 'function' ? (url) => new globalThis.Audio(url) : null,
  createMusic = createMusicController,
  tracks = MUSIC_TRACKS,
} = {}) {
  const prefs = { sound: true, masterVolume: 80, sfxVolume: 80, ambience: true, ambienceVolume: 50, music: true, musicVolume: 60, reducedMotion: false };
  const scene = { name: 'title', paused: false, hidden: false };
  let ac = null;
  let bus = null; // { master, sfx, ambience, noise, brown, v }
  let unlocked = false;
  let failed = false;
  let amb = null; // running ambience: { sources, timer, stopTimer }
  let music = null; // the music controller (once the context exists)
  let musicHidden = false;

  const reduced = () => prefs.reducedMotion || osReducedMotion();
  const masterLevel = () => (prefs.sound && !scene.hidden ? clamp01(prefs.masterVolume / 100) : 0);
  const sfxLevel = () => clamp01(prefs.sfxVolume / 100);
  const ambienceWanted = () => prefs.sound && prefs.ambience && prefs.ambienceVolume > 0
    && scene.name === 'game' && !scene.paused && !scene.hidden;
  // Ambience is a quiet background layer: full slider = 45% of effects loudness.
  const ambienceLevel = () => (ambienceWanted() ? clamp01(prefs.ambienceVolume / 100) * 0.45 : 0);
  const musicOn = () => prefs.sound && prefs.music && prefs.musicVolume > 0;
  const musicLevel = () => (musicOn() ? clamp01(prefs.musicVolume / 100) * MUSIC_MIX : 0);
  /** The theme the current screen wants: none during the intro, the menu theme in the pause menu. */
  const musicTheme = () => {
    if (!musicOn() || scene.name === 'intro') return null;
    return scene.name === 'game' && !scene.paused ? 'game' : 'menu';
  };

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
      const musicBus = ac.createGain();
      musicBus.gain.value = 0;
      sfx.connect(master);
      ambience.connect(master);
      musicBus.connect(master);
      const noise = makeNoise(1, false);
      bus = { master, sfx, ambience, music: musicBus, noise, brown: makeNoise(4, true), v: voices(ac, noise, typeof ac.createStereoPanner === 'function') };
      if (createAudio && typeof ac.createMediaElementSource === 'function') {
        try {
          music = createMusic({ tracks, ctx: ac, bus: musicBus, createAudio, timers: { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setRepeat, clearInterval: clearRepeat } });
        } catch {
          music = null; // the game plays on without music
        }
      }
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
      glide(bus.music.gain, musicLevel(), QUICK);
      if (ambienceWanted()) startAmbience();
      else stopAmbienceSoon();
      if (music) {
        if (scene.hidden !== musicHidden) {
          musicHidden = scene.hidden;
          if (musicHidden) music.suspend();
          else music.resume();
        }
        const theme = musicTheme();
        if (theme) music.play(theme);
        else music.stop();
      }
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
      safely(() => music?.retry());
    },
    /** Applies saved settings: { sound, masterVolume, sfxVolume, ambience, ambienceVolume, music, musicVolume, reducedMotion }. */
    configure(settings = {}) {
      for (const key of Object.keys(prefs)) if (key in settings) prefs[key] = settings[key];
      apply();
    },
    /** 'start' | 'intro' | 'title' | 'game' | …: ambience plays only in the game; music follows (see musicTheme). */
    setScene(name) {
      scene.name = name;
      apply();
    },
    /** Pause menu open: ambience fades out and the music crossfades to the menu theme; back on close. */
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
     * @param opts   { intensity: capture chain length, kind: event kind, id: building category or event id }
     */
    play(name, { intensity = 1, kind, id } = {}) {
      if (!RECIPES[name] || !prefs.sound || !unlocked || scene.hidden) return false;
      return Boolean(safely(() => {
        if (!ensureContext()) return false;
        if (ac.state === 'suspended') ac.resume().catch(() => {});
        RECIPES[name](bus.v, bus.sfx, ac.currentTime + 0.01, { intensity, kind, id, reduced: reduced() });
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
        levels: { master: masterLevel(), sfx: sfxLevel(), ambience: ambienceLevel(), music: musicLevel() },
        music: { theme: musicTheme(), ...(safely(() => music?.state) ?? { active: null, playing: [], failed: [], blocked: false }) },
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
  // Interface sounds: a click for buttons, a "pip" for choosing an option (radio, switch, list).
  // The board's roads have their own paving sounds; `data-sfx="none"` opts anything else out.
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('button, [role="button"], summary');
    if (!el || el.disabled || el.closest('#board, [data-sfx="none"]')) return;
    audio.play('click');
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches?.('input[type="radio"], input[type="checkbox"], select') || el.closest('[data-sfx="none"]')) return;
    audio.play('select');
  });
}

/** Shorthand used by the game views. */
export const play = (name, opts) => audio.play(name, opts);
