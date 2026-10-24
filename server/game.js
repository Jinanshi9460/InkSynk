// Server-authoritative game engine (Phase 4).
//
// STATE MACHINE (room.phase)
//
//   LOBBY --start_game--> WORD_SELECTION --word_chosen / timeout--> DRAWING
//                              |                                       |
//                              | drawer leaves                         | time up / drawer leaves
//                              v                                       v
//                           ROUND_END <--------------------------------+
//                              |   (after a short reveal pause)
//                              v
//                          NEXT_ROUND (transient: pick the next drawer, same tick)
//                              |-- more turns --> WORD_SELECTION
//                              '-- none left  --> GAME_OVER
//
//   Any in-game phase --(fewer than 2 players left)--> LOBBY
//
// WHAT THE SERVER OWNS (clients are never trusted for any of these):
//   drawer id, phase, round number, the offered words, the secret word, every deadline.
//
// TIMERS: each room has at most ONE live setTimeout (`room.game.timer`). armTimer() always
// clears the previous one before creating a new one, and the callback re-checks the room's
// phase, so a stale or duplicate wake-up can never advance the game twice.
//
// SECRECY: the word options and the secret word live only in `room.game` and are sent only
// to the drawer's own socket (round_start / word_chosen / sync_game). Everything in
// publicRoomState() (the broadcast game_state) is safe to show to every player. The word is
// revealed to everyone only in round_end, i.e. after the turn is over.
//
// PHASE 5 (guessing, chat, scoring): submitGuess() / sendChat() below. Point values live ONLY in
// scoring.js. A correct guess adds to `player.score` and `game.turnPoints[id]` and, when every
// eligible guesser is right, calls endTurn(room, 'all_guessed'). endTurn() is idempotent (the
// phase flips to ROUND_END synchronously), so a timer expiry and a last correct guess racing each
// other still produce exactly one round_end.

import { EVENTS, ERROR_CODES } from './events.js';
import { PHASES, serializeRoom, allRooms } from './rooms.js';
import * as drawing from './drawing.js';
import { pickWordOptions } from './words.js';
import { pointsForGuess, drawerBonus } from './scoring.js';

// ---------- timing ----------

// GAME_TIME_SCALE shortens every game timer (e.g. 0.1 = 10x faster) so automated tests can
// run a whole game in seconds. It is ignored in production.
const rawScale = Number(process.env.GAME_TIME_SCALE);
export const TIME_SCALE = process.env.NODE_ENV !== 'production' && rawScale > 0 && rawScale <= 1 ? rawScale : 1;

export const TIMING = {
  wordSelectMs: Math.round(15000 * TIME_SCALE), // drawer has this long to pick, then a word is auto-picked
  roundEndMs: Math.round(5000 * TIME_SCALE), //    the word/scores reveal pause between turns
};

const scaledDrawMs = (room) => Math.round(room.settings.drawTime * 1000 * TIME_SCALE);

// Legal phase changes. setPhase() throws on anything else, which turns logic bugs into loud
// errors instead of silent corruption.
const TRANSITIONS = {
  [PHASES.LOBBY]: [PHASES.WORD_SELECTION],
  [PHASES.WORD_SELECTION]: [PHASES.DRAWING, PHASES.ROUND_END, PHASES.LOBBY],
  [PHASES.DRAWING]: [PHASES.ROUND_END, PHASES.LOBBY],
  [PHASES.ROUND_END]: [PHASES.NEXT_ROUND, PHASES.LOBBY],
  [PHASES.NEXT_ROUND]: [PHASES.WORD_SELECTION, PHASES.GAME_OVER],
  [PHASES.GAME_OVER]: [PHASES.LOBBY],
};

function setPhase(room, next) {
  if (!TRANSITIONS[room.phase]?.includes(next)) {
    throw new Error(`Illegal phase transition ${room.phase} -> ${next}`);
  }
  room.phase = next;
}

const fail = (code, message) => ({ ok: false, error: { code, message } });

// ---------- pure helpers (no sockets) ----------

const isLetter = (ch) => /[a-z0-9]/i.test(ch);

/** Indexes of the characters in `word` that can be hidden/revealed (spaces and hyphens are always shown). */
function letterIndexes(word) {
  const out = [];
  for (let i = 0; i < word.length; i += 1) if (isLetter(word[i])) out.push(i);
  return out;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The blank pattern guessers see, as an array with one entry per character:
 * '_' = hidden letter, a letter = revealed hint, ' ' / '-' = literal separator.
 */
function buildPattern(game) {
  const revealed = new Set(game.revealOrder.slice(0, game.hintsShown));
  return [...game.word].map((ch, i) => (!isLetter(ch) ? ch : revealed.has(i) ? ch : '_'));
}

// ---------- chat / guess text helpers ----------

export const MAX_MESSAGE_LENGTH = 100;

/**
 * Validate and clean a chat/guess string: must be a string, control characters are dropped,
 * runs of whitespace collapse to one space, and the result is trimmed. Too long or empty is
 * rejected (never silently truncated, which could turn a right guess into a wrong one).
 */
function cleanMessage(raw) {
  if (typeof raw !== 'string') return fail(ERROR_CODES.INVALID_MESSAGE, 'Type something first.');
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return fail(ERROR_CODES.INVALID_MESSAGE, 'Type something first.');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return fail(ERROR_CODES.INVALID_MESSAGE, `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return { ok: true, text };
}

/** Normalization used for matching: the cleaned text, lower-cased. Words are stored the same way. */
const normalizeGuess = (text) => text.toLowerCase();

/** True if `text` (normalized) contains `word` as whole word(s), e.g. "its a cat" for "cat". */
function containsWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

function standings(room) {
  const turnPoints = room.game?.turnPoints ?? {};
  return [...room.players.values()].map((p) => ({
    id: p.id,
    username: p.username,
    score: p.score,
    delta: turnPoints[p.id] ?? 0,
  }));
}

/** Competition ranking (1,1,3): equal scores share a rank; ties keep lobby join order. */
function buildLeaderboard(room) {
  const sorted = [...room.players.values()].sort((a, b) => b.score - a.score); // stable sort
  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) rank = i + 1;
    return { rank, id: p.id, username: p.username, score: p.score };
  });
}

/** Leaderboard plus this-turn info, for the live panel. Rank/score are decided here, never by clients. */
function liveLeaderboard(room) {
  const g = room.game;
  return buildLeaderboard(room).map((e) => ({
    ...e,
    delta: g?.turnPoints?.[e.id] ?? 0,
    guessed: Boolean(g?.correct.includes(e.id)),
  }));
}

/** Players still due to draw in the current round (skips anyone who has left). */
function remainingDrawers(room) {
  return room.game.queue.filter((id) => room.players.has(id));
}

/**
 * Turn rotation. A "round" = every player present at the round's start draws once, in lobby
 * join order (the order of room.players, which is a Map and keeps insertion order).
 *  - A player who left is skipped lazily when their turn would come up.
 *  - Nobody can join mid-game (addPlayer rejects it), and a disconnect removes the player
 *    (there is no session resume yet), so a returning client is a brand-new player and can
 *    only join a later game from the lobby.
 *  - Returns the next drawer's id, or null when all configured rounds are done.
 *  - Consumes the queue: call it exactly once per turn.
 */
function takeNextDrawer(room) {
  const g = room.game;
  for (;;) {
    while (g.queue.length > 0) {
      const id = g.queue.shift();
      if (room.players.has(id)) {
        g.turnInRound += 1;
        return id;
      }
    }
    if (g.round >= g.totalRounds) return null;
    g.round += 1;
    g.queue = [...room.players.keys()];
    g.turnInRound = 0;
  }
}

/** Who will probably draw next (read-only; used only for the round_end preview). */
function peekNextDrawer(room) {
  const g = room.game;
  const next = remainingDrawers(room)[0];
  if (next) return next;
  if (g.round < g.totalRounds) return room.players.keys().next().value ?? null;
  return null;
}

function newGame(room) {
  return {
    turnId: 0, //                  increments every turn; lets clients/timers detect stale data
    round: 0, //                   1-based once the first turn starts
    totalRounds: room.settings.rounds,
    queue: [], //                  ids still to draw this round
    turnInRound: 0,
    drawerId: null,
    // ---- SECRET (never serialized to everyone) ----
    wordOptions: null, //          what the drawer may pick from, while WORD_SELECTION
    word: null, //                 the chosen word, while DRAWING
    revealOrder: [], //            random order in which letters are revealed as hints
    // ---- public ----
    hintsShown: 0,
    hintsTotal: 0,
    hintTimes: [], //              epoch ms at which each hint is revealed
    durationMs: 0, //              length of the current phase's countdown
    deadline: null, //             epoch ms when the current phase's countdown ends
    turnPoints: {}, //             points earned this turn by player id (guessers + drawer bonus)
    correct: [], //                ids of players who guessed this turn's word, in order (Phase 5)
    lastRound: null, //            reveal data, only exposed during ROUND_END
    results: null, //              final leaderboard, only exposed in GAME_OVER
    usedWords: new Set(), //       avoid repeating words within a game
    // ---- timer bookkeeping ----
    timer: null,
    armId: 0,
  };
}

// ---------- public views ----------

/** The broadcast game block. Contains NO secrets: only the blank pattern, never the word. */
function publicGame(room) {
  const g = room.game;
  if (!g) return null;
  const drawer = g.drawerId ? room.players.get(g.drawerId) : null;
  return {
    phase: room.phase,
    turnId: g.turnId,
    round: g.round,
    totalRounds: g.totalRounds,
    turn: g.turnInRound,
    turnsInRound: g.turnInRound + remainingDrawers(room).length,
    drawerId: g.drawerId,
    drawerName: drawer?.username ?? null,
    pattern: room.phase === PHASES.DRAWING && g.word ? buildPattern(g) : null,
    wordLength: room.phase === PHASES.DRAWING && g.word ? letterIndexes(g.word).length : null,
    hintsShown: g.hintsShown,
    hintsTotal: g.hintsTotal,
    guessedIds: g.correct.filter((id) => room.players.has(id)), // who already guessed this turn (public, no secret)
    guessersTotal: room.players.size - (g.drawerId && room.players.has(g.drawerId) ? 1 : 0),
    leaderboard: liveLeaderboard(room), //                          server-computed ranking, updated after every score
    durationMs: g.durationMs,
    deadline: g.deadline,
    serverNow: Date.now(), // lets clients correct for clock differences
    lastRound: room.phase === PHASES.ROUND_END ? g.lastRound : null,
    results: room.phase === PHASES.GAME_OVER ? g.results : null,
  };
}

/** Room snapshot + game block: the payload of every game_state event and room ack. */
export function publicRoomState(room) {
  return { ...serializeRoom(room), game: publicGame(room) };
}

// ---------- the engine ----------

export function createGameEngine(io) {
  const toRoom = (room, event, payload) => io.to(room.code).emit(event, payload);
  const toPlayer = (playerId, event, payload) => io.to(playerId).emit(event, payload); // every socket auto-joins a room named by its own id
  const broadcastState = (room) => toRoom(room, EVENTS.GAME_STATE, publicRoomState(room));

  /**
   * Send one chat_message. `audience` = null -> everyone in the room; otherwise an array of
   * player ids (each gets the identical payload). `scope` tells the client how widely it was sent.
   */
  function emitChat(room, { kind, scope = 'all', playerId = null, text }, audience = null) {
    room.chatSeq = (room.chatSeq ?? 0) + 1;
    const payload = {
      id: room.chatSeq,
      kind, //       'chat' | 'guess' (a wrong guess) | 'correct' | 'system'
      scope, //      'all' | 'guessed' (only the drawer and players who already guessed)
      playerId,
      playerName: playerId ? room.players.get(playerId)?.username ?? null : null,
      text,
      turnId: room.game?.turnId ?? null,
      ts: Date.now(),
    };
    if (audience) for (const id of new Set(audience)) toPlayer(id, EVENTS.CHAT_MESSAGE, payload);
    else toRoom(room, EVENTS.CHAT_MESSAGE, payload);
  }

  /** The drawer plus everyone who already guessed: the only people who may see "word talk". */
  const knowers = (room) => {
    const g = room.game;
    return [g.drawerId, ...g.correct].filter((id) => id && room.players.has(id));
  };

  /** True when at least one eligible guesser exists and ALL of them have guessed correctly. */
  function allEligibleGuessed(room) {
    const g = room.game;
    const eligible = [...room.players.keys()].filter((id) => id !== g.drawerId);
    // No eligible guessers (e.g. everyone but the drawer disconnected): NEVER "all guessed".
    // Fewer than 2 players aborts the game to the lobby instead, so this stays a safety net.
    if (eligible.length === 0) return false;
    return eligible.every((id) => g.correct.includes(id));
  }

  function clearTimer(room) {
    const g = room.game;
    if (g?.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    if (g) g.armId += 1; // invalidates a callback that is already queued
  }

  /** (Re)arm the room's single timer for its next event: a hint reveal or the phase deadline. */
  function armTimer(room) {
    const g = room.game;
    clearTimer(room);
    let wakeAt = g.deadline;
    if (room.phase === PHASES.DRAWING) {
      const nextHint = g.hintTimes[g.hintsShown];
      if (nextHint !== undefined && nextHint < wakeAt) wakeAt = nextHint;
    }
    const { armId } = g;
    g.timer = setTimeout(() => {
      try {
        onWake(room, g, armId);
      } catch (err) {
        console.error('Game timer error:', err);
      }
    }, Math.max(0, wakeAt - Date.now()));
  }

  function onWake(room, g, armId) {
    // Stale wake-up (room disposed, game replaced, timer re-armed): ignore.
    if (room.game !== g || g.armId !== armId) return;
    g.timer = null;
    const now = Date.now();
    const due = (t) => now + 2 >= t; // setTimeout can fire a millisecond early

    if (room.phase === PHASES.WORD_SELECTION) {
      autoChooseWord(room);
    } else if (room.phase === PHASES.DRAWING) {
      if (due(g.deadline)) {
        endTurn(room, 'time');
      } else {
        let revealed = false;
        while (g.hintsShown < g.hintsTotal && due(g.hintTimes[g.hintsShown])) {
          g.hintsShown += 1;
          revealed = true;
        }
        if (revealed) broadcastState(room); // the pattern (never the word) goes to everyone
        armTimer(room);
      }
    } else if (room.phase === PHASES.ROUND_END) {
      advance(room);
    }
  }

  // ----- turn lifecycle -----

  function beginTurn(room, drawerId) {
    const g = room.game;
    setPhase(room, PHASES.WORD_SELECTION);
    g.turnId += 1;
    g.drawerId = drawerId;
    g.word = null;
    g.revealOrder = [];
    g.hintsShown = 0;
    g.hintsTotal = 0;
    g.hintTimes = [];
    g.turnPoints = {};
    g.correct = [];
    g.lastRound = null;
    g.wordOptions = pickWordOptions(room.settings.wordChoices, g.usedWords);

    // Fresh canvas for every turn: wipe the server history and tell every client to clear.
    drawing.resetSession(room);
    toRoom(room, EVENTS.CANVAS_CLEAR, {});

    g.durationMs = TIMING.wordSelectMs;
    g.deadline = Date.now() + g.durationMs;
    armTimer(room);

    // round_start goes to each player individually so ONLY the drawer's copy has the options.
    const common = {
      turnId: g.turnId,
      round: g.round,
      totalRounds: g.totalRounds,
      turn: g.turnInRound,
      drawerId,
      drawerName: room.players.get(drawerId)?.username ?? null,
      drawTime: room.settings.drawTime,
      selectionDeadline: g.deadline,
      serverNow: Date.now(),
    };
    for (const player of room.players.values()) {
      toPlayer(player.id, EVENTS.ROUND_START, {
        ...common,
        wordOptions: player.id === drawerId ? [...g.wordOptions] : null,
      });
    }
    broadcastState(room);
  }

  function applyWord(room, word, auto) {
    const g = room.game;
    g.word = word;
    g.usedWords.add(word);
    g.wordOptions = null;

    // Hints: at most half of the letters, and at least one letter always stays hidden.
    const slots = letterIndexes(word);
    g.revealOrder = shuffle(slots);
    g.hintsTotal = Math.min(room.settings.hints, Math.floor(slots.length / 2));
    g.hintsShown = 0;

    setPhase(room, PHASES.DRAWING);
    const startedAt = Date.now();
    g.durationMs = scaledDrawMs(room);
    g.deadline = startedAt + g.durationMs;
    // Hint k (1..N) is revealed at k/(N+1) of the way through the drawing time.
    g.hintTimes = Array.from({ length: g.hintsTotal }, (_, k) => startedAt + (g.durationMs * (k + 1)) / (g.hintsTotal + 1));
    armTimer(room); // replaces the word-selection timer: still exactly one timer

    toPlayer(g.drawerId, EVENTS.WORD_CHOSEN, { turnId: g.turnId, word, auto });
    broadcastState(room);
  }

  function autoChooseWord(room) {
    const g = room.game;
    if (room.phase !== PHASES.WORD_SELECTION || !g.wordOptions?.length) return;
    const pick = g.wordOptions[Math.floor(Math.random() * g.wordOptions.length)];
    applyWord(room, pick, true);
  }

  function advance(room) {
    if (room.phase !== PHASES.ROUND_END) return;
    setPhase(room, PHASES.NEXT_ROUND);
    const next = takeNextDrawer(room);
    if (next === null) finishGame(room);
    else beginTurn(room, next);
  }

  function finishGame(room) {
    const g = room.game;
    setPhase(room, PHASES.GAME_OVER);
    clearTimer(room);
    g.drawerId = null;
    g.word = null;
    g.wordOptions = null;
    g.deadline = null;
    g.durationMs = 0;

    drawing.resetSession(room);
    toRoom(room, EVENTS.CANVAS_CLEAR, {});

    const leaderboard = buildLeaderboard(room);
    const winners = leaderboard.filter((e) => e.rank === 1);
    g.results = {
      winner: winners.length === 1 ? winners[0] : null, // null on a tie (see `winners`)
      winners,
      leaderboard,
    };
    toRoom(room, EVENTS.GAME_OVER, g.results);
    broadcastState(room);
  }

  function abortToLobby(room) {
    clearTimer(room);
    room.game = null;
    for (const p of room.players.values()) p.score = 0; // an abandoned game must not leave stale scores in the lobby
    setPhase(room, PHASES.LOBBY);
    drawing.resetSession(room);
    toRoom(room, EVENTS.CANVAS_CLEAR, {});
    broadcastState(room);
  }

  // ----- public engine API -----

  /** Host already verified by the caller. Starts round one. */
  function startGame(room) {
    if (room.phase !== PHASES.LOBBY) return fail(ERROR_CODES.WRONG_PHASE, 'The game has already started.');
    if (room.players.size < 2) return fail(ERROR_CODES.NOT_ENOUGH_PLAYERS, 'At least 2 players are needed to start.');

    for (const p of room.players.values()) p.score = 0;
    drawing.resetSession(room);
    room.game = newGame(room);
    const first = takeNextDrawer(room); // starts round 1 and returns the first player in join order
    beginTurn(room, first);
    return { ok: true };
  }

  /**
   * Host (checked by the caller) sends everyone back to the lobby after GAME_OVER so the same
   * group can play again: scores and game data are reset and new players may join again.
   * Only legal in GAME_OVER, so a double click or a late request cannot disturb a running game.
   */
  function returnToLobby(room) {
    if (room.phase !== PHASES.GAME_OVER) return fail(ERROR_CODES.WRONG_PHASE, 'You can only play again after the game is over.');
    clearTimer(room);
    room.game = null;
    for (const p of room.players.values()) p.score = 0;
    setPhase(room, PHASES.LOBBY);
    drawing.resetSession(room);
    toRoom(room, EVENTS.CANVAS_CLEAR, {});
    broadcastState(room);
    return { ok: true };
  }

  /** Drawer picks one of the offered words. Everything is validated against server state. */
  function chooseWord(room, playerId, rawWord) {
    const g = room.game;
    if (!g || room.phase !== PHASES.WORD_SELECTION) {
      return fail(ERROR_CODES.WRONG_PHASE, 'You can only choose a word at the start of your turn.');
    }
    if (g.drawerId !== playerId) return fail(ERROR_CODES.NOT_DRAWER, 'Only the current drawer can choose the word.');
    if (typeof rawWord !== 'string') return fail(ERROR_CODES.INVALID_WORD, 'Choose one of the offered words.');
    const word = rawWord.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!g.wordOptions.includes(word)) return fail(ERROR_CODES.INVALID_WORD, 'That word was not one of your choices.');
    applyWord(room, word, false);
    return { ok: true, word };
  }

  /**
   * End the current turn. Safe to call from any trigger (timer, drawer left, and later
   * "everyone guessed"): only the FIRST call while the turn is active does anything, because
   * the phase flips to ROUND_END synchronously before anything is emitted.
   */
  function endTurn(room, reason) {
    const g = room.game;
    if (!g || (room.phase !== PHASES.WORD_SELECTION && room.phase !== PHASES.DRAWING)) {
      return fail(ERROR_CODES.WRONG_PHASE, 'There is no active turn to end.');
    }
    const drawerId = g.drawerId;
    const word = g.word; // null if the drawer left before a word was chosen

    setPhase(room, PHASES.ROUND_END); // <- the guard: a second endTurn() now returns early
    clearTimer(room);

    // Close the drawer's unfinished stroke so every canvas shows the same final picture.
    const openStroke = drawing.closeActiveStroke(room, drawerId);
    if (openStroke) toRoom(room, EVENTS.DRAW_DATA, { phase: 'end', strokeId: openStroke });

    g.wordOptions = null;
    g.lastRound = {
      turnId: g.turnId,
      round: g.round,
      drawerId,
      drawerName: room.players.get(drawerId)?.username ?? null,
      word, // revealed to everyone NOW, after the turn is over
      reason, // 'time' | 'drawer_left' | 'all_guessed'
      scores: standings(room),
    };
    g.durationMs = TIMING.roundEndMs;
    g.deadline = Date.now() + g.durationMs;
    armTimer(room);

    const nextDrawerId = peekNextDrawer(room);
    toRoom(room, EVENTS.ROUND_END, { ...g.lastRound, nextDrawerId, isLastTurn: nextDrawerId === null, revealMs: g.durationMs });
    emitChat(room, { kind: 'system', text: word ? `The word was "${word}".` : 'No word was chosen this turn.' });
    broadcastState(room);
    return { ok: true };
  }

  /**
   * A guess from a guesser. Everything is decided from server state:
   *  - phase must be DRAWING (so it fails once the turn has ended: the round-ended guard),
   *  - the sender must be in the room, not the drawer, and not have scored already this turn,
   *  - the guess matches only if the normalized text EQUALS the secret word (no partial match).
   * A wrong guess never reveals anything about the word to the sender.
   */
  function submitGuess(room, playerId, rawText) {
    const g = room.game;
    const player = room.players.get(playerId);
    if (!player) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in this room.');
    if (!g) return fail(ERROR_CODES.WRONG_PHASE, 'Guesses are only accepted while someone is drawing.');
    if (room.phase !== PHASES.DRAWING || !g.word) return fail(ERROR_CODES.WRONG_PHASE, 'Guesses are only accepted while someone is drawing.');
    if (playerId === g.drawerId) return fail(ERROR_CODES.NOT_ELIGIBLE, 'The drawer cannot guess their own word.');
    if (g.correct.includes(playerId)) return fail(ERROR_CODES.ALREADY_GUESSED, 'You already guessed the word this turn.');
    const msg = cleanMessage(rawText);
    if (!msg.ok) return msg;
    const guess = normalizeGuess(msg.text);

    if (guess !== g.word) {
      // Wrong guess: private feedback to the sender, and the text shown in chat like skribbl does.
      toPlayer(playerId, EVENTS.GUESS_RESULT, {
        turnId: g.turnId, correct: false, playerId, playerName: player.username, points: 0, place: null,
      });
      // If the text CONTAINS the answer ("it's a cat"), showing it to the room would hand over
      // the word. Only the sender (who sees the same echo as always), the drawer and players who
      // already guessed get it. The sender's ack/echo are identical either way: no oracle.
      const leaks = containsWord(guess, g.word);
      emitChat(room, { kind: 'guess', playerId, text: msg.text }, leaks ? [playerId, ...knowers(room)] : null);
      return { ok: true, correct: false };
    }

    // ---- correct guess: score it, exactly once per player per turn ----
    const place = g.correct.length; // 0-based
    const points = pointsForGuess(place);
    g.correct.push(playerId);
    player.score += points;
    g.turnPoints[playerId] = points;

    let bonus = 0;
    const drawer = room.players.get(g.drawerId);
    if (place === 0 && drawer) {
      bonus = drawerBonus(g.correct.length);
      drawer.score += bonus;
      g.turnPoints[drawer.id] = (g.turnPoints[drawer.id] ?? 0) + bonus;
    }

    toRoom(room, EVENTS.GUESS_RESULT, {
      turnId: g.turnId, correct: true, playerId, playerName: player.username, points, place: place + 1, drawerBonus: bonus,
    });
    emitChat(room, { kind: 'correct', playerId, text: `${player.username} guessed the word!` });

    // endTurn() broadcasts the new state itself; otherwise broadcast the updated scores now.
    if (allEligibleGuessed(room)) endTurn(room, 'all_guessed');
    else broadcastState(room);
    return { ok: true, correct: true, points, place: place + 1 };
  }

  /**
   * General chat. Policy (documented in docs/EVENTS.md):
   *  - word_selection / round_end: open to everyone, except the drawer during word_selection.
   *  - drawing: guessers who have not guessed yet must use `guess` (their messages ARE guesses).
   *    The drawer and players who already guessed can chat, but only they see it, so the
   *    answer can never be talked about in front of players still guessing.
   *  - lobby / game_over: not handled here (no chat panel).
   */
  function sendChat(room, playerId, rawText) {
    const g = room.game;
    const player = room.players.get(playerId);
    if (!player) return fail(ERROR_CODES.NOT_IN_ROOM, 'You are not in this room.');
    if (!g) return fail(ERROR_CODES.WRONG_PHASE, 'Chat is not available right now.');
    const msg = cleanMessage(rawText);
    if (!msg.ok) return msg;

    if (room.phase === PHASES.DRAWING) {
      const knows = playerId === g.drawerId || g.correct.includes(playerId);
      if (!knows) return fail(ERROR_CODES.CHAT_RESTRICTED, 'While a round is running, type your guess in the guess box.');
      emitChat(room, { kind: 'chat', scope: 'guessed', playerId, text: msg.text }, knowers(room));
    } else if (room.phase === PHASES.WORD_SELECTION || room.phase === PHASES.ROUND_END) {
      if (room.phase === PHASES.WORD_SELECTION && playerId === g.drawerId) {
        return fail(ERROR_CODES.CHAT_RESTRICTED, 'Pick a word first.');
      }
      emitChat(room, { kind: 'chat', playerId, text: msg.text });
    } else {
      return fail(ERROR_CODES.WRONG_PHASE, 'Chat is not available right now.');
    }
    return { ok: true };
  }

  /** Call after rooms.removePlayer() when the room still exists. */
  function handlePlayerLeft(room, removed) {
    const g = room.game;
    if (!g || room.phase === PHASES.LOBBY || room.phase === PHASES.GAME_OVER) return;

    if (room.players.size < 2) {
      abortToLobby(room); // a game needs at least two players
      return;
    }
    const turnActive = room.phase === PHASES.WORD_SELECTION || room.phase === PHASES.DRAWING;
    if (turnActive && removed.id === g.drawerId) endTurn(room, 'drawer_left');
    // A guesser leaving mid-drawing may leave only players who already guessed: end the turn
    // then (allEligibleGuessed is false when nobody eligible is left, so that case never ends it here).
    else if (room.phase === PHASES.DRAWING && allEligibleGuessed(room)) endTurn(room, 'all_guessed');
    // Otherwise nothing to do: the leaver is skipped when the drawer queue reaches them.
  }

  /** Role-filtered recovery snapshot for one player (join, reload of the UI, socket reconnect). */
  function syncFor(room, playerId) {
    const g = room.game;
    const isDrawer = Boolean(g) && g.drawerId === playerId;
    const you = { role: isDrawer ? 'drawer' : 'guesser', turnId: g?.turnId ?? null };
    if (isDrawer && room.phase === PHASES.WORD_SELECTION) you.wordOptions = [...g.wordOptions];
    if (isDrawer && room.phase === PHASES.DRAWING) you.word = g.word;
    return { room: publicRoomState(room), you };
  }

  /** Stop a room's timer (room deleted). */
  function disposeRoom(room) {
    clearTimer(room);
    room.game = null;
  }

  /** Stop every timer (server shutdown). */
  function shutdown() {
    for (const room of allRooms()) disposeRoom(room);
  }

  return { startGame, returnToLobby, chooseWord, submitGuess, sendChat, endTurn, handlePlayerLeft, syncFor, disposeRoom, shutdown };
}
