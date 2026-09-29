/**
 * Deterministic full-game driver for rule-preset tests (not a test file itself).
 * Each turn the current player: resolves debt (bankruptcy if unavoidable, else sells),
 * develops their first vacant block as residential if affordable, then paves the first
 * road that closes a block (else the first open road). In the CITY era it leaves the final
 * capture vacant, makes the same residential build (a City Action) and ends its turn; pass
 * `cityRounds: 0` to finish on the final road as before eras existed. Takes the game modules as
 * arguments so the same script can replay against older code for regression goldens.
 */
export function playthrough(api, options, { stopAfterRoads = Infinity, game: resume } = {}) {
  const { createGame, placeRoad, currentPlayer, buildOnBlock, blocksOwnedBy, allRoadIds, roadBlocks, builtSides,
    distressStatus, declareBankruptcy, sellDevelopment, isDeveloped, resolveCapture, endCityTurn } = api;
  const game = resume ?? createGame(options);
  const eventsByRound = new Map();
  let maxActive = 0;
  let steps = 0;
  while (game.phase === 'playing' && Object.keys(game.board.roads).length < stopAfterRoads) {
    if (++steps > 2000) throw new Error('runaway');
    const me = currentPlayer(game);
    if (me.cash < 0) {
      if (distressStatus(game, me).canDeclare) declareBankruptcy(game);
      else sellDevelopment(game, blocksOwnedBy(game.board, me.seat).find(isDeveloped).id);
      continue;
    }
    if (game.era === 'city' && game.turnPhase === 'capture-develop') {
      resolveCapture(game);
      continue;
    }
    const vacant = blocksOwnedBy(game.board, me.seat).find((b) => b.level === 0 && !b.abandoned);
    if (vacant && me.cash >= 3000) buildOnBlock(game, vacant.id, 'residential');
    if (game.era === 'city') {
      const turn = endCityTurn(game);
      if (!turn.ok) throw new Error(`end turn refused: ${turn.error}`);
      if (turn.event?.started) eventsByRound.set(game.round, turn.event.started.id);
      maxActive = Math.max(maxActive, game.events.active.length);
      continue;
    }
    const free = allRoadIds(game.board).filter((id) => !(id in game.board.roads));
    const closing = free.find((id) => roadBlocks(game.board, id)
      .some((b) => b.ownerSeat == null && !b.abandoned && builtSides(game.board, b) === 3));
    const result = placeRoad(game, closing ?? free[0]);
    if (!result.ok) throw new Error(`move refused: ${result.error}`);
    if (result.event?.started) eventsByRound.set(game.round, result.event.started.id);
    maxActive = Math.max(maxActive, game.events.active.length);
  }
  return {
    game,
    rounds: game.round,
    events: [...eventsByRound.entries()].map(([round, id]) => `${round}:${id}`),
    maxActive,
    values: game.results?.rows.map((r) => [r.seat, r.cityValue]) ?? null,
  };
}

/** Loads the game modules from a checkout root (default: this repo). */
export async function loadApi(root = new URL('../../', import.meta.url).href) {
  const [game, board, dev, finance] = await Promise.all(
    ['js/core/game.js', 'js/core/board.js', 'js/core/development.js', 'js/core/finance.js'].map((p) => import(new URL(p, root).href)));
  return { ...game, ...board, ...dev, ...finance };
}
