/**
 * Building catalogue. Costs/income are first-pass placeholders to be tuned
 * when building placement lands. `sprite` references js/assets.js.
 */

export const CATEGORIES = Object.freeze({
  residential: { id: 'residential', label: 'Residential' },
  commercial: { id: 'commercial', label: 'Commercial' },
  civic: { id: 'civic', label: 'Civic' },
  industrial: { id: 'industrial', label: 'Industrial' },
  park: { id: 'park', label: 'Park' },
});

const b = (id, name, category, cost, income, sprite) =>
  Object.freeze({ id, name, category, cost, income, sprite });

export const BUILDINGS = Object.freeze([
  // Residential
  b('house', 'House', 'residential', 150, 25, 'buildings:house'),
  b('duplex', 'Duplex', 'residential', 250, 40, 'buildings:duplex'),
  b('rowhouses', 'Rowhouses', 'residential', 350, 60, 'buildings:rowhouses'),
  b('apartments', 'Apartments', 'residential', 500, 90, 'buildings:apartments'),
  // Commercial
  b('corner-store', 'Corner Store', 'commercial', 200, 35, 'buildings:corner-store'),
  b('diner', 'Diner', 'commercial', 250, 45, 'buildings:diner'),
  b('convenience-store', '24/7 Store', 'commercial', 300, 50, 'buildings:convenience-store'),
  b('cafe', 'Café', 'commercial', 250, 40, 'buildings:cafe'),
  b('shop', 'Shop', 'commercial', 300, 55, 'buildings:shop'),
  b('market', 'Market', 'commercial', 450, 80, 'buildings:market'),
  b('gas-station', 'Gas Station', 'commercial', 400, 70, 'buildings:gas-station'),
  b('office', 'Office Tower', 'commercial', 650, 120, 'buildings:office'),
  // Civic
  b('school', 'School', 'civic', 500, 30, 'civic:school'),
  b('library', 'Library', 'civic', 450, 25, 'civic:library'),
  b('hospital', 'Hospital', 'civic', 800, 60, 'civic:hospital'),
  b('fire-station', 'Fire Station', 'civic', 500, 30, 'civic:fire-station'),
  b('police', 'Police Station', 'civic', 500, 30, 'civic:police'),
  b('city-hall', 'City Hall', 'civic', 1000, 100, 'civic:city-hall'),
  b('train-station', 'Train Station', 'civic', 700, 90, 'civic:train-station'),
  b('theater', 'Theater', 'civic', 600, 85, 'civic:theater'),
  b('museum', 'Museum', 'civic', 600, 70, 'civic:museum'),
  b('stadium', 'Stadium', 'civic', 1200, 160, 'civic:stadium'),
  b('monument', 'Monument', 'civic', 400, 20, 'civic:monument'),
  b('parking-garage', 'Parking Garage', 'civic', 400, 60, 'civic:parking-garage'),
  // Industrial
  b('warehouse', 'Warehouse', 'industrial', 400, 70, 'civic:warehouse'),
  b('factory', 'Factory', 'industrial', 700, 130, 'civic:factory'),
  b('substation', 'Power Substation', 'industrial', 500, 50, 'civic:substation'),
  // Parks
  b('plaza', 'Plaza', 'park', 200, 10, 'parks:plaza'),
  b('garden', 'Community Garden', 'park', 150, 10, 'parks:garden'),
  b('playground', 'Playground', 'park', 200, 10, 'parks:playground'),
  b('basketball-court', 'Basketball Court', 'park', 200, 15, 'parks:basketball-court'),
  b('fountain', 'Fountain Square', 'park', 300, 20, 'parks:fountain'),
  b('dog-park', 'Dog Park', 'park', 150, 10, 'parks:dog-park'),
  b('picnic-grove', 'Picnic Grove', 'park', 150, 10, 'parks:picnic-grove'),
  b('skatepark', 'Skatepark', 'park', 250, 15, 'parks:skatepark'),
]);

const BY_ID = new Map(BUILDINGS.map((x) => [x.id, x]));

export function getBuilding(id) {
  return BY_ID.get(id) ?? null;
}

export function buildingsByCategory(category) {
  return BUILDINGS.filter((x) => x.category === category);
}

/** Building every player starts with on their corner block. */
export const STARTER_BUILDING_ID = 'house';
