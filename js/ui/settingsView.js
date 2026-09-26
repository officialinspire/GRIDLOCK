/** Settings screen: binds the form to persisted settings. */
import { $ } from './dom.js';
import { loadSettings, saveSettings, normalizeSettings } from '../core/settings.js';
import { bus } from '../core/bus.js';
import { setSoundEnabled } from './sfx.js';

let settings = loadSettings();

export function getSettings() {
  return { ...settings };
}

export function applySettingsToDocument(s = settings) {
  const root = document.documentElement;
  root.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
  root.dataset.coords = s.showCoords ? 'on' : 'off';
  setSoundEnabled(s.sound);
}

function readForm(form) {
  const data = new FormData(form);
  return normalizeSettings({
    sound: data.has('sound'),
    confirmTaps: data.has('confirmTaps'),
    reducedMotion: data.has('reducedMotion'),
    showCoords: data.has('showCoords'),
  });
}

function writeForm(form, s) {
  for (const key of ['sound', 'confirmTaps', 'reducedMotion', 'showCoords']) form.elements[key].checked = s[key];
}

export function initSettingsView() {
  const form = $('#settings-form');
  writeForm(form, settings);
  applySettingsToDocument();

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', () => {
    settings = readForm(form);
    saveSettings(settings);
    applySettingsToDocument();
    bus.emit('settings:changed', getSettings());
  });
}
