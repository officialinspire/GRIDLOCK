/**
 * Plays out the CITY era of a game whose roads are all paved (not a test file itself). Each City
 * turn the current mayor leaves any capture from the final road vacant, clears debt (bankruptcy if
 * unavoidable, else sells), optionally calls `turn(game)` to spend City Actions, then ends the
 * turn. Returns the number of City turns played. Throws on a stuck or runaway game.
 */
import { currentPlayer, resolveCapture, endCityTurn, ERAS, PHASES, TURN_PHASES } from '../../js/core/game.js';
import { blocksOwnedBy } from '../../js/core/board.js';
import { isDeveloped } from '../../js/core/development.js';
import { distressStatus, declareBankruptcy, sellDevelopment } from '../../js/core/finance.js';

export function playOutCity(game, { turn = () => {} } = {}) {
  let turns = 0;
  while (game.phase === PHASES.PLAYING) {
    if (game.era !== ERAS.CITY) throw new Error('playOutCity: the grid is not complete');
    if (++turns > 200) throw new Error('playOutCity: runaway City era');
    while (game.turnPhase === TURN_PHASES.CAPTURE_DEVELOP) resolveCapture(game);
    const me = currentPlayer(game);
    while (me.cash < 0) {
      if (distressStatus(game, me).canDeclare) declareBankruptcy(game);
      else sellDevelopment(game, blocksOwnedBy(game.board, me.seat).find(isDeveloped).id);
    }
    turn(game);
    const result = endCityTurn(game);
    if (!result.ok) throw new Error(`playOutCity: end turn refused (${result.error})`);
  }
  return turns;
}
