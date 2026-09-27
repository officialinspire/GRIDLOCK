/**
 * The CPU's own seeded random stream (mulberry32), used only to choose between equally good
 * options. It is never the game's generator: nothing here reads game.rngState or calls
 * nextRandom(), so CPU decisions can't predict or change city events.
 */
import { currentPlayer, roadsBuilt } from '../game.js';

/** Mixes integers into one 32-bit seed. */
export function mix(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** A float stream in [0, 1) from a seed. */
export function stream(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The default CPU seed: public facts only (city seed, seat, roads down). */
export function defaultCpuSeed(game) {
  return mix(game.seed ?? 0, currentPlayer(game)?.seat ?? 0, roadsBuilt(game));
}
