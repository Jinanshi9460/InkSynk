# InkSynk — Architecture Documentation

This document provides a comprehensive technical overview of the **InkSynk** architecture, including frontend design, backend modules, Socket.IO network protocol, server-authoritative state management, and security mechanisms.

---

## 1. High-Level System Architecture

InkSynk is designed around a **Server-Authoritative, Event-Driven Architecture**. Clients never mutate game state directly; they dispatch validated requests with acknowledgements (`emitWithAck`), while the server validates rules, updates in-memory room records, manages authoritative timers, and broadcasts state diffs to room members.

```text
       ┌────────────────────────┐                   ┌────────────────────────┐
       │     React Client A     │                   │     React Client B     │
       │    (Active Drawer)     │                   │    (Active Guesser)    │
       └───────────┬────────────┘                   └───────────▲────────────┘
                   │                                            │
   draw_start / draw_move / chat                   draw_data / chat_message / game_state
                   │                                            │
                   ▼                                            │
       ┌────────────────────────────────────────────────────────┴────────────┐
       │                    InkSynk Socket.IO Server                         │
       │                         (Node.js + Express)                         │
       │                                                                     │
       │  ┌───────────────────────┐             ┌─────────────────────────┐  │
       │  │    Rate Limiter       │             │    Security & Payload   │  │
       │  │ (Sliding Window 150/s)│             │       Sanitizer         │  │
       │  └───────────┬───────────┘             └────────────┬────────────┘  │
       │              ▼                                      ▼               │
       │  ┌───────────────────────────────────────────────────────────────┐  │
       │  │              Authoritative Game Engine & Rooms                │  │
       │  │   • In-Memory Room Map (`rooms.js`)                           │  │
       │  │   • State Machine: Lobby -> Select -> Draw -> Reveal -> Over  │  │
       │  │   • Authoritative Timers (`game.js`)                          │  │
       │  │   • Point Calculation (`scoring.js`)                          │  │
       │  │   • Stroke Buffer & History (`drawing.js`)                    │  │
       │  │   • Secret-Word Masking & Hint Generator (`words.js`)         │  │
       │  └───────────────────────────────────────────────────────────────┘  │
       └─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Frontend Architecture (`/client`)

The frontend is a single-page React 18 application bundled with Vite.

### Directory Structure & Responsibilities

```text
client/src/
├── components/
│   ├── Header.jsx          # Brand logo, room indicator, sound toggle, live status
│   ├── PlayerList.jsx      # Dynamic avatars, drawer pencil, guess checkmarks, score
│   ├── DrawingCanvas.jsx   # HTML5 2D canvas with DPR scaling and normalized coords
│   ├── DrawingToolbar.jsx  # Palette swatches, brush sizing, eraser, undo, clear
│   ├── Timer.jsx           # Authoritative countdown sync with urgency audio ticks
│   ├── WordChoices.jsx     # Private drawer word selection modal
│   ├── WordHint.jsx        # 3D tile hints with flip animation for revealed letters
│   ├── ChatPanel.jsx       # Dual-mode (guess vs chat), quick reactions, audio chime
│   ├── Leaderboard.jsx     # Live match standings with podium badges & delta chips
│   ├── GameOver.jsx        # 3D winner podium, tie resolution, and confetti burst
│   ├── SettingsForm.jsx    # Controlled room configuration inputs
│   └── SettingsSummary.jsx # Read-only rule chips
├── hooks/
│   ├── useSocket.js        # Socket connection lifecycle, ack timeouts, event bus
│   ├── useGameSession.js   # Drawer private session data (word options, chosen word)
│   └── useChat.js          # Chat stream, wrong guesses, and system announcements
├── lib/
│   ├── audio.js            # Pure Web Audio API synthesizer for procedural sound effects
│   ├── confetti.js         # Canvas particle explosion engine (0 dependencies)
│   └── drawingRenderer.js  # Canvas stroke normalization, segment rendering, redraws
├── pages/
│   ├── Home.jsx            # Hero banner, avatar picker, warm-up pad, room create/join
│   ├── Lobby.jsx           # Room code hero, player grid, share options, host controls
│   └── Game.jsx            # 3-column game arena, keyboard shortcuts, reaction bubbles
├── App.jsx                 # Dynamic page router driven by room.phase, toast notices
├── events.js               # Shared protocol constants, phase enums, and numeric bounds
└── index.css               # Modern arcade design system with glassmorphism & gradients
```

### The Client Drawing Pipeline

1. **Normalized Coordinates (0.0 to 1.0):** Pointer coordinates (`e.clientX`, `e.clientY`) are converted relative to the canvas bounding rect and divided by the displayed width and height. This ensures drawings render identically on a 4K monitor, iPad, or mobile phone.
2. **Device Pixel Ratio (DPR) Scaling:** The internal bitmap is scaled by `window.devicePixelRatio` while CSS dimensions remain responsive.
3. **Point Batching:** Points collected during drawing are buffered and dispatched every 30ms (up to 100 points per batch). This throttles network traffic to ~33 packets/second per drawer without lag.
4. **Local Optimistic Rendering:** The drawer renders their own strokes locally immediately. The server does *not* echo drawing events back to the drawer, eliminating double-rendering artifacts.
5. **Full Stroke History:** All clients maintain an identical ordered array of completed and active strokes. When resized or when Undo/Clear is broadcast, the canvas redraws deterministically from history.

---

## 3. Backend Architecture (`/server`)

The backend is built with Express (health endpoints) and Socket.IO (bidirectional game traffic).

### Module Map

* **`index.js`:** Express server initialization, Socket.IO setup, CORS policy, process signal handling (`SIGINT`, `SIGTERM`), and root event routing.
* **`rooms.js`:** In-memory store for room entities (`Map<code, Room>`). Handles room creation with 5-character unambiguous codes (`A-Z, 2-9`, omitting `0/O/1/I/L`), player join/leave, host migration, and automatic empty-room garbage collection.
* **`game.js`:** Core authoritative game loop. Implements the phase state machine, interval countdown timers, drawer rotation queue, guess submission validation, early turn termination, and game-over calculations.
* **`drawingHandlers.js` & `drawing.js`:** Handles `draw_start`, `draw_move`, `draw_end`, `draw_undo`, and `canvas_clear`. Validates that only the designated drawer may emit drawing events and caps strokes at 1000 per turn.
* **`scoring.js`:** The authoritative point calculator. Awards tiered points based on guess arrival sequence (1st: 100, 2nd: 80, 3rd: 60, 4th: 40, 5th+: 20) and awards +50 bonus points to the drawer if at least one player guesses.
* **`words.js`:** 300+ curated word dictionary with difficulty tiers, random selection, and dynamic hint generator.
* **`rateLimit.js`:** Sliding-window rate limiter protecting against socket flooding (draw events: 150/sec; chat/guesses: 10 per 5 sec; room actions: 15 per 10 sec).

---

## 4. State Machine & Game Lifecycle

Rooms transition through five authoritative phases managed exclusively by `game.js`:

```text
 ┌───────────────┐
 │     LOBBY     │ <────────────────────────────────────────┐
 └───────┬───────┘                                          │
         │ Host starts game (>= 2 players)                  │
         ▼                                                  │
 ┌───────────────┐                                          │
 │WORD_SELECTION │ ◄─────────────────────────┐              │
 └───────┬───────┘                           │              │
         │ Drawer chooses word               │              │
         │ (or auto-picked on 15s timeout)   │              │
         ▼                                   │              │
 ┌───────────────┐                           │              │
 │    DRAWING    │                           │              │
 └───────┬───────┘                           │              │
         │ Timer expires OR all guess        │              │
         ▼                                   │              │
 ┌───────────────┐                           │              │
 │   ROUND_END   │ ── Next turn / drawer ────┘              │
 └───────┬───────┘                                          │
         │ All rounds completed                             │
         ▼                                                  │
 ┌───────────────┐                                          │
 │   GAME_OVER   │ ── Host clicks "Play Again" ─────────────┘
 └───────────────┘
```

* **`lobby`:** Players join, host configures rounds (2–10), draw time (15–240s), hints (0–5), and max players (2–16).
* **`word_selection`:** Server sends 3 private word choices to the drawer. A 15-second countdown runs; if the drawer doesn't pick, a word is automatically selected.
* **`drawing`:** The drawer sketches; guessers submit guesses. Hints reveal progressively as the timer runs down. The turn ends early if all guessers guess correctly.
* **`round_end`:** 5-second reveal pause. The secret word is revealed to everyone, turn points are displayed, and the canvas is cleared for the next turn.
* **`game_over`:** Final scores, winner(s), and podium rankings are displayed. The host can trigger `play_again` to return everyone to the lobby with scores reset.

---

## 5. Security, Anti-Cheat & Secret-Word Secrecy

1. **Secret Word Never Leaked:** 
   - Public state broadcasts (`game_state`) only contain the hint pattern (e.g. `_ _ a _ _`) and letter count.
   - The plain text word is sent **only** to the active drawer via a private event (`word_chosen` ack / `session.word`).
   - Guesses are checked entirely on the server. If a guess is wrong, the secret word is never exposed in the error or broadcast.
   - The word is only broadcast to everyone upon entering `round_end`.
2. **Authoritative Point Computation:**
   - Clients never send point values or report scores. Points are calculated exclusively in `server/scoring.js` and stored in the server's room memory.
3. **Role Enforcement:**
   - Every socket event (`draw_move`, `draw_undo`, `canvas_clear`) validates that `socket.id === room.game.drawerId` and `room.phase === 'drawing'`. Spoofed IDs are rejected.
4. **Strict Payload Sanitization:**
   - Non-object payloads, arrays, and primitive numbers/strings sent to object handlers are rejected immediately with `INVALID_PAYLOAD`.
   - Usernames and room codes strip control characters, zero-width spaces, and RTL override characters.
5. **Memory Caps & Resource Protection:**
   - `MAX_ROOMS` defaults to 500 rooms.
   - `maxHttpBufferSize` is capped at 64 KB (rejects oversized binary/JSON payloads).
   - Canvas strokes capped at 1000 strokes/turn and 5000 points/stroke.
