/** Settings screen: binds the form to persisted settings. */
import { $ } from './dom.js';
import { loadSettings, saveSettings, normalizeSettings, BOOLEAN_SETTINGS, VOLUME_SETTINGS } from '../core/settings.js';
import { bus } from '../core/bus.js';
import { audio } from './audio.js';
import { haptics } from './haptics.js';

let settings = loadSettings();

export function getSettings() {
  return { ...settings };
}

export function applySettingsToDocument(s = settings) {
  const root = document.documentElement;
  root.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
  root.dataset.coords = s.showCoords ? 'on' : 'off';
  audio.configure(s);
  haptics.configure(s);
}

/** Reads the controls directly: FormData would drop the disabled ones (e.g. ambience while muted). */
function readForm(form) {
  const raw = {};
  for (const key of BOOLEAN_SETTINGS) raw[key] = form.elements[key].checked;
  for (const key of VOLUME_SETTINGS) raw[key] = form.elements[key].valueAsNumber;
  return normalizeSettings(raw);
}

/** Percent labels, screen-reader value text, and greyed-out rows that don't apply. */
function syncSoundControls(form, s) {
  for (const key of VOLUME_SETTINGS) {
    const input = form.elements[key];
    input.setAttribute('aria-valuetext', `${input.value}%`);
    const out = form.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = `${input.value}%`;
  }
  form.querySelectorAll('[data-needs-sound]').forEach((row) => {
    const off = !s.sound || (row.hasAttribute('data-needs-ambience') && !s.ambience);
    row.classList.toggle('is-disabled', off);
    row.querySelectorAll('input').forEach((input) => { input.disabled = off; });
  });
}

function writeForm(form, s) {
  for (const key of BOOLEAN_SETTINGS) form.elements[key].checked = s[key];
  for (const key of VOLUME_SETTINGS) form.elements[key].value = String(s[key]);
  syncSoundControls(form, s);
}

function commit(next) {
  settings = normalizeSettings(next);
  saveSettings(settings);
  applySettingsToDocument();
  bus.emit('settings:changed', getSettings());
}

/** Changes and saves some settings from elsewhere (e.g. the in-game mute button), keeping the form in sync. */
export function updateSettings(patch) {
  commit({ ...settings, ...patch });
  const form = $('#settings-form');
  if (form) writeForm(form, settings);
}

export function initSettingsView() {
  const form = $('#settings-form');
  // Desktop and iPhone (no Vibration API) never see the haptics switch.
  $('#haptics-row').hidden = !haptics.supported();
  writeForm(form, settings);
  applySettingsToDocument();

  form.addEventListener('submit', (e) => e.preventDefault());
  // While dragging a slider: live label + live volume (saved when released).
  form.addEventListener('input', (e) => {
    if (!VOLUME_SETTINGS.includes(e.target.name)) return;
    const live = readForm(form);
    syncSoundControls(form, live);
    audio.configure(live);
  });
  form.addEventListener('change', (e) => {
    commit(readForm(form));
    syncSoundControls(form, settings);
    // Let players hear the level they picked.
    if (['masterVolume', 'sfxVolume'].includes(e.target.name)) audio.play('coins');
    if (e.target.name === 'sound' && settings.sound) audio.play('tick');
    if (e.target.name === 'haptics' && settings.haptics) haptics.buzz('build');
  });
}
