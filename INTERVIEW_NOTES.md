# InkSynk — Placement Interview Preparation & Technical Deep-Dive

This guide is designed to prepare you to confidently explain **InkSynk** during the Web3Task placement interview. Every answer is grounded directly in the codebase.

---

## 8 Core Architectural Concepts (Beginner-Friendly Explanations)

### 1. How Canvas Captures and Renders Strokes
* **The Problem:** Different devices have different screen sizes, aspect ratios, and pixel densities (DPR). If you send raw screen pixels (e.g. `x: 350, y: 220`), a drawing on a phone will look tiny on a 4K monitor.
* **Our Solution:**
  1. **Coordinate Normalization (0.0 to 1.0):** In `DrawingCanvas.jsx` and `drawingRenderer.js`, we listen for pointer events, subtract the canvas bounding box offset, and divide by the CSS width and height:
     $$\text{normalizedX} = \frac{\text{clientX} - \text{rect.left}}{\text{rect.width}}$$
     $$\text{normalizedY} = \frac{\text{clientY} - \text{rect.top}}{\text{rect.height}}$$
  2. **Device Pixel Ratio (DPR):** We set the canvas bitmap dimensions to `rect.width * window.devicePixelRatio` and scale the 2D context. This keeps lines crisp on Retina/high-res screens without altering the coordinate system.
  3. **Local Optimistic Rendering:** The drawer renders their own lines immediately on pointer move so there is zero drawing latency.

### 2. How Stroke Data is Transmitted with Socket.IO
* **The Problem:** `pointermove` fires at 60Hz to 120Hz. Sending a WebSocket message for every single point causes network congestion and packet drops.
* **Our Solution:**
  * **Batching Every 30ms:** Points are pushed into a local buffer. A `setInterval` flushes the buffered points every 30ms (maximum 100 points per batch, ~33 network packets/sec).
  * **Selective Broadcast:** The server validates the points and broadcasts them using `socket.to(roomCode).emit('draw_data', ...)`. Notice `socket.to(...)` sends to everyone in the room **except** the sender. The drawer never receives their own strokes back, preventing double-rendering.

### 3. Why Socket.IO Rooms are Used
* **The Problem:** In a multiplayer game with dozens of concurrent matches, you cannot broadcast events to all connected clients.
* **Our Solution:**
  * Socket.IO provides **Rooms**—server-side channels where sockets can join or leave (`socket.join(roomCode)` and `socket.leave(roomCode)`).
  * When a player submits a guess, draws, or sends a chat message, the server only emits to that specific room (`io.to(roomCode)`), completely isolating matches from one another with zero cross-talk.

### 4. How the Server Controls Round State and Turn Rotation
* **The Problem:** If clients controlled the game timer or round transitions, malicious players could pause the clock or skip turns.
* **Our Solution:**
  * The server is **Authoritative**. All state lives in `server/game.js`.
  * The server runs a state machine: `lobby` $\rightarrow$ `word_selection` $\rightarrow$ `drawing` $\rightarrow$ `round_end` $\rightarrow$ `game_over`.
  * Each turn, `server/game.js` runs a native Node.js timer (`setTimeout`). When the deadline arrives, the server emits `round_end`. Clients only display a visual countdown calculated from `deadline - (Date.now() + clockOffset)`.
  * Drawer rotation maintains a queue of player IDs based on join order.

### 5. How Word Matching and Scoring Work
* **The Problem:** Players type guesses with weird casing, leading/trailing spaces, or typos.
* **Our Solution:**
  * **Sanitization:** In `server/game.js`, incoming guesses are lowercased, stripped of control characters, trimmed, and multiple spaces are collapsed into single spaces.
  * **Exact Equality:** The sanitized guess is compared against `secretWord.toLowerCase()`. There is no partial matching, so players cannot accidentally trigger a win.
  * **Tiered Speed Scoring (`server/scoring.js`):**
    * 1st correct guess: **100 pts**
    * 2nd correct guess: **80 pts**
    * 3rd correct guess: **60 pts**
    * 4th correct guess: **40 pts**
    * 5th+ correct guess: **20 pts**
    * Drawer bonus: **+50 pts** (awarded once per turn if at least one player guessed).

### 6. How the App Prevents Score Manipulation and Word Leakage
* **Preventing Score Manipulation:** Clients never send point increments or scores. Clients only send `{ text: "apple" }`. The server validates the guess, computes points from `scoring.js`, updates the player's score in memory, and broadcasts the updated score.
* **Preventing Word Leakage:**
  1. The secret word is **never** included in the public room state (`game_state`). Only the blank pattern (e.g. `_ _ _ _ _`) is sent.
  2. The secret word is transmitted **only** to the active drawer via a private event (`session.word`).
  3. Guesses are inspected by the server. Wrong guesses that contain the word (e.g., "is it an apple?") are tagged as secret and visible only to the drawer and solvers who already know the word.
  4. The word is only broadcast to guessers when the turn finishes in `round_end`.

### 7. Why the Initial App Does Not Need a Database
* **The Reason:** InkSynk is an ephemeral party game. Once a match ends, the room and chat history are discarded.
* **Benefits:**
  * **Zero Latency:** In-memory lookups (`Map<string, Room>`) take sub-microsecond time ($\mathcal{O}(1)$), far faster than database queries.
  * **Simplicity & Zero Cost:** No PostgreSQL, MongoDB, or Redis connections to manage or pay for.
  * **Memory Safety:** Inactive rooms are automatically deleted when the last player leaves. An upper limit (`MAX_ROOMS = 500`) prevents memory exhaustion.

### 8. How the App is Deployed and What Environment Variables Do
* **Separation of Concerns:**
  * **Backend (Render Web Service):** Node.js needs a persistent, long-running server process to keep WebSockets open and manage in-memory rooms.
  * **Frontend (Render Static Site or Vercel):** React/Vite builds into static HTML/CSS/JS (`client/dist`) and is hosted on a high-speed CDN.
* **Environment Variables:**
  * `PORT`: Set by the hosting platform (e.g., Render sets `PORT=10000`).
  * `CLIENT_URL`: The allowed frontend domain for CORS (e.g. `https://inksynk.vercel.app`).
  * `VITE_SERVER_URL`: Injected into the React frontend at **build time** so the browser knows where to connect its Socket.IO client.

---

## 10 Most Likely Placement Interview Questions & Model Answers

### Q1: What happens if a player disconnects mid-game?
**Answer:** The server listens to Socket.IO's `disconnect` event. If the active drawer disconnects, the server immediately triggers `endTurn('drawer_left')`, reveals the word, and advances to the next drawer. If the room host disconnects, the server automatically promotes the next oldest player in the room to host. If fewer than 2 players remain, the game safely resets to the lobby.

### Q2: Why didn't you use HTTP polling instead of WebSockets?
**Answer:** Real-time drawing requires continuous streaming of brush coordinates at ~30 packets per second. HTTP polling has massive overhead (TCP handshakes, HTTP headers, ~50ms latency per request). WebSockets maintain a persistent, full-duplex TCP connection, reducing latency to under 10ms with minimal packet headers.

### Q3: What is the difference between Socket.IO and raw WebSockets?
**Answer:** Socket.IO is built on top of WebSockets but provides essential production features out of the box: automatic reconnection with exponential backoff, fallback to HTTP long-polling if WebSockets are blocked by firewalls, built-in room multiplexing, and request-acknowledgement callbacks (`emitWithAck`).

### Q4: How does the client synchronize its countdown timer with the server?
**Answer:** Because clients' device clocks may be out of sync by seconds or minutes, the client cannot simply count down locally. Whenever the server sends a state snapshot, it includes its current epoch timestamp (`serverNow`). The client computes `clockOffset = serverNow - Date.now()` and computes remaining time as `deadline - (Date.now() + clockOffset)`.

### Q5: How do you handle Undo and Clear on the drawing canvas?
**Answer:** Strokes are stored in an authoritative array on the server (`room.game.strokes`). When the drawer clicks Undo, the server pops the last stroke and broadcasts `draw_undo` with the stroke ID. Every client removes that stroke from its local array and executes a full canvas redraw from history.

### Q6: Can a guesser cheat by inspecting the WebSocket network tab in Chrome DevTools?
**Answer:** No. We never send the secret word over WebSocket to any guesser. DevTools only shows incoming `game_state` events containing masked underscores (`_ _ _`). The word only exists in the server's memory and the drawer's private memory until the round officially terminates.

### Q7: How do you protect the server from denial-of-service (DoS) or spam?
**Answer:** We implemented a multi-layered defense in `server/rateLimit.js`:
1. Drawing events are capped at 150 events/second per socket.
2. Chat messages and guesses are limited to 10 per 5 seconds.
3. Socket.IO's `maxHttpBufferSize` is set to 64 KB to reject large payloads.
4. An application-wide `MAX_ROOMS` cap (default 500) prevents heap exhaustion.

### Q8: What is the purpose of coordinate normalization on the canvas?
**Answer:** Canvas pixel dimensions differ based on device screen resolution. By dividing pointer coordinates by CSS width and height, we convert positions to a float between `0.0` and `1.0`. Guesser devices multiply these floats by their own canvas dimensions, ensuring drawings appear identical on all screen sizes.

### Q9: Why is Vite's `VITE_SERVER_URL` inlined at build time, and how does production handle it?
**Answer:** Vite replaces `import.meta.env.VITE_SERVER_URL` with a static string during `npm run build`. Therefore, `VITE_SERVER_URL` must be set in the deployment dashboard before triggering the frontend build. If not set, our code falls back safely to `window.location.origin` instead of defaulting to `localhost`.

### Q10: If this game scales to 100,000 concurrent players, what changes would you make?
**Answer:**
1. **Socket.IO Redis Adapter:** Distribute WebSocket connections across multiple Node.js instances with Redis Pub/Sub for inter-server room broadcasts.
2. **State Store:** Move active room state to Redis or a low-latency key-value cache.
3. **Sticky Sessions:** Configure the load balancer (e.g. AWS ALB or Nginx) with sticky cookies so clients maintain connection to the same server during handshake.

---

## Final Completion Audit

### Core Features Implemented & Verified
* [x] **Authoritative Server Loop:** State machine (`lobby`, `word_selection`, `drawing`, `round_end`, `game_over`), authoritative timers, and turn rotation.
* [x] **Real-time Canvas Sync:** Coordinate normalization, stroke batching, local optimistic rendering, full redraw from stroke history, Undo and Clear.
* [x] **Word Privacy & Hints:** 300+ word dictionary, private drawer delivery, dynamic letter reveals, and secret-containing guess masking.
* [x] **Chat, Guessing & Scoring:** Exact guess matching, speed-tiered points (100/80/60/40/20), drawer bonus (+50), and solver-only secret chat.
* [x] **Modern UI/UX & Responsive Layout:** 3-column game layout, avatar customizer, interactive warm-up doodle pad, 3D winner podium, tie resolution badges.
* [x] **Procedural Audio & Confetti:** Zero-dependency Web Audio synthesizer (clicks, pops, correct chimes, countdown ticks, victory fanfare) and canvas particle bursts.
* [x] **Hardening & Security:** Payload verification, sliding-window rate limiters, 64KB buffer caps, and host migration on disconnect.
* [x] **Automated Test Suite:** 112 smoke-phase6 tests, 111 phase5 tests, 112 game tests, 57 draw tests, 53 phase0 tests, 28 base smoke tests (100% pass rate).

### Features Not Implemented (Intentional MVP Scope)
* Mid-game reconnect-and-resume after complete network drop (disconnected players are cleaned up).
* Persistent user accounts / database auth (ephemeral party sessions only).
* Persistent cross-match global leaderboard.
* Public room lobby browser (rooms are accessed via 5-char code or direct link).
