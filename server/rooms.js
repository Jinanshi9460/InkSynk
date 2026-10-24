// In-memory room store and pure helpers (no socket code in here).
// State is lost when the server restarts - acceptable for the MVP.

import { randomInt } from 'node:crypto';
import { ERROR_CODES } from './events.js';

// Allowed ranges for room settings (validated on the server, never trusted from the client).
export const LIMITS = {
  maxPlayers: { min: 2, max: 20 },
  rounds: { min: 2, max: 10 },
  drawTime: { min: 15, max: 240 },
  wordChoices: { min: 1, max: 5 },
  hints: { min: 0, max: 5 }, // 0 = hints disabled
};

// Boolean settings (validated as real booleans, never coerced from strings/numbers).
export const BOOLEAN_SETTINGS = ['isPublic'];

export const DEFAULT_SETTINGS = {
  maxPlayers: 8,
  rounds: 3,
  drawTime: 60,
  wordChoices: 3,
  hints: 2,
  isPublic: false, // private by default: only reachable via code / invite link
};

export const USERNAME_MAX_LENGTH = 20;

// The room's state machine (Phase 4). Only server/game.js moves a room between these phases:
//   LOBBY -> WORD_SELECTION -> DRAWING -> ROUND_END -> NEXT_ROUND -> WORD_SELECTION ... -> GAME_OVER
// NEXT_ROUND is a transient step (the next drawer is picked and the phase immediately moves on),
// so clients only ever see the other five values. Any in-game phase can fall back to LOBBY
// when too many players leave.
export const PHASES = {
  LOBBY: 'lobby',
  WORD_SELECTION: 'word_selection',
  DRAWING: 'drawing',
  ROUND_END: 'round_end',
  NEXT_ROUND: 'next_round',
  GAME_OVER: 'game_over',
};

// Letters/digits without look-alikes (no 0/O, 1/I/L) so codes are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

/** @type {Map<string, object>} roomCode -> room */
const rooms = new Map();

export function generateRoomCode() {
  // Retry until unique. 31^5 ~ 28 million codes, so collisions are rare.
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

export function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** Room codes are 3-8 letters/digits. Checked before any lookup so junk input gets a clear error. */
export function validateRoomCode(value) {
  const code = normalizeRoomCode(value);
  if (!/^[A-Z0-9]{3,8}$/.test(code)) {
    return fail(ERROR_CODES.ROOM_NOT_FOUND, 'Enter a valid room code (letters and numbers only).');
  }
  return { ok: true, code };
}

export function getRoom(code) {
  return rooms.get(normalizeRoomCode(code));
}

export function roomCount() {
  return rooms.size;
}

/** All live rooms (used for server shutdown cleanup of game timers). */
export function allRooms() {
  return [...rooms.values()];
}

/** Returns { ok: true, username } with the trimmed name, or { ok: false, error }. */
export function validateUsername(value) {
  if (typeof value !== 'string') {
    return fail(ERROR_CODES.INVALID_USERNAME, 'Username is required.');
  }
  // Strip control characters and invisible/bidi-override characters (so a name cannot look blank
  // or spoof another player), then collapse repeated whitespace.
  const username = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (username.length < 1 || username.length > USERNAME_MAX_LENGTH) {
    return fail(
      ERROR_CODES.INVALID_USERNAME,
      `Username must be 1-${USERNAME_MAX_LENGTH} characters.`,
    );
  }
  return { ok: true, username };
}

/**
 * Validate a (partial) settings object on top of a base settings object.
 * Unknown keys are ignored. Numeric keys must be integers within LIMITS and
 * boolean keys (isPublic) must be real booleans.
 */
export function validateSettings(input, base = DEFAULT_SETTINGS) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(ERROR_CODES.INVALID_SETTINGS, 'Settings must be an object.');
  }
  const next = { ...base };
  for (const key of Object.keys(LIMITS)) {
    if (!(key in input)) continue;
    const value = input[key];
    const { min, max } = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      return fail(ERROR_CODES.INVALID_SETTINGS, `${key} must be a whole number from ${min} to ${max}.`);
    }
    next[key] = value;
  }
  for (const key of BOOLEAN_SETTINGS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') {
      return fail(ERROR_CODES.INVALID_SETTINGS, `${key} must be true or false.`);
    }
    next[key] = input[key];
  }
  return { ok: true, settings: next };
}

function makePlayer(id, username) {
  return { id, username, score: 0, joinedAt: Date.now() };
}

/** `settings` must already be validated (see validateSettings). */
export function createRoom(hostId, username, settings = DEFAULT_SETTINGS) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId,
    phase: PHASES.LOBBY,
    settings: { ...settings },
    players: new Map([[hostId, makePlayer(hostId, username)]]),
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

/** Adds a player to a room, enforcing capacity, phase and unique usernames. */
export function addPlayer(room, playerId, username) {
  if (room.phase !== PHASES.LOBBY) {
    return fail(ERROR_CODES.GAME_IN_PROGRESS, 'This game has already started.');
  }
  if (room.players.size >= room.settings.maxPlayers) {
    return fail(ERROR_CODES.ROOM_FULL, 'This room is full.');
  }
  const taken = [...room.players.values()].some(
    (p) => p.username.toLowerCase() === username.toLowerCase(),
  );
  if (taken) {
    return fail(ERROR_CODES.NAME_TAKEN, 'That username is already taken in this room.');
  }
  const player = makePlayer(playerId, username);
  room.players.set(playerId, player);
  return { ok: true, player };
}

/**
 * Removes a player. Transfers host to the longest-present player if the host left and
 * deletes the room when empty. What the departure means for a running game (skipping the
 * leaver's turn, ending the drawer's turn, aborting when fewer than 2 players remain) is
 * decided by game.js - see handlePlayerLeft().
 * Returns { removed, roomDeleted, newHostId }.
 */
export function removePlayer(room, playerId) {
  const removed = room.players.get(playerId);
  if (!removed) return { removed: null, roomDeleted: false, newHostId: null };

  room.players.delete(playerId);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return { removed, roomDeleted: true, newHostId: null };
  }

  let newHostId = null;
  if (room.hostId === playerId) {
    const oldest = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostId = oldest.id;
    newHostId = oldest.id;
  }

  return { removed, roomDeleted: false, newHostId };
}

/** Public snapshot sent to clients. Must never include secret game data. */
export function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    drawerId: room.game?.drawerId ?? null, // set by game.js; null in the lobby
    settings: room.settings,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      username: p.username,
      score: p.score,
      isHost: p.id === room.hostId,
    })),
  };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}
