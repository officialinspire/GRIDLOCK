/** Compact bonus + protection lines shared by the inspector and the build panel. */
import { h } from './dom.js';
import { createSprite } from '../assets.js';
import { formatCash } from '../core/economy.js';
import { isProtected } from '../core/bonuses.js';
import { blockLabel } from '../core/board.js';

const labelOf = (id) => {
  const m = /^r(\d+)c(\d+)$/.exec(id);
  return m ? blockLabel(Number(m[1]), Number(m[2])) : id;
};

/** "★ Residential district +20% · +$60" lines, or null when there are none. */
export function bonusList(block) {
  const items = (block.bonuses ?? []).map((b) =>
    h('li', { class: 'bonus-line', dataset: { bonus: b.id }, title: `${b.label}: +${b.percent}% of base income` },
      h('span', { class: 'bonus-line__star', 'aria-hidden': 'true' }, '★'),
      h('span', { class: 'bonus-line__label' }, b.label),
      h('span', { class: 'bonus-line__pct' }, `+${b.percent}%`),
      h('span', { class: 'bonus-line__amt' }, `+${formatCash(b.amount)}`),
    ));
  if (isProtected(block)) {
    const others = block.protectedBy.filter((id) => id !== block.id).map(labelOf);
    items.push(h('li', { class: 'bonus-line bonus-line--shield', dataset: { bonus: 'protection' } },
      createSprite('title:shield', { className: 'bonus-line__shield' }),
      h('span', { class: 'bonus-line__label' },
        others.length ? `Protected by civic ${others.join(', ')}` : 'Civic protection zone'),
    ));
  }
  return items.length ? h('ul', { class: 'bonus-list', 'aria-label': 'Bonuses' }, items) : null;
}
