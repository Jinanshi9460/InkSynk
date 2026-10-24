// Client copy of the socket event contract. Keep identical to server/events.js.

export const EVENTS = {
  // client -> server (all use acks: { ok: true, ... } or { ok: false, error: { code, message } })
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  UPDATE_SETTINGS: 'update_settings',
  START_GAME: 'start_game',
  PLAY_AGAIN: 'play_again', // client -> server, host only, game_over phase: back to the lobby (Phase 6)

  // server -> client
  PLAYER_JOINED: 'player_joined',
  PLAYER_LEFT: 'player_left',
  GAME_STATE: 'game_state',

  // drawing (Phase 3) - coordinates are normalized 0..1; see docs/EVENTS.md
  DRAW_START: 'draw_start',
  DRAW_MOVE: 'draw_move',
  DRAW_END: 'draw_end',
  DRAW_UNDO: 'draw_undo',
  CANVAS_CLEAR: 'canvas_clear',
  DRAW_SYNC: 'draw_sync',
  DRAW_DATA: 'draw_data', // server -> client only

  // game flow (Phase 4) - see docs/EVENTS.md for payloads and who receives what
  ROUND_START: 'round_start', // server -> client; only the drawer's copy contains wordOptions
  WORD_CHOSEN: 'word_chosen', // client -> server { word }; server -> drawer only { turnId, word, auto }
  ROUND_END: 'round_end', //     server -> room (the word is revealed here)
  GAME_OVER: 'game_over', //     server -> room
  SYNC_GAME: 'sync_game', //     client -> server: role-filtered recovery snapshot

  // chat + guessing (Phase 5) - see docs/EVENTS.md
  GUESS: 'guess', //               client -> server { text }
  GUESS_RESULT: 'guess_result', // server -> client
  CHAT: 'chat', //                 client -> server { text }
  CHAT_MESSAGE: 'chat_message', // server -> client
};

// Mirrors server/chat limits. The server re-validates everything.
export const MAX_MESSAGE_LENGTH = 100;
export const USERNAME_MAX_LENGTH = 20;

// Room phases (mirrors server/rooms.js PHASES). 'next_round' is transient and never reaches clients.
export const PHASES = {
  LOBBY: 'lobby',
  WORD_SELECTION: 'word_selection',
  DRAWING: 'drawing',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over',
};

// Drawing limits mirrored from server/drawing.js (the server re-validates everything).
export const DRAW_LIMITS = {
  size: { min: 1, max: 50 },
  maxPointsPerStroke: 5000,
  maxPointsPerMessage: 100,
};

// Mirrors server LIMITS; used only for form input bounds. The server re-validates everything.
export const LIMITS = {
  maxPlayers: { min: 2, max: 20 },
  rounds: { min: 2, max: 10 },
  drawTime: { min: 15, max: 240 },
  wordChoices: { min: 1, max: 5 },
  hints: { min: 0, max: 5 },
};

// Mirrors server DEFAULT_SETTINGS (used to pre-fill the Create Room form).
export const DEFAULT_SETTINGS = {
  maxPlayers: 8,
  rounds: 3,
  drawTime: 60,
  wordChoices: 3,
  hints: 2,
  isPublic: false,
};

// Numeric settings shown in forms. Order = display order.
export const SETTING_FIELDS = [
  { key: 'maxPlayers', label: 'Max players' },
  { key: 'rounds', label: 'Rounds' },
  { key: 'drawTime', label: 'Draw time (seconds)' },
  { key: 'wordChoices', label: 'Word choices' },
  { key: 'hints', label: 'Hints (0 = off)' },
];

/** Convert a form draft (inputs are strings) into the payload the server expects. */
export function draftToSettings(draft) {
  const settings = { isPublic: Boolean(draft.isPublic) };
  for (const { key } of SETTING_FIELDS) settings[key] = Number(draft[key]);
  return settings;
}
