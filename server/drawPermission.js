// Who may draw is decided ONLY here, and ONLY by the server (Phase 4).
//
// The drawer is the player the game engine (game.js) picked for the current turn and stored in
// `room.game.drawerId`. Clients never send a drawer id that is trusted: every drawing event is
// checked against `socket.id` using canDraw().
//
// Drawing is allowed only while the room is in the DRAWING phase, so nobody can draw during
// word selection, the round-end reveal, or after the game is over - not even the drawer.

import { PHASES } from './rooms.js';

/** The current turn's drawer, or null when no game/turn is running (lobby). */
export function getDrawerId(room) {
  return room.game?.drawerId ?? null;
}

/** True only for the current drawer, and only while the phase is DRAWING. */
export function canDraw(room, playerId) {
  return room.phase === PHASES.DRAWING && room.game?.drawerId === playerId;
}
