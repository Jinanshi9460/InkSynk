// Server-side drawing engine: validated, ordered stroke history per room.
// Pure logic (no socket code). The history lives on `room.drawing` and is reset when a
// game starts and by game.js at the start of every turn (and at game over).
//
// Coordinates are NORMALIZED (0..1 of canvas width/height) so every client can render at
// any size. Brush `size` is in "virtual pixels" of an 800px-wide canvas.

import { ERROR_CODES } from './events.js';

export const DRAW_LIMITS = {
  size: { min: 1, max: 50 },
  maxStrokes: 1000, // per drawing session; clear the canvas to continue
  maxPointsPerStroke: 5000,
  maxPointsPerMessage: 100, // one draw_move batch
};

const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MODES = ['pen', 'eraser'];
const ERASER_COLOR = '#ffffff';

const fail = (code, message) => ({ ok: false, error: { code, message } });

export function resetSession(room) {
  room.drawing = {
    strokes: [], // ordered, oldest first
    byId: new Map(), // strokeId -> stroke
    active: new Map(), // playerId -> stroke currently being drawn (at most one each)
  };
  return room.drawing;
}

export function getSession(room) {
  return room.drawing ?? resetSession(room);
}

function toCoord(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}

function toPoint(x, y) {
  const px = toCoord(x);
  const py = toCoord(y);
  return px === null || py === null ? null : [px, py];
}

/** Stroke as sent to clients (no internal fields). */
function publicStroke(s) {
  return { id: s.id, color: s.color, size: s.size, mode: s.mode, points: s.points, done: s.done };
}

/** Begin a stroke. Returns { ok, stroke, autoClosed: [strokeId] } or an error. */
export function startStroke(room, playerId, input) {
  const { strokeId, x, y, color, size, mode } = input ?? {};
  const session = getSession(room);

  if (typeof strokeId !== 'string' || !ID_PATTERN.test(strokeId)) {
    return fail(ERROR_CODES.INVALID_STROKE, 'Invalid stroke id.');
  }
  if (!MODES.includes(mode)) return fail(ERROR_CODES.INVALID_STROKE, 'Mode must be "pen" or "eraser".');
  if (!Number.isInteger(size) || size < DRAW_LIMITS.size.min || size > DRAW_LIMITS.size.max) {
    return fail(ERROR_CODES.INVALID_STROKE, `Brush size must be a whole number ${DRAW_LIMITS.size.min}-${DRAW_LIMITS.size.max}.`);
  }
  if (mode === 'pen' && (typeof color !== 'string' || !COLOR_PATTERN.test(color))) {
    return fail(ERROR_CODES.INVALID_STROKE, 'Color must look like #rrggbb.');
  }
  const point = toPoint(x, y);
  if (!point) return fail(ERROR_CODES.INVALID_STROKE, 'Invalid coordinates.');
  if (session.byId.has(strokeId)) return fail(ERROR_CODES.INVALID_STROKE, 'Stroke id already used.');
  if (session.strokes.length >= DRAW_LIMITS.maxStrokes) {
    return fail(ERROR_CODES.TOO_MANY_STROKES, 'The canvas is full. Clear it to keep drawing.');
  }

  // A player can only draw one stroke at a time: close any dangling one first.
  const autoClosed = [];
  const previous = session.active.get(playerId);
  if (previous) {
    previous.done = true;
    session.active.delete(playerId);
    autoClosed.push(previous.id);
  }

  const stroke = {
    id: strokeId,
    color: mode === 'eraser' ? ERASER_COLOR : color.toLowerCase(),
    size,
    mode,
    points: [point],
    done: false,
    authorId: playerId,
  };
  session.strokes.push(stroke);
  session.byId.set(strokeId, stroke);
  session.active.set(playerId, stroke);
  return { ok: true, stroke: publicStroke(stroke), autoClosed };
}

/** Append a batch of points to the player's active stroke. Returns { ok, points: accepted }. */
export function addPoints(room, playerId, strokeId, points) {
  const session = getSession(room);
  const stroke = session.active.get(playerId);
  if (!stroke || stroke.id !== strokeId) return fail(ERROR_CODES.INVALID_STROKE, 'No such active stroke.');
  if (!Array.isArray(points) || points.length < 1 || points.length > DRAW_LIMITS.maxPointsPerMessage) {
    return fail(ERROR_CODES.INVALID_STROKE, `Send 1-${DRAW_LIMITS.maxPointsPerMessage} points per draw_move.`);
  }
  const clean = [];
  for (const p of points) {
    const point = Array.isArray(p) ? toPoint(p[0], p[1]) : null;
    if (!point) return fail(ERROR_CODES.INVALID_STROKE, 'Invalid point in batch.');
    clean.push(point);
  }
  const room_left = DRAW_LIMITS.maxPointsPerStroke - stroke.points.length;
  const accepted = clean.slice(0, Math.max(0, room_left));
  stroke.points.push(...accepted);
  return { ok: true, points: accepted };
}

export function endStroke(room, playerId, strokeId) {
  const session = getSession(room);
  const stroke = session.active.get(playerId);
  if (!stroke || stroke.id !== strokeId) return fail(ERROR_CODES.INVALID_STROKE, 'No such active stroke.');
  stroke.done = true;
  session.active.delete(playerId);
  return { ok: true };
}

/** Close whatever stroke a player has open (disconnect / permission change). Returns its id or null. */
export function closeActiveStroke(room, playerId) {
  const session = getSession(room);
  const stroke = session.active.get(playerId);
  if (!stroke) return null;
  stroke.done = true;
  session.active.delete(playerId);
  return stroke.id;
}

/** Remove the most recent COMPLETED stroke (strokes still being drawn are skipped). */
export function undoLast(room) {
  const session = getSession(room);
  for (let i = session.strokes.length - 1; i >= 0; i -= 1) {
    if (session.strokes[i].done) {
      const [removed] = session.strokes.splice(i, 1);
      session.byId.delete(removed.id);
      return { ok: true, strokeId: removed.id };
    }
  }
  return fail(ERROR_CODES.NOTHING_TO_UNDO, 'There is nothing to undo.');
}

export function clearAll(room) {
  resetSession(room);
}

/** Full ordered history (including in-progress strokes, flagged done:false). */
export function snapshot(room) {
  return getSession(room).strokes.map(publicStroke);
}
