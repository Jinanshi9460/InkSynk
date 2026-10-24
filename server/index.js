// Entry point: Express (health check) + Socket.IO (all game traffic).
// The server is authoritative: clients only send *requests*; the server decides.

import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { EVENTS, ERROR_CODES } from './events.js';
import * as rooms from './rooms.js';
import { registerDrawingHandlers, closeActiveStroke } from './drawingHandlers.js';
import { createGameEngine, publicRoomState } from './game.js';
import { createLimiter } from './rateLimit.js';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

// Safety cap on simultaneous rooms (memory is the only storage). Override with MAX_ROOMS.
const MAX_ROOMS = Number.parseInt(process.env.MAX_ROOMS, 10) > 0 ? Number.parseInt(process.env.MAX_ROOMS, 10) : 500;

if (process.env.NODE_ENV === 'production') {
  if (!process.env.CLIENT_URL) {
    console.warn('WARNING: CLIENT_URL is not set; only http://localhost:5173 is allowed, so a deployed client will be blocked by CORS.');
  } else if (ALLOWED_ORIGINS.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    console.warn('WARNING: CLIENT_URL contains a localhost origin in production.');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.get('/health', (_req, res) =>
  // `timers` = rooms with a live game timer (at most one each); it must drop to 0 when rooms are removed.
  res.json({ ok: true, rooms: rooms.roomCount(), timers: rooms.allRooms().filter((r) => r.game?.timer).length }),
);
// Anything else over HTTP: a small JSON 404, and a JSON 500 that never includes a stack trace.
app.use((_req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('HTTP error:', err);
  res.status(500).json({ ok: false, error: { code: ERROR_CODES.SERVER_ERROR, message: 'Something went wrong on the server.' } });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
  // The biggest legitimate message is one draw_move batch (100 points, about 2 KB). Anything near
  // this limit is not a real client, and Socket.IO closes the connection instead of buffering it.
  maxHttpBufferSize: 64 * 1024,
  // A little more patience than the default so a phone that briefly stalls is not dropped from the room.
  pingTimeout: 30000,
});

// Owns round timers, word selection, drawer rotation and the room state machine (see game.js).
const engine = createGameEngine(io);

// ---------- small helpers ----------

const fail = (code, message) => ({ ok: false, error: { code, message } });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Wrap a handler so a missing ack function, a malformed payload or a thrown error never crashes
 * the server or leaks a stack trace. Payloads must be a plain object (or omitted): strings,
 * numbers, arrays and the like get a structured INVALID_PAYLOAD error instead of reaching the logic.
 */
function handle(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
      reply(fail(ERROR_CODES.INVALID_PAYLOAD, 'Invalid request.'));
      return;
    }
    try {
      reply(fn(payload ?? {}) ?? { ok: true });
    } catch (err) {
      console.error(`Error in ${event}:`, err); // full detail stays in the server log only
      reply(fail(ERROR_CODES.SERVER_ERROR, 'Something went wrong on the server.'));
    }
  });
}

// Flood protection, per socket. Each limiter keeps its own sliding window (see rateLimit.js).
//  - messages: guesses + chat combined (also stops scripted brute-force guessing): 10 per 5 s.
//  - drawing: draw_start/move/end/undo/clear. A real client sends ~33 draw_move/s at most, so 150/s
//    leaves headroom for bursts but stops a script from flooding the room.
//  - roomActions: create/join/leave/start/settings, so nobody can spam room creation or join attempts.
const allowMessage = createLimiter({ max: 10, windowMs: 5000 });
const allowDraw = createLimiter({ max: 150, windowMs: 1000 });
const allowRoomAction = createLimiter({ max: 15, windowMs: 10000 });
const allowSettings = createLimiter({ max: 25, windowMs: 10000 });
const allowSync = createLimiter({ max: 30, windowMs: 10000 }); // sync_game / draw_sync can return a whole canvas history

const rateLimit = (socket) =>
  allowMessage(socket) ? null : fail(ERROR_CODES.RATE_LIMITED, 'You are sending messages too fast. Slow down a little.');
const roomActionLimit = (socket) =>
  allowRoomAction(socket) ? null : fail(ERROR_CODES.RATE_LIMITED, 'Too many requests. Please wait a few seconds.');
const settingsLimit = (socket) =>
  allowSettings(socket) ? null : fail(ERROR_CODES.RATE_LIMITED, 'Too many requests. Please wait a few seconds.');
const syncLimit = (socket) =>
  allowSync(socket) ? null : fail(ERROR_CODES.RATE_LIMITED, 'Too many sync requests. Please wait a few seconds.');
const drawLimit = (socket) =>
  allowDraw(socket) ? null : fail(ERROR_CODES.RATE_LIMITED, 'Drawing too fast. Slow down a little.');

/** Look up the room this socket is in (server-side truth, not client-supplied). */
function currentRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.getRoom(code) : undefined;
}

function broadcastState(room) {
  io.to(room.code).emit(EVENTS.GAME_STATE, publicRoomState(room)); // public data only, never the secret word
}

/** Shared by leave_room and disconnect. */
function leaveCurrentRoom(socket) {
  const room = currentRoom(socket);
  socket.data.roomCode = null;
  if (!room) return;

  socket.leave(room.code);
  closeActiveStroke(io, room, socket.id); // don't leave a half-drawn stroke dangling
  const { removed, roomDeleted, newHostId } = rooms.removePlayer(room, socket.id);
  if (!removed) return;
  if (roomDeleted) {
    engine.disposeRoom(room); // no timer may outlive its room
    return;
  }

  io.to(room.code).emit(EVENTS.PLAYER_LEFT, {
    playerId: removed.id,
    username: removed.username,
    newHostId,
  });
  // A running game may need to react (drawer left -> end the turn; <2 players -> back to lobby).
  engine.handlePlayerLeft(room, removed);
  broadcastState(room);
}

// ---------- socket handlers ----------

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  console.log(`Socket connected: ${socket.id}`);

  handle(socket, EVENTS.CREATE_ROOM, ({ username, settings }) => {
    const limited = roomActionLimit(socket);
    if (limited) return limited;
    if (socket.data.roomCode) return fail(ERROR_CODES.ALREADY_IN_ROOM, 'You are already in a room.');
    if (rooms.roomCount() >= MAX_ROOMS) return fail(ERROR_CODES.SERVER_BUSY, 'The server is full right now. Please try again in a few minutes.');
    const name = rooms.validateUsername(username);
    if (!name.ok) return name;

    // Settings are optional (defaults apply) but, when sent, must be fully valid.
    // The host is always the creating socket - any client-sent host/player id is ignored.
    let roomSettings = rooms.DEFAULT_SETTINGS;
    if (settings !== undefined) {
      const result = rooms.validateSettings(settings);
      if (!result.ok) return result;
      roomSettings = result.settings;
    }

    const room = rooms.createRoom(socket.id, name.username, roomSettings);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    return { ok: true, playerId: socket.id, room: publicRoomState(room) };
  });

  handle(socket, EVENTS.JOIN_ROOM, ({ roomCode, username }) => {
    const limited = roomActionLimit(socket);
    if (limited) return limited;
    if (socket.data.roomCode) return fail(ERROR_CODES.ALREADY_IN_ROOM, 'You are already in a room.');
    const name = rooms.validateUsername(username);
    if (!name.ok) return name;
    const code = rooms.validateRoomCode(roomCode);
    if (!code.ok) return code;

    const room = rooms.getRoom(code.code);
    if (!room) return fail(ERROR_CODES.ROOM_NOT_FOUND, 'No room found with that code.');

    const added = rooms.addPlayer(room, socket.id, name.username);
    if (!added.ok) return added;

    socket.data.roomCode = room.code;
    socket.join(room.code);
    // Tell everyone else first, then send the fresh snapshot to the whole room.
    socket.to(room.code).emit(EVENTS.PLAYER_JOINED, { player: { id: added.player.id, username: added.player.username } });
    broadcastState(room);
    return { ok: true, playerId: socket.id, room: publicRoomState(room) };
  });

  handle(socket, EVENTS.LEAVE_ROOM, () => {
    leaveCurrentRoom(socket);
  });

  handle(socket, EVENTS.UPDATE_SETTINGS, ({ settings }) => {
    const limited = settingsLimit(socket);
    if (limited) return limited;
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    if (room.hostId !== socket.id) return fail(ERROR_CODES.NOT_HOST, 'Only the host can change settings.');
    if (room.phase !== rooms.PHASES.LOBBY) return fail(ERROR_CODES.WRONG_PHASE, 'Settings are locked once the game starts.');

    const result = rooms.validateSettings(settings, room.settings);
    if (!result.ok) return result;
    if (result.settings.maxPlayers < room.players.size) {
      return fail(ERROR_CODES.INVALID_SETTINGS, 'Max players cannot be lower than the current player count.');
    }
    room.settings = result.settings;
    broadcastState(room);
    return { ok: true, room: publicRoomState(room) };
  });

  handle(socket, EVENTS.START_GAME, () => {
    const limited = roomActionLimit(socket);
    if (limited) return limited;
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    if (room.hostId !== socket.id) return fail(ERROR_CODES.NOT_HOST, 'Only the host can start the game.');
    if (room.phase !== rooms.PHASES.LOBBY) return fail(ERROR_CODES.WRONG_PHASE, 'The game has already started.');
    if (room.players.size < 2) return fail(ERROR_CODES.NOT_ENOUGH_PLAYERS, 'At least 2 players are needed to start.');

    // The engine validates again, picks the first drawer (lobby join order), offers words
    // privately to that drawer and broadcasts the new state. Round one only starts here.
    return engine.startGame(room);
  });

  // Host sends everyone back to the lobby after the final leaderboard (same room, scores reset).
  handle(socket, EVENTS.PLAY_AGAIN, () => {
    const limited = roomActionLimit(socket);
    if (limited) return limited;
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    if (room.hostId !== socket.id) return fail(ERROR_CODES.NOT_HOST, 'Only the host can start another game.');
    return engine.returnToLobby(room);
  });

  handle(socket, EVENTS.WORD_CHOSEN, ({ word }) => {
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    // Who is the drawer, which words were offered and the phase all come from server state.
    return engine.chooseWord(room, socket.id, word);
  });

  // Recovery snapshot for this player only: public state plus, for the drawer, their private words.
  handle(socket, EVENTS.SYNC_GAME, () => {
    const limited = syncLimit(socket);
    if (limited) return limited;
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    return { ok: true, ...engine.syncFor(room, socket.id) };
  });

  // ----- Phase 5: guessing and chat. The room, the sender and the phase are all server-side facts. -----
  handle(socket, EVENTS.GUESS, ({ text }) => {
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    const limited = rateLimit(socket);
    if (limited) return limited;
    return engine.submitGuess(room, socket.id, text);
  });

  handle(socket, EVENTS.CHAT, ({ text }) => {
    const room = currentRoom(socket);
    if (!room) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in a room.');
    const limited = rateLimit(socket);
    if (limited) return limited;
    return engine.sendChat(room, socket.id, text);
  });

  registerDrawingHandlers(io, socket, { handle, currentRoom, fail, drawLimit, syncLimit });

  socket.on('disconnect', (reason) => {
    console.log(`Socket disconnected: ${socket.id} (${reason})`);
    leaveCurrentRoom(socket);
  });
});

// A bug in one handler must never take the whole server (and every room) down silently.
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

// Graceful shutdown: stop every room timer, then close sockets and the HTTP server.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  engine.shutdown();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
