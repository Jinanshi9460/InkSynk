# Socket.IO event contract (through Phase 6)

Source of truth: `server/events.js` (client copy: `client/src/events.js`, keep identical).

Every client -> server request uses an **acknowledgement**:
- success: `{ ok: true, ...data }`
- failure: `{ ok: false, error: { code, message } }`

The server derives the player ID (`socket.id`), the host, and the room (`socket.data.roomCode`).
Any host/player/room ID sent by a client other than the join `roomCode` is ignored.

## Client -> server

| Event | Payload | Ack (success) | Notes |
|---|---|---|---|
| `create_room` | `{ username, settings? }` | `{ ok, playerId, room }` | Settings optional (defaults apply); if present they are validated in full. Creator becomes host. |
| `join_room` | `{ roomCode, username }` | `{ ok, playerId, room }` | Code is case-insensitive. Rejects: not found, full, already started, name taken. |
| `leave_room` | `{}` | `{ ok }` | Same cleanup path as disconnect. |
| `update_settings` | `{ settings }` | `{ ok, room }` | Host only, lobby only; `maxPlayers` can't go below current player count. |
| `start_game` | `{}` | `{ ok }` | Host only, lobby only, needs >= 2 players. Phase 4: starts round 1 (first drawer = first player in lobby join order). |
| `word_chosen` | `{ word }` | `{ ok, word }` | Drawer only, `word_selection` phase only; `word` must be one of the options offered to that drawer (compared trimmed + lower-case). See Game flow. |
| `sync_game` | `{}` | `{ ok, room, you }` | Any room member. Role-filtered recovery snapshot (see Game flow). |

## Server -> client

| Event | Payload | When |
|---|---|---|
| `player_joined` | `{ player: { id, username } }` | To everyone *else* in the room when someone joins. |
| `player_left` | `{ playerId, username, newHostId }` | Someone left/disconnected. `newHostId` is null unless the host changed. |
| `game_state` | public room snapshot (below) | After every join/leave/settings change, phase change and hint reveal. Clients should replace their room state with it. Never contains the secret word. |

## Drawing events (Phase 3)

All drawing events are scoped to the sender's server-side room (`socket.data.roomCode`); a client can never address another room. Mutating events require **the current drawer** (server-decided, see below) and phase `drawing`; otherwise the ack is `{ ok:false, error }` (`NOT_DRAWER`, `WRONG_PHASE`, `NOT_IN_ROOM`) and nothing is broadcast.

**Coordinates are normalized** (`x`,`y` in 0..1 of canvas width/height, clamped and rounded to 4 decimals by the server). Brush `size` is an integer 1-50 in "virtual pixels" of an 800px-wide canvas; clients scale it with their canvas width. The canvas has a fixed 4:3 aspect ratio, so strokes stay aligned at any display size.

### Client -> server
| Event | Payload | Ack | Notes |
|---|---|---|---|
| `draw_start` | `{ strokeId, x, y, color, size, mode }` | `{ ok }` | `strokeId` is client-generated (`[A-Za-z0-9_-]{6,40}`, unique per session). `mode`: `pen` or `eraser`. `color` `#rrggbb` (eraser is forced to `#ffffff`). Starting a new stroke auto-closes the previous one. |
| `draw_move` | `{ strokeId, points: [[x,y], ...] }` | `{ ok }` | 1-100 points per message. The client batches points (every ~30 ms) instead of one message per pixel. A stroke holds at most 5000 points. |
| `draw_end` | `{ strokeId }` | `{ ok }` | Marks the stroke completed (only completed strokes can be undone). |
| `draw_undo` | `{}` | `{ ok, strokeId }` | Removes the most recent **completed** stroke. `NOTHING_TO_UNDO` if none. |
| `canvas_clear` | `{}` | `{ ok }` | Empties the history. |
| `draw_sync` | `{}` | `{ ok, drawerId, strokes }` | **Any room member.** Full ordered history; in-progress strokes have `done:false`. Used on mount / "Resync canvas". |

Stroke shape: `{ id, color, size, mode, points: [[x,y],...], done }`. At most 1000 strokes per session (`TOO_MANY_STROKES`; clear to continue).

### Server -> client
| Event | Payload | Sent to |
|---|---|---|
| `draw_data` | `{ phase:'start', stroke }` / `{ phase:'move', strokeId, points }` / `{ phase:'end', strokeId }` | everyone in the room **except the drawer** (the drawer already rendered it locally, so nothing is drawn twice) |
| `draw_undo` | `{ strokeId }` | **everyone in the room, including the drawer** |
| `canvas_clear` | `{}` | **everyone in the room, including the drawer** |

Undo/clear are applied from the broadcast on every client (also the drawer's), so all canvases change from the same server-confirmed event and redraw from history.

### Session lifecycle
The stroke history (`room.drawing`) is created empty by `start_game` and **reset at the start of every turn** (the server also broadcasts `canvas_clear`), and again at game over. If the drawer disconnects mid-stroke the server closes that stroke and broadcasts `draw_data {phase:'end'}`.

### Who may draw (Phase 4, replaces the temporary Phase 3 rule)
Implemented only in `server/drawPermission.js`. A drawing event is accepted only if **all** hold: the sender is in a room, `room.phase === "drawing"`, and `socket.id === room.game.drawerId` (the server's own record - a `drawerId` in a client payload is ignored). Otherwise the ack is `{ ok:false, error }` with `WRONG_PHASE` (not the drawing phase: lobby, word selection, round end, game over) or `NOT_DRAWER`, and nothing is broadcast. `dev_set_drawer` no longer exists.

## Game flow (Phase 4)

### Phases (state machine, server-owned)
```
lobby -> word_selection -> drawing -> round_end -> next_round -> word_selection ... -> game_over
```
`next_round` is a transient step (the next drawer is picked and the phase immediately moves on) so clients only see `lobby`, `word_selection`, `drawing`, `round_end`, `game_over`. If fewer than 2 players remain, any in-game phase returns to `lobby` (game discarded, canvas cleared).

| Phase | Ends when | Countdown (`game.deadline`) |
|---|---|---|
| `word_selection` | drawer sends a valid `word_chosen`, **or** 15 s pass (server auto-picks one of the offered words, `auto:true`), **or** the drawer leaves | 15 s |
| `drawing` | `drawTime` seconds after the word was chosen, **or** every eligible guesser guessed correctly (`all_guessed`), **or** the drawer leaves | `settings.drawTime` |
| `round_end` | 5 s reveal pause | 5 s |

Exactly one timer exists per room (`room.game.timer`). Every end condition goes through `endTurn()`, which flips the phase to `round_end` *before* emitting anything, so two simultaneous triggers (timer + drawer leaving) produce exactly one `round_end`.

### Turn order, departures and reconnects
- A **round** = every player present at the round's start draws once, in **lobby join order** (`room.players` insertion order). Total turns = `rounds x players`.
- A player who leaves is skipped when their turn would come up; if the **drawer** leaves the turn ends at once (`reason: "drawer_left"`).
- Joining after the game starts is rejected (`GAME_IN_PROGRESS`), and a disconnect removes the player (there is no session resume yet), so there is no mid-game reconnect: a returning client is a brand-new player who may join a *later* game from the lobby. `sync_game` is the recovery path for a client that is **still in the room** but lost state (UI remount, missed event, socket re-attached): it restores everything, including the drawer's private data.
- Host leaving transfers host to the longest-present player (unchanged).

### Server -> client events
| Event | Payload | Sent to |
|---|---|---|
| `round_start` | `{ turnId, round, totalRounds, turn, drawerId, drawerName, drawTime, selectionDeadline, serverNow, wordOptions }` | **Each player separately.** `wordOptions` (1-5 unique words) is present **only in the drawer's copy**; everyone else gets `wordOptions: null`. |
| `word_chosen` | `{ turnId, word, auto }` | **The drawer's socket only.** `auto:true` means the server picked because the drawer was too slow. |
| `game_state` | room snapshot incl. `game` block (below) | Whole room (public data only) |
| `round_end` | `{ turnId, round, drawerId, drawerName, word, reason, scores, nextDrawerId, isLastTurn, revealMs }` | Whole room. **First moment the word is revealed** (`word` is `null` if the drawer left before choosing). `reason`: `time`, `drawer_left`, `all_guessed`. `scores`: `[{ id, username, score, delta }]`. `nextDrawerId` is a preview (`null` after the last turn). |
| `game_over` | `{ winner, winners, leaderboard }` | Whole room. `leaderboard`: `[{ rank, id, username, score }]` sorted by score (equal scores share a rank, ties keep join order). `winner` is `null` on a tie; `winners` lists everyone ranked 1. |
| `canvas_clear` | `{}` | Whole room, at the start of every turn and at game over |

### `game_state.game` block (public - safe for every player)
```json
{
  "phase": "drawing", "turnId": 3, "round": 2, "totalRounds": 3, "turn": 1, "turnsInRound": 4,
  "drawerId": "<socket id>", "drawerName": "Alice",
  "pattern": ["_", "_", "a", "_", " ", "_", "_"],   // only while drawing; '_' hidden, letter = hint, ' ' / '-' literal
  "wordLength": 6, "hintsShown": 1, "hintsTotal": 2,
  "durationMs": 60000, "deadline": 1769251234567, "serverNow": 1769251200000,
  "lastRound": null,                                 // round_end data, only during phase round_end
  "results": null                                    // final leaderboard, only during phase game_over
}
```
`deadline` is the **server's** epoch-ms deadline for the current phase; clients compute `remaining = deadline - (Date.now() + (serverNow - clientNowAtReceipt))`, so no per-second ticks are broadcast. The game block is `null` in the lobby. The secret word is **never** in it.

### Hints
`settings.hints` = number of letters revealed over the drawing time (0 disables). Hint *k* of *N* is revealed at *k/(N+1)* of the drawing time, in a random letter order chosen by the server; the pattern is then re-broadcast in `game_state`. At most half of a word's letters are ever revealed (`min(hints, floor(letters/2))`) so at least one always stays hidden.

### `sync_game` (recovery)
Ack: `{ ok, room, you }` - `room` is the public snapshot; `you` is `{ role: "drawer"|"guesser", turnId, wordOptions? , word? }` where `wordOptions` appears only for the drawer during `word_selection` and `word` only for the drawer during `drawing`. A guesser can never receive either.

### Secrecy rules (enforced and tested)
Options and the secret word live only in `room.game` on the server. They are sent only to the drawer's own socket (`round_start`, `word_chosen`, `sync_game` acks). Broadcast payloads (`game_state`, `canvas_clear`, `draw_data`, ...) never contain them, and `round_end` reveals the word only after the turn is over.

## Chat, guessing and scoring (Phase 5)

All messages are validated on the server: must be a string; control characters are dropped, whitespace runs collapse to one space, the result is trimmed, and it must be 1-100 characters (longer is **rejected**, never truncated, so a right guess cannot silently turn wrong). Guesses and chat share a flood limit of **10 messages per 5 s per socket** (`RATE_LIMITED`), which also blunts scripted brute-force guessing.

### Client -> server
| Event | Payload | Ack | Notes |
|---|---|---|---|
| `guess` | `{ text }` | `{ ok, correct, points?, place? }` | Only while phase is `drawing`. Errors: `WRONG_PHASE` (any other phase, including after the turn ended), `NOT_ELIGIBLE` (the drawer), `ALREADY_GUESSED`, `INVALID_MESSAGE`, `RATE_LIMITED`, `NOT_IN_ROOM`. A wrong guess is `{ ok:true, correct:false }` and reveals nothing. |
| `chat` | `{ text }` | `{ ok }` | See the chat policy below. Errors: `CHAT_RESTRICTED`, `WRONG_PHASE` (lobby / game over), `INVALID_MESSAGE`, `RATE_LIMITED`. |

### Server -> client
| Event | Payload | Sent to |
|---|---|---|
| `guess_result` | `{ turnId, correct, playerId, playerName, points, place, drawerBonus? }` | **correct guess:** the whole room (`points`, 1-based `place`, `drawerBonus` is 50 on the first correct guess, else 0). **wrong guess:** the sender only (`correct:false`, `points:0`). The word is never in it. |
| `chat_message` | `{ id, kind, scope, playerId, playerName, text, turnId, ts }` | See audiences below. `id` is unique per room (dedupe / React key). `kind`: `chat`, `guess` (a wrong guess), `correct` (`"<name> guessed the word!"`, the guess text is never included), `system` (e.g. the word reveal after a turn). `scope`: `all` or `guessed`. |
| `game_state` | includes `game.guessedIds` and `game.leaderboard` | whole room, after every scoring event |

### Matching rule
`trim` -> drop control chars -> collapse internal whitespace -> `toLowerCase()` -> **exact equality** with the secret word (which is stored in the same normalized form). There is deliberately no partial / fuzzy matching: `"cat"` does not match `"cats"` or `"ca"`, and a guess can never confirm part of the word.

### Scoring (the implementation's own rule; single source: `server/scoring.js`)
| Event | Points |
|---|---|
| 1st / 2nd / 3rd / 4th correct guesser in a turn | 100 / 80 / 60 / 40 |
| 5th and later correct guessers | 20 (minimum) |
| Drawer | +50, once per turn, at the moment of the first correct guess (nothing if nobody guesses) |
| Wrong guess, repeat guess, the drawer "guessing" | 0 |

A player can score at most once per turn (`ALREADY_GUESSED`). Scores live in `player.score` on the server for the whole game, are only reset by `start_game`, and every client reads them from `game_state` (`players[].score`, `game.leaderboard`), so all clients show identical numbers. Per-turn gains are in `game.leaderboard[].delta` and in `round_end.scores[].delta`.

### Chat policy (what may be said when)
| Phase | Who may chat | Who sees it |
|---|---|---|
| `drawing`, player still guessing | nobody: their input is a **guess** (`chat` -> `CHAT_RESTRICTED`) | wrong guesses are shown to the whole room |
| `drawing`, the drawer or a player who already guessed | yes | **only** the drawer and players who already guessed (`scope: "guessed"`), so the answer can never be discussed in front of players still guessing |
| `word_selection` | everyone except the drawer (`CHAT_RESTRICTED`: could leak the options) | whole room |
| `round_end` | everyone | whole room |
| `lobby`, `game_over` | not available (`WRONG_PHASE`) | - |

**Answer-containing guesses.** If a wrong guess contains the answer as a whole word (e.g. `"it's a cat"` when the word is `cat`) it is *not* shown to the room. Only the sender, the drawer and players who already guessed receive it. The sender's ack and echo are identical to a normal wrong guess, so this cannot be used to probe the word.

### Ending a turn early / races
- `all_guessed`: when every player except the drawer has guessed correctly. It is checked after each correct guess **and** when a player leaves mid-drawing (the remaining eligible players may then all have guessed). If there is **no** eligible guesser (everyone but the drawer left) the turn is never ended as `all_guessed`; with fewer than 2 players the game returns to the lobby (Phase 4 rule).
- Every end condition (timer, `all_guessed`, drawer left) goes through `endTurn()`, which flips the phase to `round_end` synchronously before emitting. Node handles events one at a time, so a guess arriving after that point gets `WRONG_PHASE` and a late timer is a no-op: exactly one `round_end` per turn, and no score changes after it.
- The word is first revealed in `round_end` (and in a `system` chat line right after it).

## Phase 6 additions

### `play_again` (client -> server)
`{}` -> ack `{ ok: true }`. Host only (`NOT_HOST` otherwise) and only in the `game_over` phase (`WRONG_PHASE` otherwise, so a double click is harmless). The room returns to `lobby`, every score is reset to 0, `game` becomes `null`, a `canvas_clear` is sent and a fresh `game_state` is broadcast. New players may join again and the host can `start_game` for another game.

### Rate limits (per socket, `RATE_LIMITED` when exceeded)
| Events | Limit |
|---|---|
| `guess`, `chat` | 10 per 5 s (combined) |
| `draw_start`, `draw_move`, `draw_end`, `draw_undo`, `canvas_clear` | 150 per 1 s |
| `create_room`, `join_room`, `update_settings`, `start_game`, `play_again` | 15 per 10 s (combined) |
| `sync_game`, `draw_sync` | 30 per 10 s (combined) |

Messages larger than 64 KB close the offending connection (Socket.IO `maxHttpBufferSize`). `GET /anything-else` returns a JSON 404.

## Room snapshot

```json
{
  "code": "AB3KX",
  "hostId": "<socket id>",
  "phase": "lobby | word_selection | drawing | round_end | game_over",
  "drawerId": "<socket id> | null",   // same as game.drawerId
  "game": null,                        // see "game_state.game block"; null in the lobby
  "settings": { "maxPlayers": 8, "rounds": 3, "drawTime": 60, "wordChoices": 3, "hints": 2, "isPublic": false },
  "players": [{ "id": "...", "username": "Alice", "score": 0, "isHost": true }]
}
```

## Settings

| Key | Type | Range | Default |
|---|---|---|---|
| `maxPlayers` | int | 2-20 | 8 |
| `rounds` (a.k.a. totalRounds) | int | 2-10 | 3 |
| `drawTime` | int (seconds) | 15-240 | 60 |
| `wordChoices` (a.k.a. wordCount) | int | 1-5 | 3 |
| `hints` | int | 0-5 (0 = disabled) | 2 |
| `isPublic` | boolean | - | false |

`isPublic` is metadata only for now (no public room browser yet).

## Error codes
`INVALID_WORD` (word not among the offered options), `SERVER_BUSY` (Phase 6: `MAX_ROOMS` reached), `INVALID_PAYLOAD` is now also returned for any request whose payload is not a plain object, `INVALID_MESSAGE, NOT_ELIGIBLE, ALREADY_GUESSED, CHAT_RESTRICTED, RATE_LIMITED` (Phase 5), `INVALID_PAYLOAD, INVALID_USERNAME, NAME_TAKEN, ROOM_NOT_FOUND, ROOM_FULL, GAME_IN_PROGRESS, ALREADY_IN_ROOM, NOT_IN_ROOM, NOT_HOST, WRONG_PHASE, NOT_ENOUGH_PLAYERS, INVALID_SETTINGS, NOT_DRAWER, INVALID_STROKE, TOO_MANY_STROKES, NOTHING_TO_UNDO, SERVER_ERROR` (client-side only: `NOT_CONNECTED, TIMEOUT`).

## Testing the game timers
`GAME_TIME_SCALE` (e.g. `0.1`) shortens every game timer so tests can run a whole game in seconds. It is ignored when `NODE_ENV=production`. `GET /health` also reports `timers` (rooms with a live game timer) to prove timers are cleaned up when rooms go away.

## Limitation
All rooms live in server memory. A server restart (or a free-tier host sleeping) wipes every room, and connected clients are returned to the Home screen.
