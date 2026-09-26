/**
 * Small seeded PRNG (mulberry32). State lives in game.rngState so games are
 * reproducible from their seed and survive serialisation.
 */
export function randomSeed() {
  return (Math.random() * 2 ** 32) >>> 0;
}

/** Returns a float in [0, 1) and advances game.rngState. */
export function nextRandom(game) {
  let t = (game.rngState = (game.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
