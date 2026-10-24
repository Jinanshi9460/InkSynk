// Socket handlers for drawing. Registered per connection from index.js.
//
// Authorization: every mutating event requires phase DRAWING and canDraw() from
// drawPermission.js (the current turn's drawer, from the game engine) using the server's own
// record of who the socket is (socket.id) - client-sent ids are never trusted.
// Broadcasts go to the socket's room only (io.to(room.code)).
//
// Echo policy: draw_data (start/move/end) goes to everyone in the room EXCEPT the drawer,
// whose own canvas is already rendered locally (so nothing is drawn twice).
// Undo and clear go to EVERYONE including the drawer, so all canvases change from the
// same server-confirmed event.

import { EVENTS, ERROR_CODES } from './events.js';
import * as drawing from './drawing.js';
import { canDraw, getDrawerId } from './drawPermission.js';
import { PHASES } from './rooms.js';

/** End a player's open stroke and tell the room (used on disconnect / pen hand-over). */
export function closeActiveStroke(io, room, playerId) {
  const strokeId = drawing.closeActiveStroke(room, playerId);
  if (strokeId) io.to(room.code).emit(EVENTS.DRAW_DATA, { phase: 'end', strokeId });
}

export function registerDrawingHandlers(io, socket, { handle, currentRoom, fail, drawLimit = () => null, syncLimit = () => null }) {
  /** Returns an error result if this socket may not draw right now, otherwise null. */
  function deny(room) {
    const limited = drawLimit(socket); // flood protection first: cheap, and applies to every drawing event
    if (limited) return limited;
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    if (room.phase !== PHASES.DRAWING) return fail(ERROR_CODES.WRONG_PHASE, 'Drawing is only possible while a round is in progress.');
    if (!canDraw(room, socket.id)) return fail(ERROR_CODES.NOT_DRAWER, 'Only the current drawer can do that.');
    return null;
  }

  handle(socket, EVENTS.DRAW_START, (payload) => {
    const room = currentRoom(socket);
    const denied = deny(room);
    if (denied) return denied;

    const result = drawing.startStroke(room, socket.id, payload);
    if (!result.ok) return result;
    for (const strokeId of result.autoClosed) {
      socket.to(room.code).emit(EVENTS.DRAW_DATA, { phase: 'end', strokeId });
    }
    socket.to(room.code).emit(EVENTS.DRAW_DATA, { phase: 'start', stroke: result.stroke });
    return { ok: true };
  });

  handle(socket, EVENTS.DRAW_MOVE, ({ strokeId, points }) => {
    const room = currentRoom(socket);
    const denied = deny(room);
    if (denied) return denied;

    const result = drawing.addPoints(room, socket.id, strokeId, points);
    if (!result.ok) return result;
    if (result.points.length > 0) {
      socket.to(room.code).emit(EVENTS.DRAW_DATA, { phase: 'move', strokeId, points: result.points });
    }
    return { ok: true };
  });

  handle(socket, EVENTS.DRAW_END, ({ strokeId }) => {
    const room = currentRoom(socket);
    const denied = deny(room);
    if (denied) return denied;

    const result = drawing.endStroke(room, socket.id, strokeId);
    if (!result.ok) return result;
    socket.to(room.code).emit(EVENTS.DRAW_DATA, { phase: 'end', strokeId });
    return { ok: true };
  });

  handle(socket, EVENTS.DRAW_UNDO, () => {
    const room = currentRoom(socket);
    const denied = deny(room);
    if (denied) return denied;

    const result = drawing.undoLast(room);
    if (!result.ok) return result;
    io.to(room.code).emit(EVENTS.DRAW_UNDO, { strokeId: result.strokeId });
    return { ok: true, strokeId: result.strokeId };
  });

  handle(socket, EVENTS.CANVAS_CLEAR, () => {
    const room = currentRoom(socket);
    const denied = deny(room);
    if (denied) return denied;

    drawing.clearAll(room);
    io.to(room.code).emit(EVENTS.CANVAS_CLEAR, {});
    return { ok: true };
  });

  // Any member of the room may request the current history (new component mount, resync,
  // reconnecting UI). Returns the strokes in order; in-progress ones have done:false.
  handle(socket, EVENTS.DRAW_SYNC, () => {
    const limited = syncLimit(socket);
    if (limited) return limited;
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    return { ok: true, drawerId: getDrawerId(room), strokes: drawing.snapshot(room) };
  });
}
