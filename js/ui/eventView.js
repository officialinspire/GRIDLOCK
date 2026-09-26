/**
 * City event presentation: the papercraft event card, the active-event strip,
 * per-block impact info for the board and inspector.
 */
import { $, h } from './dom.js';
import { createSprite } from '../assets.js';
import { PLAYER_PRESETS } from '../config.js';
import { getBlockById } from '../core/board.js';
import { getEventDef, eventFootprint, roundsLeft, blockImpacts } from '../core/events.js';
import { getPlayer } from '../core/game.js';

const KIND_LABEL = { emergency: 'City Emergency', boon: 'Good News', downturn: 'Downturn' };

const pct = (m) => {
  const d = Math.round((m - 1) * 100);
  return d === -100 ? 'no income' : `${d > 0 ? '+' : '−'}${Math.abs(d)}% income`;
};

const roundsText = (n) => `${n} round${n === 1 ? '' : 's'}`;

/** How a block is touched by active events: 'hurt' | 'boost' | 'shielded' | null, plus the lead impact. */
export function blockEventState(game, block) {
  const impacts = blockImpacts(game, block);
  if (!impacts.length) return { state: null, lead: null };
  const live = impacts.filter((i) => !i.mitigated);
  const hurt = live.find((i) => i.multiplier < 1);
  const boost = live.find((i) => i.multiplier > 1);
  if (hurt) return { state: 'hurt', lead: hurt };
  if (boost) return { state: 'boost', lead: boost };
  return { state: 'shielded', lead: impacts[0] };
}

/** Inspector lines: "🌧 Heavy Rain · no income · 1 round" / "🛡 Snowstorm · shielded by civic". */
export function eventLines(game, block) {
  const impacts = blockImpacts(game, block);
  if (!impacts.length) return null;
  return h('ul', { class: 'bonus-list event-lines', 'aria-label': 'City events' },
    impacts.map((i) => h('li', { class: `event-line event-line--${i.mitigated ? 'shielded' : i.def.kind}` },
      createSprite(i.mitigated ? 'title:shield' : i.def.sprite, { className: 'event-line__icon' }),
      h('span', { class: 'event-line__name' }, i.def.name),
      h('span', { class: 'event-line__fx' }, i.mitigated ? 'shielded by civic' : pct(i.multiplier)),
      h('span', { class: 'event-line__left' }, roundsText(roundsLeft(game, i.instance))),
    )));
}

function blockChip(game, id, shielded) {
  const block = getBlockById(game.board, id);
  const owner = block?.ownerSeat ? getPlayer(game, block.ownerSeat) : null;
  const color = owner ? PLAYER_PRESETS[owner.seat - 1].color : 'none';
  return h('li', { class: `event-chip event-chip--${color}${shielded ? ' is-shielded' : ''}` },
    shielded && createSprite('title:shield', { className: 'event-chip__shield' }),
    h('strong', {}, block?.label ?? id),
    owner && h('span', {}, owner.name),
  );
}

function cardContent(game, instance, expired = []) {
  const def = getEventDef(instance.id);
  const { affected, mitigated } = eventFootprint(game, instance);
  const left = roundsLeft(game, instance);
  const until = instance.endRound === instance.startRound
    ? `Round ${instance.startRound} only`
    : `Rounds ${instance.startRound}–${instance.endRound}`;

  const scope = [];
  if (affected.length || mitigated.length) {
    scope.push(h('p', { class: 'event-card__scope' },
      `${affected.length} block${affected.length === 1 ? '' : 's'} affected`,
      mitigated.length ? ` · ${mitigated.length} shielded by civic` : ''));
    const MAX = 8;
    const chips = [...affected.map((id) => [id, false]), ...mitigated.map((id) => [id, true])];
    scope.push(h('ul', { class: 'event-card__blocks' },
      chips.slice(0, MAX).map(([id, s]) => blockChip(game, id, s)),
      chips.length > MAX && h('li', { class: 'event-chip event-chip--more' }, `+${chips.length - MAX} more`)));
  } else {
    scope.push(h('p', { class: 'event-card__scope event-card__scope--none' },
      def.costs ? 'Affects construction prices.' : 'No developed blocks affected yet.'));
  }

  return [
    h('div', { class: `event-card__tag event-card__tag--${def.kind}` }, KIND_LABEL[def.kind] ?? 'City Event'),
    createSprite('title:pin-red', { className: 'event-card__pin' }),
    createSprite(def.sprite, { className: 'event-card__art' }),
    h('h3', { id: 'event-title', class: 'event-card__name' }, def.name),
    h('p', { class: 'event-card__text' }, def.text),
    h('p', { class: 'event-card__duration' },
      createSprite('icons:clock', { className: 'event-card__clock' }),
      `${roundsText(left)} left · ${until}`),
    def.mitigation === 'civic' && h('p', { class: 'event-card__mitigation' },
      createSprite('title:shield', { className: 'event-card__shield' }),
      'Civic buildings shield nearby blocks they protect.'),
    ...scope,
    expired.length > 0 && h('p', { class: 'event-card__expired' },
      `Ended: ${expired.map((e) => getEventDef(e.id)?.name ?? e.id).join(', ')}`),
  ];
}

export function showEventCard(game, instance, expired = []) {
  const dialog = $('#event-dialog');
  const def = getEventDef(instance.id);
  dialog.dataset.kind = def.kind;
  $('#event-body').replaceChildren(...cardContent(game, instance, expired).filter(Boolean));
  if (!dialog.open) dialog.showModal();
  $('#event-continue').focus();
}

export function renderEventStrip(game) {
  const strip = $('#event-strip');
  const active = game.events.active;
  strip.hidden = active.length === 0;
  strip.replaceChildren(...active.map((instance) => {
    const def = getEventDef(instance.id);
    const left = roundsLeft(game, instance);
    return h('button', {
      type: 'button',
      class: `event-pill event-pill--${def.kind}`,
      dataset: { eventUid: instance.uid },
      'aria-label': `${def.name}, ${roundsText(left)} left. Show details`,
    },
      createSprite(def.sprite, { className: 'event-pill__icon' }),
      h('span', { class: 'event-pill__name' }, def.name),
      h('span', { class: 'event-pill__left' }, `${left}r`),
    );
  }));
}

export function initEventView({ getGame }) {
  $('#event-continue').addEventListener('click', () => $('#event-dialog').close());
  $('#event-strip').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-event-uid]');
    const game = getGame();
    if (!pill || !game) return;
    const instance = game.events.active.find((x) => String(x.uid) === pill.dataset.eventUid);
    if (instance) showEventCard(game, instance);
  });
}
