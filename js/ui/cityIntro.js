/**
 * The EXPANSION → CITY transition card: "THE GRID IS COMPLETE — BUILD THE CITY", with the City
 * rounds and actions. Short and skippable (button, Escape, a tap outside the card) and it
 * dismisses itself after a few seconds, so it can never hold up the table (CPU turns wait while
 * it is open, as for any dialog). Reduced motion (the setting or the OS) shows it without
 * animation (css/base.css).
 */
import { $, h } from './dom.js';

const AUTO_DISMISS_MS = 4500;
let timer = null;
let after = null;

/**
 * Shows the card. `status` is eraStatus(game); `finalMover` names the mayor who paved the last
 * road (their turn already had its Development Action). `onClose` runs once when it closes.
 */
export function showCityIntro({ rounds, actionsPerTurn }, { finalMover = null, onClose = () => {} } = {}) {
  const dialog = $('#city-intro-dialog');
  $('#city-intro-facts').replaceChildren(
    h('li', {}, h('strong', {}, String(rounds)), ` City round${rounds === 1 ? '' : 's'} to go`),
    h('li', {}, h('strong', {}, String(actionsPerTurn)), ` City Action${actionsPerTurn === 1 ? '' : 's'} per turn`),
    h('li', {}, 'No more roads: build, upgrade, sell, redevelop or take over'),
  );
  $('#city-intro-note').textContent = finalMover
    ? `${finalMover} paved the final road with this turn's Development Action, so their turn just ends; full City turns start with the next mayor.`
    : '';
  after = onClose;
  clearTimeout(timer);
  timer = setTimeout(closeCityIntro, AUTO_DISMISS_MS);
  if (!dialog.open) dialog.showModal();
  $('#city-intro-go').focus();
}

export function closeCityIntro() {
  clearTimeout(timer);
  timer = null;
  const dialog = $('#city-intro-dialog');
  if (dialog?.open) dialog.close();
}

/** Closes the card without running its follow-up (a new game, leaving, Continue). */
export function cancelCityIntro() {
  after = null;
  closeCityIntro();
}

export const isCityIntroOpen = () => Boolean($('#city-intro-dialog')?.open);

export function initCityIntro() {
  const dialog = $('#city-intro-dialog');
  $('#city-intro-go').addEventListener('click', closeCityIntro);
  // A tap on the backdrop skips it too; Escape closes the dialog natively.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeCityIntro(); });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    timer = null;
    const next = after;
    after = null;
    next?.();
  });
}
