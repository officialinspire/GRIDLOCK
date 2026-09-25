/**
 * City events catalogue (storms, festivals, …). Drawn at round end in a later
 * phase; for now this defines the data shape and a deterministic draw helper.
 * `effect` sprites reference effects.png via js/assets.js.
 */

export const CITY_EVENTS = Object.freeze([
  { id: 'rainstorm', name: 'Rainstorm', text: 'Streets flood. Parks pay no income this round.', effect: 'effects:rain' },
  { id: 'snow-day', name: 'Snow Day', text: 'Schools close and shoppers stay home.', effect: 'effects:snow' },
  { id: 'windstorm', name: 'Windstorm', text: 'Loose signs everywhere. Minor repair costs.', effect: 'effects:wind' },
  { id: 'autumn-fair', name: 'Autumn Fair', text: 'Crowds visit the parks. Bonus park income.', effect: 'effects:leaves' },
  { id: 'heat-wave', name: 'Heat Wave', text: 'Everyone wants ice cream. Shops earn extra.', effect: 'effects:sunburst' },
  { id: 'city-festival', name: 'City Festival', text: 'Confetti downtown! Downtown blocks pay a bonus.', effect: 'effects:confetti' },
  { id: 'boom-town', name: 'Boom Town', text: 'Land prices surge across the city.', effect: 'effects:boost' },
]);

export function getCityEvent(id) {
  return CITY_EVENTS.find((e) => e.id === id) ?? null;
}

/** Picks an event using an injectable RNG (Math.random by default). */
export function drawCityEvent(rng = Math.random) {
  return CITY_EVENTS[Math.floor(rng() * CITY_EVENTS.length) % CITY_EVENTS.length];
}
