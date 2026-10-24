// Phase 6 tests: hardening, permissions, races, disconnects, play-again, flood protection.
// Spawns the REAL server (twice: once normally, once with MAX_ROOMS=2) and talks to it with real
// socket.io-client connections. Run with: npm run smoke:phase6
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 4061;
const PORT_SMALL = 4062;

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, extraEnv = {}) {
  const env = { ...process.env, PORT: String(port), CLIENT_URL: 'http://localhost:5173', GAME_TIME_SCALE: '0.1', ...extraEnv };
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ['index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.getOutput = () => out;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    const poll = setInterval(() => {
      if (out.includes('listening')) { clearInterval(poll); clearTimeout(t); resolve(child); }
    }, 50);
    child.on('exit', (c) => reject(new Error(`server exited early (${c}): ${out}`)));
  });
}

async function health(port) {
  const res = await fetch(`http://localhost:${port}/health`);
  return res.json();
}

// A connected test client that records every event it receives.
function connect(port = PORT) {
  return new Promise((resolve, reject) => {
    const sock = io(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    const log = [];
    sock.onAny((ev, payload) => log.push({ ev, payload, at: Date.now() }));
    const c = {
      sock,
      log,
      id: null,
      req: (ev, payload) => sock.timeout(4000).emitWithAck(ev, payload),
      of: (ev, pred = () => true) => log.filter((l) => l.ev === ev && pred(l.payload)).map((l) => l.payload),
      async waitFor(ev, pred = () => true, ms = 6000) {
        const end = Date.now() + ms;
        for (;;) {
          const hit = log.find((l) => l.ev === ev && pred(l.payload));
          if (hit) return hit.payload;
          if (Date.now() > end) throw new Error(`timeout waiting for ${ev}`);
          await sleep(15);
        }
      },
      close: () => sock.close(),
    };
    sock.on('connect', () => { c.id = sock.id; resolve(c); });
    sock.on('connect_error', reject);
  });
}

// Create a room with `names.length` players (first = host). Short settings so games are quick.
async function makeRoom(names, settings = {}, port = PORT) {
  const clients = [];
  for (const name of names) clients.push(await connect(port));
  const created = await clients[0].req('create_room', {
    username: names[0],
    settings: { rounds: 2, drawTime: 15, wordChoices: 3, hints: 0, maxPlayers: 8, ...settings },
  });
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
  for (let i = 1; i < clients.length; i += 1) {
    const joined = await clients[i].req('join_room', { roomCode: created.room.code, username: names[i] });
    if (!joined.ok) throw new Error(`join failed: ${JSON.stringify(joined)}`);
  }
  return { code: created.room.code, clients };
}

const stateOf = (c) => c.of('game_state').at(-1);

/** Wait until the turn `turnId` has started; returns { drawer, guessers, options }. */
async function turnStart(clients, turnId) {
  for (const c of clients) await c.waitFor('round_start', (p) => p.turnId === turnId);
  const drawer = clients.find((c) => c.of('round_start', (p) => p.turnId === turnId).at(-1).wordOptions);
  return {
    drawer,
    guessers: clients.filter((c) => c !== drawer),
    options: drawer.of('round_start', (p) => p.turnId === turnId).at(-1).wordOptions,
  };
}

const server = await startServer(PORT);
let small;
try {
  // ---------------------------------------------------------------- A. payload validation
  console.log('A. malformed payloads');
  {
    const c = await connect();
    for (const bad of ['text', 42, true, ['a'], [[]]]) {
      const r = await c.req('create_room', bad);
      check(`create_room with payload ${JSON.stringify(bad)} -> INVALID_PAYLOAD`, r.ok === false && r.error.code === 'INVALID_PAYLOAD');
    }
    for (const ev of ['join_room', 'update_settings', 'start_game', 'word_chosen', 'guess', 'chat', 'draw_start', 'draw_move', 'draw_end', 'draw_undo', 'canvas_clear', 'play_again']) {
      const r = await c.req(ev, 'nonsense');
      check(`${ev} with a string payload -> INVALID_PAYLOAD`, r.error?.code === 'INVALID_PAYLOAD');
    }
    const noAck = new Promise((resolve) => { c.sock.emit('create_room', { username: 'x' }); setTimeout(resolve, 200); });
    await noAck; // emitting without an ack callback must not crash the server
    check('server survives a request without an ack callback', (await health(PORT)).ok === true);
    c.close();
  }
  {
    const c = await connect();
    check('guess outside a room: NOT_IN_ROOM', (await c.req('guess', { text: 'cat' })).error?.code === 'NOT_IN_ROOM');
    check('chat outside a room: NOT_IN_ROOM', (await c.req('chat', { text: 'hi' })).error?.code === 'NOT_IN_ROOM');
    check('draw_start outside a room: NOT_IN_ROOM', (await c.req('draw_start', {})).error?.code === 'NOT_IN_ROOM');
    check('start_game outside a room: NOT_IN_ROOM', (await c.req('start_game', {})).error?.code === 'NOT_IN_ROOM');
    check('play_again outside a room: NOT_IN_ROOM', (await c.req('play_again', {})).error?.code === 'NOT_IN_ROOM');
    check('error replies never contain a stack trace', !JSON.stringify(await c.req('create_room', { username: 5 })).includes(' at '));
    c.close();
  }

  // ---------------------------------------------------------------- B. usernames and room codes
  console.log('B. username and room-code validation');
  {
    const c = await connect();
    for (const bad of ['', '   ', '​​', '‮', 'x'.repeat(21), null, 7, {}]) {
      const r = await c.req('create_room', { username: bad });
      check(`username ${JSON.stringify(bad)?.slice(0, 20)} rejected`, r.ok === false && r.error.code === 'INVALID_USERNAME');
    }
    const ok = await c.req('create_room', { username: '  Zed​  The   Great‮ ' });
    check('invisible characters are stripped and spaces collapsed', ok.ok && ok.room.players[0].username === 'Zed The Great');
    c.close();

    const j = await connect();
    check('room code "!!" -> clear error', (await j.req('join_room', { roomCode: '!!', username: 'A' })).error?.code === 'ROOM_NOT_FOUND');
    check('missing room code -> clear error', (await j.req('join_room', { username: 'A' })).error?.code === 'ROOM_NOT_FOUND');
    check('well-formed unknown code -> ROOM_NOT_FOUND', (await j.req('join_room', { roomCode: 'ZZZZZ', username: 'A' })).error?.code === 'ROOM_NOT_FOUND');
    check('code of the wrong type -> error, no crash', (await j.req('join_room', { roomCode: { a: 1 }, username: 'A' })).ok === false);
    j.close();
  }

  // ---------------------------------------------------------------- C. joining rules
  console.log('C. duplicate names, full rooms, joining mid-game');
  {
    const { code, clients } = await makeRoom(['Host', 'Guest'], { maxPlayers: 3 });
    const x = await connect();
    check('duplicate name (different case) rejected', (await x.req('join_room', { roomCode: code.toLowerCase(), username: 'hOsT' })).error?.code === 'NAME_TAKEN');
    const third = await x.req('join_room', { roomCode: code, username: 'Third' });
    check('third player fits (maxPlayers 3)', third.ok);
    const y = await connect();
    check('fourth player: ROOM_FULL', (await y.req('join_room', { roomCode: code, username: 'Fourth' })).error?.code === 'ROOM_FULL');
    check('non-host cannot start', (await clients[1].req('start_game', {})).error?.code === 'NOT_HOST');
    check('non-host cannot change settings', (await clients[1].req('update_settings', { settings: { rounds: 5 } })).error?.code === 'NOT_HOST');
    const [r1, r2] = await Promise.all([clients[0].req('start_game', {}), clients[0].req('start_game', {})]);
    check('two simultaneous start_game: exactly one succeeds', [r1, r2].filter((r) => r.ok).length === 1 && [r1, r2].some((r) => r.error?.code === 'WRONG_PHASE'));
    check('exactly one round_start per player (no duplicate turn)', clients[1].of('round_start').length === 1);
    check('join after the game began: GAME_IN_PROGRESS', (await y.req('join_room', { roomCode: code, username: 'Late' })).error?.code === 'GAME_IN_PROGRESS');
    check('settings locked once started', (await clients[0].req('update_settings', { settings: { rounds: 5 } })).error?.code === 'WRONG_PHASE');
    for (const c of [...clients, x, y]) c.close();
  }

  // ---------------------------------------------------------------- D. drawing permissions
  console.log('D. drawing permissions');
  {
    const { clients } = await makeRoom(['Ann', 'Bob', 'Cy']);
    await clients[0].req('start_game', {});
    const { drawer, guessers, options } = await turnStart(clients, 1);
    const stroke = { strokeId: 'stroke_perm_001', x: 0.1, y: 0.1, color: '#000000', size: 5, mode: 'pen' };
    check('drawer cannot draw during word selection', (await drawer.req('draw_start', stroke)).error?.code === 'WRONG_PHASE');
    check('non-drawer cannot clear during word selection', (await guessers[0].req('canvas_clear', {})).error?.code === 'WRONG_PHASE');

    const word = options[0];
    const [c1, c2] = await Promise.all([drawer.req('word_chosen', { word }), drawer.req('word_chosen', { word: options[1] })]);
    check('repeated word selection: exactly one wins', [c1, c2].filter((r) => r.ok).length === 1 && [c1, c2].some((r) => r.error?.code === 'WRONG_PHASE'));
    const chosen = [c1, c2].find((r) => r.ok).word;
    check('a non-drawer cannot choose a word', (await guessers[0].req('word_chosen', { word: chosen })).error?.code === 'WRONG_PHASE');

    check('guesser draw_start -> NOT_DRAWER', (await guessers[0].req('draw_start', stroke)).error?.code === 'NOT_DRAWER');
    check('guesser draw_move -> NOT_DRAWER', (await guessers[0].req('draw_move', { strokeId: stroke.strokeId, points: [[0.2, 0.2]] })).error?.code === 'NOT_DRAWER');
    check('guesser draw_end -> NOT_DRAWER', (await guessers[0].req('draw_end', { strokeId: stroke.strokeId })).error?.code === 'NOT_DRAWER');
    check('guesser draw_undo -> NOT_DRAWER', (await guessers[0].req('draw_undo', {})).error?.code === 'NOT_DRAWER');
    check('guesser canvas_clear -> NOT_DRAWER', (await guessers[1].req('canvas_clear', {})).error?.code === 'NOT_DRAWER');
    check('guessers received no draw_data from their failed attempts', guessers[1].of('draw_data').length === 0);

    check('drawer: bad colour rejected', (await drawer.req('draw_start', { ...stroke, color: 'red' })).error?.code === 'INVALID_STROKE');
    check('drawer: fractional size rejected', (await drawer.req('draw_start', { ...stroke, size: 5.5 })).error?.code === 'INVALID_STROKE');
    check('drawer: NaN-like coordinates rejected', (await drawer.req('draw_start', { ...stroke, x: 'a' })).error?.code === 'INVALID_STROKE');
    check('drawer: valid stroke accepted', (await drawer.req('draw_start', stroke)).ok);
    const tooMany = await drawer.req('draw_move', { strokeId: stroke.strokeId, points: Array.from({ length: 101 }, () => [0.5, 0.5]) });
    check('drawer: more than 100 points per batch rejected', tooMany.error?.code === 'INVALID_STROKE');
    check('drawer: move for an unknown stroke rejected', (await drawer.req('draw_move', { strokeId: 'no_such_stroke', points: [[0.1, 0.1]] })).error?.code === 'INVALID_STROKE');
    check('drawer: batch of 100 accepted', (await drawer.req('draw_move', { strokeId: stroke.strokeId, points: Array.from({ length: 100 }, (_, i) => [i / 100, 0.5]) })).ok);
    check('drawer: end accepted', (await drawer.req('draw_end', { strokeId: stroke.strokeId })).ok);
    await sleep(100);
    check('guessers received the stroke exactly once', guessers.every((g) => g.of('draw_data', (p) => p.phase === 'start').length === 1));

    // multiple undo / clear: idempotent, never negative, everyone ends up consistent
    const undos = await Promise.all([1, 2, 3].map(() => drawer.req('draw_undo', {})));
    check('three simultaneous undos: one removes the stroke, the others get NOTHING_TO_UNDO', undos.filter((r) => r.ok).length === 1 && undos.filter((r) => r.error?.code === 'NOTHING_TO_UNDO').length === 2);
    const clears = await Promise.all([1, 2, 3].map(() => drawer.req('canvas_clear', {})));
    check('repeated clears all succeed harmlessly', clears.every((r) => r.ok));
    const sync = await guessers[0].req('draw_sync', {});
    check('canvas is empty for everyone after undo + clear', sync.ok && sync.strokes.length === 0);
    for (const c of clients) c.close();
  }

  // ---------------------------------------------------------------- E. flood + oversized payloads
  console.log('E. flood protection and oversized payloads');
  {
    const { clients } = await makeRoom(['Ann', 'Bob']);
    await clients[0].req('start_game', {});
    const { drawer, guessers, options } = await turnStart(clients, 1);
    await drawer.req('word_chosen', { word: options[0] });
    await drawer.req('draw_start', { strokeId: 'stroke_flood_01', x: 0.1, y: 0.1, color: '#112233', size: 5, mode: 'pen' });
    const results = await Promise.all(Array.from({ length: 400 }, () => drawer.req('draw_move', { strokeId: 'stroke_flood_01', points: [[0.3, 0.3]] })));
    const limited = results.filter((r) => r.error?.code === 'RATE_LIMITED').length;
    check('400 draw_move in one burst: the excess is RATE_LIMITED', limited >= 200 && results.some((r) => r.ok));
    check('the server is still healthy after the flood', (await health(PORT)).ok);

    const spam = await Promise.all(Array.from({ length: 14 }, () => guessers[0].req('guess', { text: 'nope nope' })));
    check('guess flood: the 11th+ message is RATE_LIMITED', spam.filter((r) => r.error?.code === 'RATE_LIMITED').length >= 4);

    const big = await connect();
    let closed = false;
    big.sock.on('disconnect', () => { closed = true; });
    big.sock.emit('chat', { text: 'x'.repeat(200000) });
    await sleep(600);
    check('a 200 KB message makes the server drop that connection', closed);
    check('...and the server keeps serving everyone else', (await health(PORT)).ok && (await clients[1].req('draw_sync', {})).ok);
    for (const c of clients) c.close();
  }
  {
    const c = await connect();
    const attempts = [];
    for (let i = 0; i < 18; i += 1) attempts.push(await c.req('join_room', { roomCode: 'ZZZZZ', username: 'Spam' }));
    check('join attempts are rate limited (stops room-code brute force)', attempts.some((r) => r.error?.code === 'RATE_LIMITED'));
    c.close();
  }

  // ---------------------------------------------------------------- F. full game, races, privacy, play again
  console.log('F. whole game: simultaneous guesses, secrecy, play again');
  {
    const { code, clients } = await makeRoom(['Ann', 'Bob', 'Cy'], { rounds: 2 });
    const [host, bob, cy] = clients;
    check('play_again before the game is over -> WRONG_PHASE', (await host.req('play_again', {})).error?.code === 'WRONG_PHASE');
    await host.req('start_game', {});

    const words = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      const { drawer, guessers, options } = await turnStart(clients, turn);
      const word = options[0];
      words.push(word);
      await drawer.req('word_chosen', { word });
      if (turn === 1) {
        // two correct guesses at the very same moment: each scores once, places are distinct
        const [g1, g2] = await Promise.all(guessers.map((g) => g.req('guess', { text: ` ${word.toUpperCase()} ` })));
        check('simultaneous correct guesses both accepted', g1.ok && g1.correct && g2.ok && g2.correct);
        check('...with distinct places (100 and 80)', [g1.points, g2.points].sort().join() === '100,80');
        check('repeat guess after scoring -> ALREADY_GUESSED or WRONG_PHASE, no extra points', ['ALREADY_GUESSED', 'WRONG_PHASE'].includes((await guessers[0].req('guess', { text: word })).error?.code));
      } else if (turn === 2) {
        // timeout (nobody guesses): the timer ends the turn and a late guess scores nothing
        const end = await drawer.waitFor('round_end', (p) => p.turnId === 2, 6000);
        check('turn 2 ended by the timer', end.reason === 'time');
        const late = await guessers[0].req('guess', { text: word });
        check('guess after the timer fired: WRONG_PHASE', late.error?.code === 'WRONG_PHASE');
      } else {
        await Promise.all(guessers.map((g) => g.req('guess', { text: word })));
      }
      await drawer.waitFor('round_end', (p) => p.turnId === turn);
    }
    const over = await host.waitFor('game_over');
    check('game_over reached with a leaderboard of 3', over.leaderboard.length === 3);
    for (const c of clients) check('every client got game_over exactly once', c.of('game_over').length === 1);
    check('exactly one round_end per turn on every client', clients.every((c) => c.of('round_end').length === 6));

    // secrecy: before its round_end, a word never appears in anything a NON-drawer received
    let leaks = 0;
    for (let turn = 1; turn <= 6; turn += 1) {
      const word = words[turn - 1];
      const rx = new RegExp(`(^|[^a-z])${word}($|[^a-z])`, 'i');
      for (const c of clients) {
        const start = c.of('round_start', (p) => p.turnId === turn).at(-1);
        if (start.wordOptions) continue; // this client was the drawer
        const endAt = c.log.find((l) => l.ev === 'round_end' && l.payload.turnId === turn).at;
        const startAt = c.log.find((l) => l.ev === 'round_start' && l.payload.turnId === turn).at;
        for (const l of c.log) {
          if (l.at < startAt || l.at >= endAt) continue;
          // the guesser's own correct guess is echoed back in their ack, but not as an event
          if (rx.test(JSON.stringify(l.payload ?? {}))) leaks += 1;
        }
      }
    }
    check('SECRET: no event reached a guesser containing the word before round_end (6 turns)', leaks === 0);

    check('non-host cannot play again', (await bob.req('play_again', {})).error?.code === 'NOT_HOST');
    const again = await host.req('play_again', {});
    check('host play_again succeeds', again.ok);
    const [r2] = await Promise.all([host.req('play_again', {}), 0]);
    check('second play_again is a harmless WRONG_PHASE', r2.error?.code === 'WRONG_PHASE');
    await sleep(100);
    const lobby = stateOf(cy);
    check('everyone is back in the lobby with scores reset', lobby.phase === 'lobby' && lobby.game === null && lobby.players.every((p) => p.score === 0));
    const newcomer = await connect();
    check('a new player can join the lobby again', (await newcomer.req('join_room', { roomCode: code, username: 'Dee' })).ok);
    check('the same group can start another game', (await host.req('start_game', {})).ok);
    await turnStart([host, bob, cy, newcomer], 1);
    check('the new game starts at turn 1 with fresh state', stateOf(bob).game.round === 1 && stateOf(bob).game.leaderboard.every((e) => e.score === 0));
    for (const c of [...clients, newcomer]) c.close();
  }

  // ---------------------------------------------------------------- G. disconnects and cleanup
  console.log('G. disconnects, host migration, cleanup');
  {
    const { clients } = await makeRoom(['Ann', 'Bob', 'Cy'], { drawTime: 60 });
    await clients[0].req('start_game', {});
    const { drawer, guessers, options } = await turnStart(clients, 1);
    await drawer.req('word_chosen', { word: options[0] });
    await drawer.req('draw_start', { strokeId: 'stroke_dc_0001', x: 0.2, y: 0.2, color: '#000000', size: 5, mode: 'pen' });
    drawer.sock.disconnect(); // drawer vanishes mid-stroke
    const end = await guessers[0].waitFor('round_end', (p) => p.turnId === 1);
    check('drawer disconnect ends the turn (drawer_left) and reveals the word', end.reason === 'drawer_left' && end.word === options[0]);
    check('the open stroke was closed for everyone', guessers[0].of('draw_data', (p) => p.phase === 'end').length >= 1);
    const st = stateOf(guessers[0]);
    check('no ghost: the drawer is gone from the player list', st.players.length === 2 && !st.players.some((p) => p.id === drawer.id));
    check('exactly one round_end (no duplicate from the timer)', guessers[0].of('round_end').length === 1);
    const next = await guessers[0].waitFor('round_start', (p) => p.turnId === 2);
    check('the game continues with the next drawer', next.drawerId !== drawer.id);
    guessers[0].sock.disconnect();
    await sleep(300);
    const lobbyState = stateOf(guessers[1]);
    check('only one player left: back to the lobby, scores reset', lobbyState.phase === 'lobby' && lobbyState.players.length === 1 && lobbyState.players[0].score === 0);
    check('the survivor is the host', lobbyState.hostId === guessers[1].id);
    guessers[1].sock.disconnect();
    await sleep(300);
    const h = await health(PORT);
    check('empty room deleted and no timer left running', h.rooms === 0 && h.timers === 0);
  }

  // ---------------------------------------------------------------- H. room cap + room-creation throttle
  console.log('H. MAX_ROOMS and create_room throttle');
  small = await startServer(PORT_SMALL, { MAX_ROOMS: '2' });
  {
    const a = await connect(PORT_SMALL); const b = await connect(PORT_SMALL); const c = await connect(PORT_SMALL);
    check('room 1 created', (await a.req('create_room', { username: 'A' })).ok);
    check('room 2 created', (await b.req('create_room', { username: 'B' })).ok);
    check('room 3 refused: SERVER_BUSY', (await c.req('create_room', { username: 'C' })).error?.code === 'SERVER_BUSY');
    check('health shows 2 rooms', (await health(PORT_SMALL)).rooms === 2);
    for (const x of [a, b, c]) x.close();
    await sleep(300);
    check('rooms are freed when players leave', (await health(PORT_SMALL)).rooms === 0);
    const spam = await connect(PORT_SMALL);
    const tries = [];
    for (let i = 0; i < 18; i += 1) tries.push(await spam.req('create_room', { username: i === 0 ? 'S' : '' }));
    check('create_room spam is rate limited', tries.some((r) => r.error?.code === 'RATE_LIMITED'));
    spam.close();
  }

  // ---------------------------------------------------------------- I. plain HTTP
  console.log('I. HTTP surface');
  {
    const r404 = await fetch(`http://localhost:${PORT}/nope`);
    const body = await r404.json();
    check('unknown URL: JSON 404 without internals', r404.status === 404 && body.error.code === 'NOT_FOUND');
    const r = await fetch(`http://localhost:${PORT}/health`);
    check('x-powered-by header is not advertised', r.headers.get('x-powered-by') === null);
    const pre = await fetch(`http://localhost:${PORT}/health`, { headers: { Origin: 'http://evil.example' } });
    check('a foreign Origin gets no CORS allow header', pre.headers.get('access-control-allow-origin') === null);
    const okOrigin = await fetch(`http://localhost:${PORT}/health`, { headers: { Origin: 'http://localhost:5173' } });
    check('the configured CLIENT_URL origin is allowed', okOrigin.headers.get('access-control-allow-origin') === 'http://localhost:5173');
  }

  const log = server.getOutput();
  check('no unexpected server errors were logged (Error in ...)', !/Error in /.test(log) && !/Game timer error/.test(log));
  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n${err.message}`);
  console.error('--- server output ---\n' + server.getOutput().split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill();
  small?.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
