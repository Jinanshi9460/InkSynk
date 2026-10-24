// Scoring rules (Phase 5). EVERY point value in the game comes from this file, so the rules
// are easy to explain and to change. These numbers are this implementation's own choice, not
// something the assignment prescribes.
//
//   Guesser, by order of correct guess within one turn:
//     1st = 100, 2nd = 80, 3rd = 60, 4th = 40, 5th and later = 20 (the floor).
//   Drawer: a flat 50-point bonus once at least one eligible player has guessed correctly
//     (awarded exactly once per turn, at the moment of the first correct guess).
//   Nobody scores for a wrong guess, a repeat guess, or the drawer "guessing" their own word.

export const GUESSER_POINTS = [100, 80, 60, 40];
export const MIN_GUESSER_POINTS = 20;
export const DRAWER_BONUS = 50;

/**
 * Points for a correct guess.
 * @param {number} placeIndex 0-based position among this turn's correct guesses (0 = first).
 */
export function pointsForGuess(placeIndex) {
  if (!Number.isInteger(placeIndex) || placeIndex < 0) return 0;
  return GUESSER_POINTS[placeIndex] ?? MIN_GUESSER_POINTS;
}

/** Drawer bonus, given how many correct guesses the turn has so far (0 = nothing yet). */
export function drawerBonus(correctCount) {
  return correctCount >= 1 ? DRAWER_BONUS : 0;
}
