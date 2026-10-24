// Central socket event contract (server side).
// The client keeps an identical copy in client/src/events.js - keep them in sync.
//
// Every client -> server request uses a Socket.IO acknowledgement:
//   success: { ok: true, ...data }
//   failure: { ok: false, error: { code, message } }

export const EVENTS = {
  // Room / lobby (client -> server)
  CREATE_ROOM: 'create_room', // { username, settings? }            -> ack { ok, playerId, room }
  JOIN_ROOM: 'join_room', //     { roomCode, username }            -> ack { ok, playerId, room }
  LEAVE_ROOM: 'leave_room', //   {}                                -> ack { ok }
  UPDATE_SETTINGS: 'update_settings', // { settings } (host only)  -> ack { ok, room }
  START_GAME: 'start_game', //   {} (host only)                    -> ack { ok }  (Phase 4: starts round 1)
  PLAY_AGAIN: 'play_again', //   {} (host only, game_over phase)   -> ack { ok }  (Phase 6: back to the lobby, scores reset)

  // Room / lobby (server -> client)
  PLAYER_JOINED: 'player_joined', // { player }
  PLAYER_LEFT: 'player_left', //     { playerId, username, newHostId }
  GAME_STATE: 'game_state', //       full public room snapshot (never contains secrets)

  // Drawing (Phase 3). Coordinates are normalized 0..1. See docs/EVENTS.md.
  DRAW_START: 'draw_start', //   { strokeId, x, y, color, size, mode } (drawer only)  -> ack { ok }
  DRAW_MOVE: 'draw_move', //     { strokeId, points: [[x,y],...] } batched (drawer)    -> ack { ok }
  DRAW_END: 'draw_end', //       { strokeId } (drawer only)                            -> ack { ok }
  DRAW_UNDO: 'draw_undo', //     C->S {} (drawer only) -> ack { ok, strokeId }; S->C { strokeId } to the whole room
  CANVAS_CLEAR: 'canvas_clear', // C->S {} (drawer only) -> ack { ok }; S->C {} to the whole room
  DRAW_SYNC: 'draw_sync', //     {} (any room member) -> ack { ok, drawerId, strokes }
  DRAW_DATA: 'draw_data', //     S->C to everyone except the drawer: { phase: 'start'|'move'|'end', ... }

  // Game flow (Phase 4). Payloads and who receives what: see docs/EVENTS.md.
  ROUND_START: 'round_start', // S->C each player separately; ONLY the drawer's copy has wordOptions
  WORD_CHOSEN: 'word_chosen', // C->S { word } (drawer) -> ack { ok, word }; S->C to the drawer only { turnId, word, auto }
  ROUND_END: 'round_end', //     S->C room: { turnId, round, word, reason, scores, nextDrawerId, ... } (word revealed now)
  GAME_OVER: 'game_over', //     S->C room: { winner, winners, leaderboard }
  SYNC_GAME: 'sync_game', //     C->S {} (any room member) -> ack { ok, room, you } - role-filtered recovery snapshot

  // Chat + guessing (Phase 5). See docs/EVENTS.md.
  GUESS: 'guess', //                 C->S { text } -> ack { ok, correct, points? }; guessers only, drawing phase only
  GUESS_RESULT: 'guess_result', //   S->C { turnId, correct, playerId, playerName, points, place } (correct: whole room; wrong: sender only)
  CHAT: 'chat', //                   C->S { text } -> ack { ok }; general chat (restricted while drawing, see docs)
  CHAT_MESSAGE: 'chat_message', //   S->C { id, kind, scope, playerId, playerName, text, turnId, ts }
};

export const ERROR_CODES = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  INVALID_USERNAME: 'INVALID_USERNAME',
  NAME_TAKEN: 'NAME_TAKEN',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  WRONG_PHASE: 'WRONG_PHASE',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  NOT_DRAWER: 'NOT_DRAWER',
  INVALID_STROKE: 'INVALID_STROKE',
  TOO_MANY_STROKES: 'TOO_MANY_STROKES',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO',
  INVALID_WORD: 'INVALID_WORD',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE', //       the drawer cannot guess
  ALREADY_GUESSED: 'ALREADY_GUESSED', // this player already scored this turn
  CHAT_RESTRICTED: 'CHAT_RESTRICTED', // use the guess box / drawer cannot chat yet
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'SERVER_ERROR', //   unexpected failure; the details stay in the server log, never sent to clients
  SERVER_BUSY: 'SERVER_BUSY', //     too many rooms exist right now (MAX_ROOMS)
};
