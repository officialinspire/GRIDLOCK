/**
 * Building catalogue: identity, category and art. Costs and income come from
 * ECONOMY.BUILDINGS in config.js so all balance numbers live in one place.
 * `sprite` references js/assets.js. Buildings aren't placeable yet.
 */
import { ECONOMY } from '../config.js';

export const CATEGORIES = Object.freeze({
  residential: { id: 'residential', label: 'Residential' },
  commercial: { id: 'commercial', label: 'Commercial' },
  civic: { id: 'civic', label: 'Civic' },
  industrial: { id: 'industrial', label: 'Industrial' },
  park: { id: 'park', label: 'Park' },
});

function b(id, name, category, sprite) {
  const econ = ECONOMY.BUILDINGS[id];
  if (!econ) throw new Error(`ECONOMY.BUILDINGS is missing "${id}"`);
  return Object.freeze({ id, name, category, cost: econ.cost, income: econ.income, sprite });
}

export const BUILDINGS = Object.freeze([
  // Residential
  b('house', 'House', 'residential', 'buildings:house'),
  b('duplex', 'Duplex', 'residential', 'buildings:duplex'),
  b('rowhouses', 'Rowhouses', 'residential', 'buildings:rowhouses'),
  b('apartments', 'Apartments', 'residential', 'buildings:apartments'),
  // Commercial
  b('corner-store', 'Corner Store', 'commercial', 'buildings:corner-store'),
  b('diner', 'Diner', 'commercial', 'buildings:diner'),
  b('convenience-store', '24/7 Store', 'commercial', 'buildings:convenience-store'),
  b('cafe', 'Café', 'commercial', 'buildings:cafe'),
  b('shop', 'Shop', 'commercial', 'buildings:shop'),
  b('market', 'Market', 'commercial', 'buildings:market'),
  b('gas-station', 'Gas Station', 'commercial', 'buildings:gas-station'),
  b('office', 'Office Tower', 'commercial', 'buildings:office'),
  // Civic
  b('school', 'School', 'civic', 'civic:school'),
  b('library', 'Library', 'civic', 'civic:library'),
  b('hospital', 'Hospital', 'civic', 'civic:hospital'),
  b('fire-station', 'Fire Station', 'civic', 'civic:fire-station'),
  b('police', 'Police Station', 'civic', 'civic:police'),
  b('city-hall', 'City Hall', 'civic', 'civic:city-hall'),
  b('train-station', 'Train Station', 'civic', 'civic:train-station'),
  b('theater', 'Theater', 'civic', 'civic:theater'),
  b('museum', 'Museum', 'civic', 'civic:museum'),
  b('stadium', 'Stadium', 'civic', 'civic:stadium'),
  b('monument', 'Monument', 'civic', 'civic:monument'),
  b('parking-garage', 'Parking Garage', 'civic', 'civic:parking-garage'),
  // Industrial
  b('warehouse', 'Warehouse', 'industrial', 'civic:warehouse'),
  b('factory', 'Factory', 'industrial', 'civic:factory'),
  b('substation', 'Power Substation', 'industrial', 'civic:substation'),
  // Parks
  b('plaza', 'Plaza', 'park', 'parks:plaza'),
  b('garden', 'Community Garden', 'park', 'parks:garden'),
  b('playground', 'Playground', 'park', 'parks:playground'),
  b('basketball-court', 'Basketball Court', 'park', 'parks:basketball-court'),
  b('fountain', 'Fountain Square', 'park', 'parks:fountain'),
  b('dog-park', 'Dog Park', 'park', 'parks:dog-park'),
  b('picnic-grove', 'Picnic Grove', 'park', 'parks:picnic-grove'),
  b('skatepark', 'Skatepark', 'park', 'parks:skatepark'),
]);

const BY_ID = new Map(BUILDINGS.map((x) => [x.id, x]));

export function getBuilding(id) {
  return BY_ID.get(id) ?? null;
}

export function buildingsByCategory(category) {
  return BUILDINGS.filter((x) => x.category === category);
}
