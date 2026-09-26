/**
 * Tiny synthesised sound effects (Web Audio, no files to download).
 * Honours the "Sound effects" setting and only starts audio after a user
 * gesture, as mobile browsers require. Failures are silent by design.
 */
let ctx = null;
let enabled = true;

/** name → list of [frequency Hz, start s, duration s, type, gain] notes. */
const SOUNDS = {
  tick: [[720, 0, 0.035, 'sine', 0.035]],
  pave: [[180, 0, 0.06, 'triangle', 0.18], [120, 0.03, 0.08, 'triangle', 0.12]],
  capture: [[523, 0, 0.1, 'triangle', 0.16], [659, 0.08, 0.1, 'triangle', 0.16], [784, 0.16, 0.16, 'triangle', 0.16]],
  build: [[392, 0, 0.08, 'square', 0.07], [523, 0.07, 0.12, 'square', 0.07]],
  coins: [[988, 0, 0.05, 'sine', 0.12], [1319, 0.05, 0.09, 'sine', 0.12]],
  event: [[330, 0, 0.12, 'sawtooth', 0.06], [262, 0.12, 0.2, 'sawtooth', 0.06]],
  error: [[140, 0, 0.12, 'square', 0.06]],
  win: [[523, 0, 0.12, 'triangle', 0.16], [659, 0.12, 0.12, 'triangle', 0.16], [784, 0.24, 0.12, 'triangle', 0.16], [1047, 0.36, 0.3, 'triangle', 0.16]],
};

export function setSoundEnabled(on) {
  enabled = Boolean(on);
}

function audio() {
  if (!ctx) {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function play(name, intensity = 1) {
  if (!enabled || !SOUNDS[name] || !navigator.userActivation?.hasBeenActive) return;
  try {
    const ac = audio();
    if (!ac) return;
    const t0 = ac.currentTime + 0.01;
    const lift = Math.min(1.12, 1 + Math.max(0, intensity - 1) * 0.025);
    const volume = Math.min(1.18, 1 + Math.max(0, intensity - 1) * 0.035);
    for (const [freq, start, dur, type, gain] of SOUNDS[name]) {
      const osc = ac.createOscillator();
      const amp = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq * lift;
      amp.gain.setValueAtTime(0.0001, t0 + start);
      amp.gain.exponentialRampToValueAtTime(gain * volume, t0 + start + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(amp).connect(ac.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
  } catch {
    /* audio is optional */
  }
}
