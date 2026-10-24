# InkSynk — Real-Time Multiplayer Drawing & Guessing Game

InkSynk is a modern, vibrant real-time multiplayer drawing and guessing game built with React, Node.js, Express, and Socket.IO. Draw fast, guess faster, and stay in synk!

**Status: Phases 0–6 complete** (rooms, drawing, game loop, chat/guessing/scoring, hardening). Deployment (Render) is the next step. See [Phase 6](#-phase-6--hardening-responsive-ui-and-bug-fixing) for what was verified and what was not.

---

## 🚀 Phase 0 Scope & Completed Features

- **Authoritative Server Architecture**: All game state and rules are validated and stored exclusively on the server. Clients never dictate room state, host permissions, or phase transitions.
- **Room Lifecycle**:
  - Host creates a room with custom or default settings and receives a unique 5-character room code (using an unambiguous character set: no `0/O`, `1/I/L`).
  - Players join rooms via room code or direct invite link (`?room=CODE`).
  - Real-time room broadcast (`game_state`) keeping all clients synchronized.
  - Automatic host migration if the active host leaves or disconnects.
  - Automatic cleanup of empty rooms to avoid memory leaks.
  - Safe reversion to lobby if player count drops below 2 during a game.
- **Input Validation & Security**:
  - Sanitization of usernames (stripping ASCII control characters, trimming whitespace, length limit 1–20).
  - Case-insensitive duplicate name prevention within each room.
  - Case-insensitive room code lookup.
  - Capacity enforcement (`maxPlayers` limits).
  - Late-join prevention once a game is in progress.
  - Strict host-only permissions for settings modification and starting the game.
  - Rigorous numeric boundary checks for room settings (rounds, draw time, max players, word choices, hints).
- **Socket Protocol**:
  - Client-to-server request/acknowledgement pattern with timeout handling (`timeout(8000).emitWithAck(...)`).
  - Server-to-client reactive broadcast events (`game_state`, `player_joined`, `player_left`).
- **Responsive UI**:
  - Clean card-based design with subtle purple/violet accent palette.
  - Live connection status indicator (green/amber dot).
  - One-click copy for room codes and invite links.
  - Dedicated Home, Lobby, and Game phase screens.

---

## 🛠️ Tech Stack

### Frontend (`/client`)
- **React 18** + **Vite** (ES modules)
- **Socket.IO Client (`socket.io-client`)**
- **Modern CSS** (CSS Variables, Flexbox, Grid, fully responsive layout)

### Backend (`/server`)
- **Node.js** + **Express**
- **Socket.IO**
- In-memory room store (zero database dependencies needed for MVP)
- CORS support with configurable origins

---

## 📁 Project Structure

```
skribbl-clone/
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Header.jsx        # App header with live connection status
│   │   │   ├── PlayerList.jsx    # Live player roster with host badge & scores
│   │   │   ├── ChatPanel.jsx     # Phase 5: chat history + guess/chat input
│   │   │   └── Leaderboard.jsx   # Phase 5: live server-ranked leaderboard
│   │   ├── hooks/
│   │   │   └── useSocket.js      # Socket connection, ack requests, subscriptions
│   │   ├── pages/
│   │   │   ├── Home.jsx          # Username entry, create room, join with code
│   │   │   ├── Lobby.jsx         # Settings form, invite link, start game
│   │   │   └── Game.jsx          # In-game screen
│   │   ├── App.jsx               # Page router based on room phase
│   │   ├── events.js             # Shared socket event constants & limits
│   │   ├── index.css             # Polished CSS styles
│   │   └── main.jsx
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── server/
│   ├── events.js                 # Authoritative event names & error codes
│   ├── index.js                  # Express & Socket.IO server setup & handlers
│   ├── rooms.js                  # In-memory room management logic
│   ├── game.js                   # Game engine: turns, timers, guesses, chat, early end
│   ├── scoring.js                # Phase 5: the ONLY place point values live
│   ├── smoke-phase5.mjs          # Phase 5 tests (111 checks)
│   ├── smoke-test.mjs            # Quick smoke test script (21 checks)
│   ├── phase0-test.mjs           # Comprehensive automated test suite (53 checks)
│   ├── .env.example
│   └── package.json
├── .gitignore
└── README.md
```

---

## 🔌 Socket.IO Events Reference

### Client → Server (Requests with Acknowledgements)

| Event | Payload | Ack Response | Description |
| :--- | :--- | :--- | :--- |
| `create_room` | `{ username }` | `{ ok: true, playerId, room }` or `{ ok: false, error }` | Creates a room and registers socket as host |
| `join_room` | `{ roomCode, username }` | `{ ok: true, playerId, room }` or `{ ok: false, error }` | Joins an existing room |
| `leave_room` | `{}` | `{ ok: true }` or `{ ok: false, error }` | Voluntarily leaves current room |
| `update_settings` | `{ settings }` | `{ ok: true, room }` or `{ ok: false, error }` | Host updates room settings |
| `start_game` | `{}` | `{ ok: true }` or `{ ok: false, error }` | Host transitions room from lobby to game |
| `play_again` | `{}` | `{ ok: true }` or `{ ok: false, error }` | **Phase 6.** Host only, only in `game_over`: back to the lobby with scores reset |
| `guess` | `{ text }` | `{ ok, correct, points?, place? }` or `{ ok: false, error }` | **Phase 5.** A guess; drawing phase only, never for the drawer, scores once per player per turn |
| `chat` | `{ text }` | `{ ok: true }` or `{ ok: false, error }` | **Phase 5.** General chat, restricted while drawing (see below) |

### Server → Client (Broadcasts)

| Event | Payload | Description |
| :--- | :--- | :--- |
| `game_state` | `{ code, hostId, phase, settings, players }` | Full room snapshot broadcast to all players in the room |
| `player_joined` | `{ player: { id, username } }` | Broadcast to existing players when someone joins |
| `player_left` | `{ playerId, username, newHostId }` | Broadcast when a player leaves or disconnects |
| `guess_result` | `{ turnId, correct, playerId, playerName, points, place }` | **Phase 5.** Correct guess -> whole room; wrong guess -> the sender only. Never contains the word |
| `chat_message` | `{ id, kind, scope, playerId, playerName, text, turnId, ts }` | **Phase 5.** Chat lines, wrong guesses, `X guessed the word!`, system notes. Audience depends on `scope` |
| `round_end` | `{ word, reason, scores, ... }` | The word is revealed here; `reason` is `time`, `all_guessed` or `drawer_left` |
| `game_over` | `{ winner, winners, leaderboard }` | Final ranking; `winner` is `null` on a tie |

---

## 🎯 Phase 5 — Chat, Guessing, Scoring & Leaderboard

The main loop now works end to end: **draw → guess → award points → end round → next drawer → final winner.** Full payloads are in [`docs/EVENTS.md`](docs/EVENTS.md).

**Guessing** (`server/game.js` → `submitGuess`): accepted only in the `drawing` phase, from a player who is not the drawer and has not already scored this turn. The text is trimmed, control characters are dropped, whitespace is collapsed and it is lower-cased, then compared for **exact equality** with the secret word. There is no partial matching, so a guess can never reveal part of the answer and a wrong guess reveals nothing.

**Scoring** (one function, `server/scoring.js` - this is the implementation's own rule, not the assignment's):

| Event | Points |
| :--- | :--- |
| 1st / 2nd / 3rd / 4th correct guess | 100 / 80 / 60 / 40 |
| 5th and later correct guesses | 20 |
| Drawer, if at least one player guesses | +50 (once per turn) |

Scores are kept in the room on the server for the whole game and are never reset between rounds, only by starting a new game.

**Chat policy.** While a round is running, a player who has not guessed yet types only guesses (shown to everyone if wrong). The drawer and players who already guessed may chat, but only they see it, so the answer is never discussed in front of players still guessing. A wrong guess that *contains* the answer (e.g. "it's a cat") is shown only to the sender, the drawer and players who already guessed. Chat is open to all during word selection (except the drawer) and the round-end pause.

**Round end.** A turn ends when the timer runs out, when **every** eligible guesser has guessed (also re-checked when a guesser leaves), or when the drawer leaves. If nobody eligible is left, it is never treated as "all guessed" (fewer than 2 players returns to the lobby). All paths go through one idempotent `endTurn()`, so timer expiry, simultaneous guesses and duplicate guesses can never produce two `round_end`s or extra points. The word is revealed to everyone in `round_end`.

**UI.** `ChatPanel.jsx` (history, one input that is a guess or a chat depending on your role, inline error text), `Leaderboard.jsx` (rank, name, score, this-turn gain, all taken from the server's `game.leaderboard`), and a result panel after each turn. The game screen is now three columns: players | canvas | leaderboard + chat.

**Tests** (`cd server && npm test`; each suite starts its own server on a spare port):

| Script | Checks |
| :--- | :--- |
| `npm run smoke` | 28 (rooms) |
| `npm run smoke:draw` | 57 (drawing) |
| `npm run smoke:game` | 112 (state machine, words, timers) |
| `npm run smoke:phase5` | 111 (guessing, scoring, chat audiences, early end, races, leaving players, whole games over real sockets, rate limit) |

**Known limitations:** chat history is kept only in each browser (a player who reloads loses it, and there is no mid-game rejoin yet); rate limiting is per socket; the word list and leaderboard are in memory only.

---

## 🛡️ Phase 6 — Hardening, responsive UI and bug fixing

Phase 6 was a stabilisation pass: no new architecture, no new dependencies. Everything below was checked by running code (see *How this was verified*).

### What changed

| Area | Change |
| :--- | :--- |
| Payload validation | Every socket handler now rejects non-object payloads (`"text"`, `42`, arrays) with `INVALID_PAYLOAD` before any logic runs. Unexpected exceptions return a generic `SERVER_ERROR`; stack traces only go to the server log. |
| Room codes / usernames | Room codes are validated (3–8 letters/digits) before lookup. Usernames also lose zero-width and bidi-override characters, so a name cannot look blank or spoof another player. |
| Flood protection | New sliding-window limiter (`server/rateLimit.js`): guesses/chat 10 per 5 s (unchanged), drawing events 150 per second, create/join/start/settings 15 per 10 s, sync requests 30 per 10 s. `maxHttpBufferSize` is 64 KB (a draw batch is about 2 KB), so oversized messages drop the connection instead of being buffered. `MAX_ROOMS` (default 500) caps memory. |
| Play again | **Bug:** after the final leaderboard the room was stuck in `game_over` and could never be reused (new players could not join, there was only "Leave room"). Added host-only `play_again` (`game_over` → `lobby`, scores reset) and a **Play again** button; non-hosts see "Waiting for the host…". |
| Aborted games | **Bug:** when a game was aborted to the lobby (fewer than 2 players left) the old scores stayed in the lobby player list. Scores are now reset. |
| HTTP | JSON 404 and a JSON 500 handler without internals, `X-Powered-By` removed, localhost-in-production warning for `CLIENT_URL`. |
| Client connection state | New "Cannot reach server – retrying…" state (a sleeping free-tier server no longer looks like an endless blank "Connecting…"), socket listeners removed on unmount, toast timers cleaned up. |
| Forms | Home validates name, room code and settings ranges before sending; Enter in the name box creates/joins; double clicks on Start / Save / Undo / Clear / Choose word are ignored while a request is in flight. |
| Layout | Guess box sits directly under the canvas on tablets/phones, 44 px touch targets and 16 px inputs on phones (no iOS zoom), `100dvh`, visible keyboard focus on swatches/summary/chat log, reduced-motion support. |
| Accessibility | Status lines use `role="status"`, errors `role="alert"`, canvas label says whether you may draw, chat log is keyboard-scrollable, no noisy live region on the leaderboard. |
| Build config | `vite.config.js` warns when a production build would point at localhost. `.env.example` files document `PORT`, `CLIENT_URL`, `MAX_ROOMS`, `VITE_SERVER_URL`. `engines.node >= 18`. |
| Tests | New `smoke-phase6.mjs` (112 checks). The old `phase0-test.mjs` still expected the Phase 0 phase name `playing`; it is updated and now part of `npm test`. |

### Already correct (verified, not changed)

Server-side host and drawer checks; duplicate names (case-insensitive); full rooms; late join; empty-room cleanup and timer cleanup; one `round_end` when a timer and the last correct guess race; repeated `start_game` / `word_chosen`; secret-word privacy in every broadcast; batched draw points (30 ms) with a 100-point cap per message; redraw from stable stroke history on resize/undo/clear.

### How this was verified

Run in the build sandbox:

* `cd server && npm test` — all server suites (Phases 0–6).
* A scripted **two-browser run** (two independent Chromium contexts against the real server): create → invite link → join → duplicate-name rejection → start → word choice → drawing mirrored to the guesser (pixel counts equal) → a non-drawer dragging on the canvas changes nothing → undo → wrong/right guess → scoreboard equal on both screens → 4 turns → game over → Play again → leave and rejoin; plus a layout sweep at 320, 375, 414, 600, 768, 900, 1024, 1280 and 1600 px (no horizontal overflow; canvas, toolbar and chat inside the viewport) and a count of socket listeners (never more than one per event).

**Not verified in the sandbox:** the npm registry was blocked, so the real `vite build` (React 18.3.1 + Vite 5) could not run. The client was compiled and tested as a stand-in bundle with esbuild and React 19. Run `npm install && npm run build` in `client/` on your machine before deploying. Touch drawing on a real phone, Safari/Firefox and the deployed Render URL have not been tested.

### Two-browser manual test matrix

Use two browser windows (or one normal + one private window; for the phone row use a real phone on the same network or Chrome DevTools device mode). A = host, B = guest.

| # | Step | Expected |
| :-- | :--- | :--- |
| 1 | A creates a room (rounds 2, draw time 30) | Room code shown; A is Host |
| 2 | B opens the invite link, enters the **same name** as A | "That username is already taken in this room." |
| 3 | B enters another name | Both lobbies list 2 players; B has no Start button |
| 4 | B types a wrong code / `!!` / leaves it empty | Clear message each time; nothing crashes |
| 5 | A clicks Start (click it twice quickly) | One game starts; only one word-choice panel |
| 6 | Look at the guesser's screen (and DevTools → Network → WS frames) | Only blanks like `_ _ _ (3)`; the word never appears before the round ends |
| 7 | Drawer picks a word and draws, picks a colour/size, eraser | Guesser sees the same strokes within ~0.1 s |
| 8 | Guesser drags on the canvas | Nothing changes on either canvas; tools are greyed out |
| 9 | Drawer: Undo, then Clear (click each several times) | Both canvases stay identical; no errors |
| 10 | Guesser sends a wrong guess, then the right one in different case with spaces | Wrong guess visible to both; right one scores 100 once, drawer +50, round ends early, word revealed |
| 11 | Guesser submits the word again / the drawer types it | "already guessed" / "drawer cannot guess"; no extra points |
| 12 | Let a round run to zero | Round ends, word revealed, no further drawing or scoring |
| 13 | Close the drawer's tab mid-round | Others see the round end ("drawer left"), game continues or returns to lobby with fewer than 2 players |
| 14 | Finish all rounds | Same final leaderboard on both; winner banner |
| 15 | A clicks **Play again** | Both return to the lobby with scores 0; a third window can join; Start works again |
| 16 | Resize a window from 1280 → 375 px wide during a round | No horizontal scroll; canvas keeps its picture; guess box right under the canvas |
| 17 | Stop the server while in a room | Header shows "Disconnected – reconnecting…"; you are returned to Home with a message |

## 🧪 Testing

All server tests start their own server on a spare port and use real Socket.IO connections (no mocks).

```bash
cd server
npm install
npm test            # smoke + phase0 + draw + game + phase5 + phase6
npm run smoke:phase6   # just the Phase 6 suite (112 checks)
```

The client has no unit-test runner (no extra dependencies). Verify it with `cd client && npm run build` and the manual matrix above.

## 💻 Running locally

Two terminals.

```bash
# Terminal 1: backend  (http://localhost:3000, health check at /health)
cd server
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm run dev
```

```bash
# Terminal 2: frontend (http://localhost:5173)
cd client
cp .env.example .env.local  # Windows: copy .env.example .env.local
npm install
npm run dev
```

Open http://localhost:5173 in two windows to play against yourself.

### Environment variables

| Where | Variable | Meaning |
| :--- | :--- | :--- |
| server | `PORT` | Listening port. Read from the environment (Render sets it). Default 3000. |
| server | `CLIENT_URL` | Allowed browser origin(s) for CORS, comma-separated, no trailing slash. **Must be your deployed client URL in production.** |
| server | `MAX_ROOMS` | Optional cap on simultaneous rooms (default 500). |
| server | `GAME_TIME_SCALE` | Tests only (e.g. `0.1`); ignored when `NODE_ENV=production`. |
| client | `VITE_SERVER_URL` | URL of the server. Read **at build time**, so set it in the host's dashboard before building. If it is missing in a production build, the client uses its own origin (never localhost). |

Production notes: build the client with `npm run build` (output in `client/dist`), serve it as a static site, and run the server with `npm start`. A local `client/.env.local` is also read by `vite build`, so do not build the production bundle on a machine whose `.env.local` points at localhost (the build prints a warning if it does).

## ⚠️ Known limitations

* **No reconnect-and-resume.** A disconnect removes the player immediately (no ghost players); a returning player joins as a new player, and only between games. A phone that stops responding for about a minute (ping interval 25 s + timeout 30 s) is dropped from the room.
* **State is in memory.** A server restart or free-tier sleep wipes all rooms.
* **Rate limits are per socket**, not per IP; a determined attacker can open many sockets. There is no authentication.
* **Chat history lives in each browser** and is lost on reload.
* **Public rooms are only a label**; there is no public room browser.
* **Canvas history is capped** (1000 strokes per turn, 5000 points per stroke); the drawer must clear to continue. Very high-frequency drawing beyond 150 events/s from one client is throttled (the drawer's own canvas would then differ from others until "Resync canvas").
* **Not tested on:** real phones/tablets, Safari, Firefox, or the deployed site.
