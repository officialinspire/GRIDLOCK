import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioManager, SOUND_NAMES, CHAIN } from '../../js/ui/audio.js';
import { normalizeSettings, loadSettings } from '../../js/core/settings.js';
import { DEFAULT_SETTINGS } from '../../js/config.js';

/** A recording fake of the Web Audio API: every node, parameter automation and start. */
function fakeWebAudio({ throwOnCreate = false } = {}) {
  const log = { contexts: [], gains: [], oscillators: [], sources: [], panners: [], resumes: 0, suspends: 0 };
  const param = (value = 0) => {
    const p = { value, events: [] };
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
      p[m] = (v, t, tc) => { p.events.push([m, v, t, tc]); if (m === 'setValueAtTime') p.value = v; return p; };
    }
    return p;
  };
  const node = (extra = {}) => ({ connect: (n) => n, disconnect() {}, ...extra });
  class FakeContext {
    constructor() {
      if (throwOnCreate) throw new Error('blocked');
      this.state = 'running';
      this.currentTime = 1;
      this.sampleRate = 8000;
      this.destination = node();
      log.contexts.push(this);
    }
    resume() { log.resumes++; this.state = 'running'; return Promise.resolve(); }
    suspend() { log.suspends++; this.state = 'suspended'; return Promise.resolve(); }
    createGain() { const g = node({ gain: param(1) }); log.gains.push(g); return g; }
    createDynamicsCompressor() { return node({ threshold: param(), ratio: param() }); }
    createStereoPanner() { const p = node({ pan: param() }); log.panners.push(p); return p; }
    createBiquadFilter() { return node({ type: 'lowpass', frequency: param(), Q: param() }); }
    createBuffer(ch, len) { const data = new Float32Array(len); return { getChannelData: () => data }; }
    createOscillator() {
      const osc = node({ type: 'sine', frequency: param(440), detune: param(), start(t) { osc.at = t; }, stop() {} });
      log.oscillators.push(osc);
      return osc;
    }
    createBufferSource() {
      const src = node({ playbackRate: param(1), loop: false, start() { src.started = true; }, stop() { src.stopped = true; } });
      log.sources.push(src);
      return src;
    }
  }
  return { FakeContext, log };
}

/** Manual timers so fades and ambient scheduling are deterministic. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimer: (i) => pending.delete(i),
    runAll() { const due = [...pending.entries()]; pending.clear(); due.forEach(([, t]) => t.fn()); },
    get count() { return pending.size; },
  };
}

function setup(opts = {}) {
  const { FakeContext, log } = fakeWebAudio(opts);
  const timers = fakeTimers();
  let r = 0;
  const manager = createAudioManager({
    AudioContextClass: opts.noAudio ? undefined : FakeContext,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => ((r = (r * 9301 + 49297) % 233280) / 233280),
    osReducedMotion: () => Boolean(opts.osReduced),
  });
  return { manager, log, timers };
}

test('no autoplay: nothing is created or played before a user gesture', () => {
  const { manager, log } = setup();
  manager.configure(DEFAULT_SETTINGS);
  manager.setScene('game');
  assert.equal(manager.play('pave'), false);
  assert.equal(log.contexts.length, 0, 'no AudioContext before a gesture');
  assert.equal(manager.state().ambienceRunning, false);
  manager.unlock();
  assert.equal(log.contexts.length, 1);
  assert.equal(manager.play('pave'), true);
});

test('fails silently when Web Audio is missing or blocked', () => {
  for (const opts of [{ noAudio: true }, { throwOnCreate: true }]) {
    const { manager } = setup(opts);
    assert.doesNotThrow(() => {
      manager.unlock();
      manager.setScene('game');
      for (const name of SOUND_NAMES) assert.equal(manager.play(name), false);
      manager.setHidden(true);
      manager.setHidden(false);
    });
    assert.equal(manager.state().supported, false);
  }
  const { manager } = setup();
  manager.unlock();
  assert.equal(manager.play('no-such-sound'), false);
});

test('every sound plays and has its own recipe', () => {
  const { manager, log } = setup();
  manager.unlock();
  const signatures = new Map();
  for (const name of SOUND_NAMES) {
    const before = log.oscillators.length;
    const sourcesBefore = log.sources.length;
    assert.equal(manager.play(name), true, name);
    const oscs = log.oscillators.slice(before);
    const sig = JSON.stringify([oscs.map((o) => [o.type, Math.round(o.frequency.events[0][1])]), log.sources.length - sourcesBefore]);
    assert.ok(oscs.length + (log.sources.length - sourcesBefore) > 0, `${name} makes sound`);
    assert.ok(![...signatures.values()].includes(sig), `${name} is distinct`);
    signatures.set(name, sig);
  }
  // Event kinds sound different too.
  const kinds = ['boon', 'emergency', 'downturn'].map((kind) => {
    const before = log.oscillators.length;
    manager.play('event', { kind });
    return JSON.stringify(log.oscillators.slice(before).map((o) => [o.type, Math.round(o.frequency.events[0][1])]));
  });
  assert.equal(new Set(kinds).size, 3);
});

test('construction sounds are unique per building type, and events per event id', async () => {
  const { CATEGORY_ORDER } = await import('../../js/core/buildings.js');
  const { CITY_EVENTS } = await import('../../js/config.js');
  const { manager, log } = setup();
  manager.unlock();
  const signature = (name, opts) => {
    const before = log.oscillators.length;
    const sources = log.sources.length;
    assert.equal(manager.play(name, opts), true);
    return JSON.stringify([log.oscillators.slice(before).map((o) => [o.type, Math.round(o.frequency.events[0][1])]), log.sources.length - sources]);
  };
  for (const name of ['build', 'upgrade']) {
    const sigs = CATEGORY_ORDER.map((id) => signature(name, { id }));
    assert.equal(new Set(sigs).size, CATEGORY_ORDER.length, `${name}: one sound per building type`);
    assert.ok(!sigs.includes(signature(name, {})), `${name}: unknown type has its own fallback`);
  }
  const ids = CITY_EVENTS.POOL.map((e) => e.id);
  const events = ids.map((id) => signature('event', { id, kind: CITY_EVENTS.POOL.find((e) => e.id === id).kind }));
  assert.equal(new Set(events).size, ids.length, 'one sound per city event');
});

/** A fake <audio> element: play() resolves (or rejects with `refuse`), records pause/play. */
function fakeMusic() {
  const elements = [];
  const createAudio = (url) => {
    const el = {
      url, paused: true, currentTime: 0, duration: 120, volume: 1, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
    };
    elements.push(el);
    return el;
  };
  return { elements, createAudio };
}

function musicSetup() {
  const { FakeContext, log } = fakeWebAudio();
  FakeContext.prototype.createMediaElementSource = function () { return { connect: (n) => n }; };
  const timers = fakeTimers();
  const { elements, createAudio } = fakeMusic();
  const manager = createAudioManager({
    AudioContextClass: FakeContext, setTimer: timers.setTimer, clearTimer: timers.clearTimer, setRepeat: () => 0, clearRepeat: () => {}, createAudio,
    tracks: { menu: 'menu.mp3', game: 'game.mp3' }, osReducedMotion: () => false,
  });
  const playing = () => elements.filter((e) => !e.paused).map((e) => e.url);
  return { manager, elements, timers, playing, log };
}

test('music: menu theme on menus and in the pause menu, gameplay theme in play, none in the intro', () => {
  const { manager, timers, playing } = musicSetup();
  manager.setScene('start');
  assert.deepEqual(playing(), [], 'no music before a gesture');
  manager.unlock();
  assert.equal(manager.state().music.theme, 'menu');
  assert.deepEqual(playing(), ['menu.mp3'], 'the start tap starts the menu theme');
  manager.setScene('intro');
  assert.equal(manager.state().music.theme, null, 'the intro video plays alone');
  timers.runAll(); // fade-outs finish
  assert.deepEqual(playing(), []);
  manager.setScene('title');
  manager.setScene('game');
  assert.equal(manager.state().music.active, 'game');
  timers.runAll();
  assert.deepEqual(playing(), ['game.mp3'], 'crossfaded to the gameplay theme');
  manager.setPaused(true);
  assert.equal(manager.state().music.active, 'menu', 'pause menu: the menu theme');
  manager.setPaused(false);
  assert.equal(manager.state().music.active, 'game');
});

test('music: its switch and volume, the master mute, and a hidden tab', () => {
  const { manager, timers, playing } = musicSetup();
  manager.configure({ ...DEFAULT_SETTINGS });
  manager.unlock();
  manager.setScene('title');
  assert.ok(manager.state().levels.music > 0);
  manager.configure({ music: false });
  assert.equal(manager.state().levels.music, 0);
  assert.equal(manager.state().music.theme, null);
  timers.runAll();
  assert.deepEqual(playing(), [], 'Music off: faded out and paused');
  manager.configure({ music: true, musicVolume: 0 });
  assert.equal(manager.state().music.theme, null, 'volume 0 counts as off');
  manager.configure({ musicVolume: 40 });
  manager.configure({ sound: false });
  assert.equal(manager.state().levels.music, 0, 'the master mute silences music too');
  manager.configure({ sound: true });
  assert.deepEqual(playing(), ['menu.mp3']);
  manager.setHidden(true);
  assert.deepEqual(playing(), [], 'hidden tab: paused in place');
  manager.setHidden(false);
  assert.deepEqual(playing(), ['menu.mp3'], 'and back on return');
});

test('music: no <audio> support means no music, and everything else still works', () => {
  const { FakeContext } = fakeWebAudio();
  const manager = createAudioManager({ AudioContextClass: FakeContext, createAudio: null, setTimer: () => 0, clearTimer: () => {} });
  manager.unlock();
  manager.setScene('game');
  assert.equal(manager.play('pave'), true);
  assert.equal(manager.state().music.active, null);
});

/** Highest pitch and voice count of one capture sound. */
function capture(manager, log, intensity) {
  const before = log.oscillators.length;
  manager.play('capture', { intensity });
  // The first oscillator is the "claimed" stamp thud; the arpeggio starts on the second.
  const oscs = log.oscillators.slice(before + 1);
  return { voices: oscs.length, top: Math.max(...oscs.map((o) => o.frequency.events[0][1])), root: oscs[0].frequency.events[0][1] };
}

test('capture chains escalate: higher, fuller, capped', () => {
  const { manager, log } = setup();
  manager.unlock();
  const [c1, c2, c3, c5, c9] = [1, 2, 3, 5, 9].map((n) => capture(manager, log, n));
  assert.ok(c2.root > c1.root && c3.root > c2.root, 'root climbs with the chain');
  assert.ok(c2.voices > c1.voices && c3.voices > c2.voices, 'more layers with the chain');
  assert.equal(c9.root, c5.root, 'escalation is capped');
  assert.ok(Math.abs(c5.root / c1.root - 2 ** ((CHAIN.MAX_STEPS * CHAIN.STEP) / 12)) < 1e-9);
});

test('reduced motion (setting or OS) keeps escalation calmer', () => {
  for (const mode of ['setting', 'os']) {
    const { manager, log } = setup({ osReduced: mode === 'os' });
    manager.unlock();
    manager.configure({ reducedMotion: mode === 'setting' });
    const c1 = capture(manager, log, 1);
    const c5 = capture(manager, log, 5);
    assert.ok(Math.abs(c5.root / c1.root - 2 ** ((CHAIN.REDUCED_MAX_STEPS * CHAIN.STEP) / 12)) < 1e-9, mode);
    assert.equal(manager.state().reduced, true);
  }
});

test('volumes: master × mute, effects, ambience map to smooth bus levels', () => {
  const { manager } = setup();
  manager.unlock();
  manager.configure({ ...DEFAULT_SETTINGS, masterVolume: 40, sfxVolume: 25, ambienceVolume: 60 });
  manager.setScene('game');
  let { levels } = manager.state();
  assert.equal(levels.master, 0.4);
  assert.equal(levels.sfx, 0.25);
  assert.ok(levels.ambience > 0 && levels.ambience < levels.sfx * 2, 'ambience stays a quiet layer');
  manager.configure({ sound: false });
  ({ levels } = manager.state());
  assert.equal(levels.master, 0, 'mute silences everything');
  assert.equal(levels.ambience, 0);
  assert.equal(manager.play('pave'), false, 'muted: no sound is scheduled');
});

test('volume changes ramp instead of jumping (no clicks)', () => {
  const { manager, log } = setup();
  manager.unlock();
  const master = log.gains[0].gain; // the master bus is the first gain node created
  assert.equal(master.events[0][0], 'setValueAtTime', 'initial level set once at creation');
  manager.configure({ masterVolume: 70 });
  const [method, value, , timeConstant] = master.events.at(-1);
  assert.equal(method, 'setTargetAtTime');
  assert.equal(value, 0.7);
  assert.ok(timeConstant > 0 && timeConstant < 0.2, 'quick but smooth');
  manager.configure({ sound: false });
  assert.deepEqual(master.events.at(-1).slice(0, 2), ['setTargetAtTime', 0], 'mute fades rather than cuts');
  // Every sound envelope starts and ends near silence.
  manager.configure({ sound: true });
  const before = log.gains.length;
  manager.play('win');
  for (const g of log.gains.slice(before)) {
    assert.ok(g.gain.events[0][1] <= 0.0002 && g.gain.events.at(-1)[1] <= 0.0002, 'envelope from/to silence');
  }
});

test('ambience: game screen only, fades for pause and background, then resumes', () => {
  const { manager, log, timers } = setup();
  manager.configure(DEFAULT_SETTINGS);
  manager.unlock();
  assert.equal(manager.state().ambienceRunning, false, 'not on the title screen');
  manager.setScene('game');
  assert.equal(manager.state().ambienceRunning, true);
  assert.ok(log.sources.some((s) => s.started), 'looping procedural bed started');
  assert.ok(manager.state().levels.ambience > 0);

  manager.setPaused(true);
  assert.equal(manager.state().levels.ambience, 0, 'pause fades ambience out');
  manager.setPaused(false);
  assert.ok(manager.state().levels.ambience > 0, 'resumes smoothly');
  assert.equal(manager.state().ambienceRunning, true, 'no restart needed after a short pause');

  manager.setHidden(true);
  assert.equal(manager.state().levels.master, 0, 'background: fade out');
  timers.runAll();
  assert.equal(log.contexts[0].state, 'suspended', 'then suspend the audio clock');
  assert.equal(manager.play('coins'), false, 'nothing plays while hidden');
  manager.setHidden(false);
  assert.equal(log.contexts[0].state, 'running');
  assert.ok(manager.state().levels.master > 0);

  manager.setScene('title');
  timers.runAll();
  assert.equal(manager.state().ambienceRunning, false, 'released after fading out on leaving the game');
});

test('ambience can be switched off or set to zero; ambient one-shots follow reduced motion', () => {
  const { manager, log, timers } = setup();
  manager.configure({ ...DEFAULT_SETTINGS, ambience: false });
  manager.unlock();
  manager.setScene('game');
  assert.equal(manager.state().ambienceRunning, false);
  manager.configure({ ambience: true, ambienceVolume: 0 });
  assert.equal(manager.state().ambienceRunning, false);
  manager.configure({ ambienceVolume: 50 });
  assert.equal(manager.state().ambienceRunning, true);
  // Fire a batch of ambient one-shots: they're placed in the stereo field, and car passes sweep across it.
  const sweeps = (panners) => panners.filter((p) => p.pan.events.some(([m]) => m === 'linearRampToValueAtTime')).length;
  for (let i = 0; i < 20; i++) timers.runAll();
  assert.ok(log.panners.length > 0, 'ambient sounds are panned');
  assert.ok(sweeps(log.panners) > 0, 'full motion: cars pass from side to side');

  const calm = setup({ osReduced: true });
  calm.manager.configure(DEFAULT_SETTINGS);
  calm.manager.unlock();
  calm.manager.setScene('game');
  for (let i = 0; i < 20; i++) calm.timers.runAll();
  assert.ok(calm.log.panners.length > 0);
  assert.equal(sweeps(calm.log.panners), 0, 'reduced motion: no moving sounds');
});

test('settings: new audio fields default sensibly, clamp, and older saves still load', () => {
  assert.deepEqual(
    [DEFAULT_SETTINGS.sound, DEFAULT_SETTINGS.ambience, DEFAULT_SETTINGS.masterVolume, DEFAULT_SETTINGS.sfxVolume, DEFAULT_SETTINGS.ambienceVolume],
    [true, true, 80, 80, 50],
  );
  const v1 = normalizeSettings({ sound: false, confirmTaps: false }); // saved before audio settings existed
  assert.equal(v1.sound, false, 'mute persists from older saves');
  assert.equal(v1.masterVolume, 80);
  assert.equal(v1.ambience, true);
  const n = normalizeSettings({ masterVolume: 150, sfxVolume: -5, ambienceVolume: 33.6, ambience: 'yes' });
  assert.deepEqual([n.masterVolume, n.sfxVolume, n.ambienceVolume, n.ambience], [100, 0, 34, true]);
  assert.equal(normalizeSettings({ masterVolume: '45' }).masterVolume, 45, 'form strings accepted');
  assert.equal(normalizeSettings({ masterVolume: NaN }).masterVolume, 80);
  const storage = new Map([['gridlock.settings.v1', JSON.stringify({ sound: false, masterVolume: 10 })]]);
  const loaded = loadSettings({ getItem: (k) => storage.get(k) ?? null });
  assert.equal(loaded.sound, false);
  assert.equal(loaded.masterVolume, 10);
});
