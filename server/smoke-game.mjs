// Phase 4 tests: game state machine, word secrecy, timers, hints, rotation, game over.
// Part A drives the engine in-process with a fake io (precise timer/idempotency checks).
// Part B spawns the real server and uses real socket.io-client connections (no mocks).
// Run with: npm run smoke:game
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

// Everything runs ~10x faster than real time. Must be set BEFORE game.js is imported.
process.env.GAME_TIME_SCALE = '0.1';
delete process.env.NODE_ENV;

const rooms = await import('./rooms.js');
const { createGameEngine, publicRoomState, TIMING } = await import('./game.js');
const { ALL_WORDS, pickWordOptions } = await import('./words.js');

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeoutCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const letters = (w) => [...w].filter((c) => /[a-z0-9]/i.test(c)).length;

// =====================================================================================
// PART A - engine, in process
// =====================================================================================
console.log('A. words.js');
const opts = pickWordOptions(5);
check('5 unique options', opts.length === 5 && new Set(opts).size === 5);
check('1 option works', pickWordOptions(1).length === 1);
check('used words are avoided', !pickWordOptions(5, new Set(ALL_WORDS.slice(0, ALL_WORDS.length - 5))).some((w) => ALL_WORDS.slice(0, ALL_WORDS.length - 5).includes(w)));
check('word bank is lowercase and big enough', ALL_WORDS.length >= 150 && ALL_WORDS.every((w) => w === w.toLowerCase()));

console.log('A. engine with a fake io');
function fakeIo() {
  const log = [];
  return { log, to: (target) => ({ emit: (ev, payload) => log.push({ target, ev, payload }) }) };
}
const count = (fake, ev) => fake.log.filter((l) => l.ev === ev).length;

function makeRoom(names, settings = {}) {
  const base = rooms.validateSettings({ rounds: 2, drawTime: 15, wordChoices: 3, hints: 2, ...settings }).settings;
  const room = rooms.createRoom('p0', names[0], base);
  names.slice(1).forEach((n, i) => rooms.addPlayer(room, `p${i + 1}`, n));
  return room;
}

{
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const room = makeRoom(['A', 'B', 'C']);
  const baseline = timeoutCount();

  check('start rejected with < 2 players', createGameEngine(fakeIo()).startGame(makeRoom(['Solo'])).error?.code === 'NOT_ENOUGH_PLAYERS');
  check('startGame ok', engine.startGame(room).ok === true);
  check('start twice rejected', engine.startGame(room).error?.code === 'WRONG_PHASE');
  check('phase WORD_SELECTION, drawer = first joined', room.phase === 'word_selection' && room.game.drawerId === 'p0');
  check('exactly one timer after start', timeoutCount() === baseline + 1);

  const roundStarts = fake.log.filter((l) => l.ev === 'round_start');
  check('round_start sent once per player', roundStarts.length === 3);
  check('only the drawer got word options', roundStarts.filter((l) => l.payload.wordOptions).map((l) => l.target).join() === 'p0');
  const options = roundStarts.find((l) => l.target === 'p0').payload.wordOptions;
  check('drawer got 3 unique options', options.length === 3 && new Set(options).size === 3);
  check('options never in a room-wide broadcast', !fake.log.filter((l) => l.target === room.code).some((l) => options.some((w) => JSON.stringify(l.payload).includes(JSON.stringify(w)))));

  check('non-drawer cannot choose', engine.chooseWord(room, 'p1', options[0]).error?.code === 'NOT_DRAWER');
  check('word outside the options rejected', engine.chooseWord(room, 'p0', 'definitely-not-offered').error?.code === 'INVALID_WORD');
  check('non-string word rejected', engine.chooseWord(room, 'p0', { word: 1 }).error?.code === 'INVALID_WORD');
  check('still WORD_SELECTION after bad attempts', room.phase === 'word_selection');
  const chosen = engine.chooseWord(room, 'p0', `  ${options[1].toUpperCase()} `);
  check('choice is trimmed/case-normalised and accepted', chosen.ok && chosen.word === options[1]);
  check('phase DRAWING', room.phase === 'drawing' && room.game.word === options[1]);
  check('still exactly one timer after choosing (old one cleared)', timeoutCount() === baseline + 1);
  check('second choice rejected', engine.chooseWord(room, 'p0', options[0]).error?.code === 'WRONG_PHASE');
  check('word_chosen sent to the drawer only', fake.log.filter((l) => l.ev === 'word_chosen').length === 1 && fake.log.find((l) => l.ev === 'word_chosen').target === 'p0');

  const pub = JSON.stringify(publicRoomState(room));
  check('public state has no secret word', !pub.includes(JSON.stringify(options[1])) && !options.some((w) => pub.includes(JSON.stringify(w))));
  check('public pattern is all blanks at first', publicRoomState(room).game.pattern.every((c) => c === '_' || c === ' ' || c === '-'));
  check('sync for a guesser has no word', engine.syncFor(room, 'p1').you.word === undefined && engine.syncFor(room, 'p1').you.role === 'guesser');
  check('sync for the drawer has the word', engine.syncFor(room, 'p0').you.word === options[1]);

  // Two end conditions at once -> still exactly one round_end.
  const r1 = engine.endTurn(room, 'time');
  const r2 = engine.endTurn(room, 'all_guessed');
  check('first endTurn wins, second is a no-op', r1.ok === true && r2.ok === false);
  check('exactly one round_end emitted', count(fake, 'round_end') === 1);
  check('phase ROUND_END, one timer (reveal pause)', room.phase === 'round_end' && timeoutCount() === baseline + 1);
  check('round_end reveals the word', fake.log.find((l) => l.ev === 'round_end').payload.word === options[1]);

  await sleep(TIMING.roundEndMs + 150);
  check('advanced exactly once to the next drawer (B)', room.phase === 'word_selection' && room.game.drawerId === 'p1' && room.game.turnId === 2);
  check('canvas history cleared for the new turn', room.drawing.strokes.length === 0 && count(fake, 'canvas_clear') >= 2);

  // B never picks: the server auto-picks after the selection timeout.
  await sleep(TIMING.wordSelectMs + 150);
  check('auto-pick when the drawer does not choose', room.phase === 'drawing' && typeof room.game.word === 'string');
  check('drawer told about the auto-picked word', fake.log.filter((l) => l.ev === 'word_chosen').some((l) => l.target === 'p1' && l.payload.auto === true));

  // Leaving player is skipped, aborting when < 2 remain.
  rooms.removePlayer(room, 'p2');
  engine.handlePlayerLeft(room, { id: 'p2' });
  check('non-drawer leaving does not end the turn', room.phase === 'drawing');
  const gone = rooms.removePlayer(room, 'p1');
  engine.handlePlayerLeft(room, gone.removed);
  check('fewer than 2 players -> back to lobby, game cleared', room.phase === 'lobby' && room.game === null);
  check('no timer left after abort', timeoutCount() === baseline);
}

{
  console.log('A. rotation, skipping a leaver, game over');
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const room = makeRoom(['A', 'B', 'C'], { rounds: 2 });
  const baseline = timeoutCount();
  engine.startGame(room);
  const order = [];
  const seen = new Set();
  let left = false;
  for (let i = 0; i < 400 && room.phase !== 'game_over'; i += 1) {
    if (room.phase === 'word_selection' && !seen.has(room.game.turnId)) {
      seen.add(room.game.turnId);
      order.push(room.game.drawerId);
      if (order.length === 2 && !left) {
        // B is drawing turn 2... remove C (still queued) so C is skipped this round
        const g = rooms.removePlayer(room, 'p2');
        engine.handlePlayerLeft(room, g.removed);
        left = true;
      }
      engine.chooseWord(room, room.game.drawerId, engine.syncFor(room, room.game.drawerId).you.wordOptions[0]);
      engine.endTurn(room, 'time');
    }
    await sleep(25);
  }
  check('order follows join order and skips the leaver: A, B, A, B', order.join() === 'p0,p1,p0,p1');
  check('game reaches GAME_OVER after the configured rounds', room.phase === 'game_over');
  check('game_over emitted exactly once', count(fake, 'game_over') === 1);
  const over = fake.log.find((l) => l.ev === 'game_over').payload;
  check('game_over has leaderboard with ranks (tie at 0 -> no single winner)', over.leaderboard.length === 2 && over.winner === null && over.winners.length === 2);
  check('no timers left at game over', timeoutCount() === baseline);
  check('cannot choose a word after game over', engine.chooseWord(room, 'p0', 'cat').error?.code === 'WRONG_PHASE');
}

{
  console.log('A. room removal cleans the timer');
  const room = makeRoom(['A', 'B']);
  const engine = createGameEngine(fakeIo());
  const baseline = timeoutCount();
  engine.startGame(room);
  check('timer running', timeoutCount() === baseline + 1);
  engine.disposeRoom(room);
  check('disposeRoom clears it', timeoutCount() === baseline);
  const room2 = makeRoom(['A', 'B']);
  engine.startGame(room2);
  engine.shutdown();
  check('shutdown clears all timers', timeoutCount() === baseline);
}

// =====================================================================================
// PART B - real server, real sockets
// =====================================================================================
const PORT = 4012;
const URL = `http://localhost:${PORT}`;
const server = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173', GAME_TIME_SCALE: '0.1' },
  stdio: 'ignore',
});
const request = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.events = []; // every event this client receives, in order
    s.onAny((ev, d) => s.events.push({ ev, d, t: Date.now() }));
    s.on('connect', () => resolve(s));
  });
async function waitFor(socket, ev, pred = () => true, ms = 6000, from = 0) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = socket.events.slice(from).find((e) => e.ev === ev && pred(e.d));
    if (hit) return hit.d;
    if (Date.now() > end) throw new Error(`timeout waiting for ${ev}`);
    await sleep(15);
  }
}
const evs = (s, ev, pred = () => true) => s.events.filter((e) => e.ev === ev && pred(e.d));
const stateOf = (s) => evs(s, 'game_state').at(-1)?.d;
async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${URL}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
const health = async () => (await fetch(`${URL}/health`)).json();
const stroke = (id) => ({ strokeId: id, x: 0.1, y: 0.2, color: '#ff0000', size: 5, mode: 'pen' });

try {
  await waitForServer();

  console.log('B. full game, 2 players, 2 rounds');
  const alice = await connect();
  const bob = await connect();
  const lone = await connect();
  const created = await request(alice, 'create_room', { username: 'Alice', settings: { rounds: 2, drawTime: 15, wordChoices: 3, hints: 2 } });
  const code = created.room.code;
  check('lobby room has no game block', created.room.game === null && created.room.phase === 'lobby');
  check('start with 1 player rejected', (await request(alice, 'start_game', {})).error?.code === 'NOT_ENOUGH_PLAYERS');
  await request(bob, 'join_room', { roomCode: code, username: 'Bob' });
  check('non-host cannot start', (await request(bob, 'start_game', {})).error?.code === 'NOT_HOST');
  check('word_chosen in lobby rejected', (await request(alice, 'word_chosen', { word: 'cat' })).error?.code === 'WRONG_PHASE');
  check('word_chosen outside a room rejected', (await request(lone, 'word_chosen', { word: 'cat' })).error?.code === 'NOT_IN_ROOM');
  check('sync_game outside a room rejected', (await request(lone, 'sync_game', {})).error?.code === 'NOT_IN_ROOM');

  // ---- turn 1: Alice draws ----
  const mark1 = { a: alice.events.length, b: bob.events.length };
  check('host starts the game', (await request(alice, 'start_game', {})).ok === true);
  const aStart = await waitFor(alice, 'round_start', (d) => d.turnId === 1, 2000, mark1.a);
  const bStart = await waitFor(bob, 'round_start', (d) => d.turnId === 1, 2000, mark1.b);
  check('turn 1 drawer is the first player (Alice)', aStart.drawerId === created.playerId && stateOf(bob).drawerId === created.playerId);
  check('Alice received 3 options privately', aStart.wordOptions.length === 3 && new Set(aStart.wordOptions).size === 3);
  check('Bob received NO options', bStart.wordOptions === null);
  check('state phase is word_selection with a deadline', stateOf(bob).phase === 'word_selection' && stateOf(bob).game.deadline > Date.now());
  check('guesser cannot choose', (await request(bob, 'word_chosen', { word: aStart.wordOptions[0] })).error?.code === 'NOT_DRAWER');
  check('invalid word rejected', (await request(alice, 'word_chosen', { word: 'zzz-not-offered' })).error?.code === 'INVALID_WORD');
  check('Bob (guesser) sync has no options', (await request(bob, 'sync_game', {})).you.wordOptions === undefined);
  const aSync = await request(alice, 'sync_game', {});
  check('Alice sync (reconnect recovery) restores her options', aSync.you.role === 'drawer' && aSync.you.wordOptions.join() === aStart.wordOptions.join());
  check('nobody can draw before a word is chosen', (await request(alice, 'draw_start', stroke('early-draw-01'))).error?.code === 'WRONG_PHASE');

  const word1 = [...aStart.wordOptions].sort((x, y) => letters(y) - letters(x))[0]; // longest -> most hints
  const chosenAt = Date.now();
  check('Alice chooses -> ok with the word', (await request(alice, 'word_chosen', { word: word1 })).word === word1);
  const drawing1 = await waitFor(bob, 'game_state', (d) => d.phase === 'drawing' && d.game.turnId === 1, 2000, mark1.b);
  check('timer started: deadline ~ drawTime (scaled 1.5s) ahead', Math.abs(drawing1.game.deadline - drawing1.game.serverNow - 1500) < 120);
  check('guesser pattern has the right length and only blanks', drawing1.game.pattern.length === word1.length && drawing1.game.pattern.every((c, i) => (/[a-z0-9]/i.test(word1[i]) ? c === '_' : c === word1[i])));
  check('guesser state has no word field', !('word' in drawing1.game) && drawing1.game.wordLength === letters(word1));
  check('Alice got word_chosen privately; Bob did not', (await waitFor(alice, 'word_chosen', (d) => d.turnId === 1, 1000, mark1.a)).word === word1 && evs(bob, 'word_chosen').length === 0);
  check('server also reports the word to Alice via sync', (await request(alice, 'sync_game', {})).you.word === word1);
  check('Bob sync during DRAWING has no word', (await request(bob, 'sync_game', {})).you.word === undefined);

  console.log('B. drawing permissions in DRAWING phase');
  check('Alice can draw', (await request(alice, 'draw_start', stroke('alice-stroke-1'))).ok === true);
  await request(alice, 'draw_end', { strokeId: 'alice-stroke-1' });
  check('Bob cannot draw', (await request(bob, 'draw_start', stroke('bob-stroke-001'))).error?.code === 'NOT_DRAWER');
  check('Bob cannot clear', (await request(bob, 'canvas_clear', {})).error?.code === 'NOT_DRAWER');
  check('a spoofed drawerId is ignored', (await request(bob, 'draw_start', { ...stroke('bob-spoof-001'), drawerId: alice.id })).error?.code === 'NOT_DRAWER');
  check('canvas has Alice\'s stroke before the turn ends', (await request(bob, 'draw_sync', {})).strokes.length === 1);

  console.log('B. hints');
  const expectedHints = Math.min(2, Math.floor(letters(word1) / 2));
  const lastHintState = await waitFor(bob, 'game_state', (d) => d.phase === 'drawing' && d.game.turnId === 1 && d.game.hintsShown === expectedHints, 2500, mark1.b).catch(() => null);
  check(`hintsShown reaches ${expectedHints} (min(setting 2, half the letters))`, expectedHints === 0 || lastHintState !== null);
  if (expectedHints > 0) {
    const shown = lastHintState.game.pattern.filter((c, i) => c === word1[i] && /[a-z0-9]/i.test(c)).length;
    check('revealed hint letters are correct and at least one stays hidden', shown === expectedHints && lastHintState.game.pattern.includes('_'));
    check('hint came by server push at a later time than the start', evs(bob, 'game_state', (d) => d.phase === 'drawing' && d.game.turnId === 1 && d.game.hintsShown === 1).length >= 1);
  }

  console.log('B. timer expiry -> exactly one round_end');
  const end1 = await waitFor(bob, 'round_end', (d) => d.turnId === 1, 4000, mark1.b);
  check('round_end arrives about drawTime after the word was chosen', Math.abs(evs(bob, 'round_end', (d) => d.turnId === 1)[0] && Date.now() - chosenAt - 1500) < 800);
  await sleep(300);
  check('exactly one round_end per client for turn 1', evs(alice, 'round_end', (d) => d.turnId === 1).length === 1 && evs(bob, 'round_end', (d) => d.turnId === 1).length === 1);
  check('reveal: word, reason and next drawer', end1.word === word1 && end1.reason === 'time' && end1.nextDrawerId === bob.id && end1.scores.length === 2);
  const bobEvents1 = bob.events.slice(mark1.b, bob.events.findIndex((e) => e.ev === 'round_end'));
  check('SECRET: Bob never saw the word or any option before round_end', !bobEvents1.some((e) => aStart.wordOptions.some((w) => JSON.stringify(e.d ?? null).includes(JSON.stringify(w)))));
  check('after expiry nobody can draw', (await request(alice, 'draw_start', stroke('late-stroke-01'))).error?.code === 'WRONG_PHASE');
  check('state during reveal exposes lastRound word', stateOf(bob).phase === 'round_end' && stateOf(bob).game.lastRound.word === word1);

  // ---- turn 2: Bob draws, never picks -> auto pick ----
  console.log('B. rotation + auto-pick');
  const aMark2 = alice.events.length;
  const b2 = await waitFor(bob, 'round_start', (d) => d.turnId === 2, 2500);
  check('turn 2 drawer is Bob and gets options', b2.drawerId === bob.id && b2.wordOptions.length === 3);
  check('Alice got no options for turn 2', evs(alice, 'round_start', (d) => d.turnId === 2)[0].d.wordOptions === null);
  check('canvas_clear broadcast for the new turn', alice.events.slice(aMark2 - 5).some((e) => e.ev === 'canvas_clear') || evs(alice, 'canvas_clear').length >= 2);
  check('canvas history cleared between turns', (await request(alice, 'draw_sync', {})).strokes.length === 0);
  check('during word selection nobody can draw (WRONG_PHASE)', (await request(alice, 'draw_start', stroke('alice-turn2-01'))).error?.code === 'WRONG_PHASE' && (await request(bob, 'draw_start', stroke('bob-turn2-0001'))).error?.code === 'WRONG_PHASE');
  const auto = await waitFor(bob, 'word_chosen', (d) => d.turnId === 2, 3000);
  check('Alice cannot draw as a guesser once drawing starts (NOT_DRAWER)', (await request(alice, 'draw_start', stroke('alice-turn2-02'))).error?.code === 'NOT_DRAWER');
  check('Bob (new drawer) can draw', (await request(bob, 'draw_start', stroke('bob-turn2-0002'))).ok === true);
  check('auto-pick happened after the selection timeout, from the offered options', auto.auto === true && b2.wordOptions.includes(auto.word));
  const end2 = await waitFor(alice, 'round_end', (d) => d.turnId === 2, 4000);
  check('turn 2 ended once with the auto-picked word', end2.word === auto.word && evs(alice, 'round_end', (d) => d.turnId === 2).length === 1);
  const aliceTurn2 = alice.events.slice(aMark2, alice.events.findIndex((e) => e.ev === 'round_end' && e.d.turnId === 2));
  check('SECRET: Alice never saw Bob\'s options or word before round_end', !aliceTurn2.some((e) => [...b2.wordOptions].some((w) => JSON.stringify(e.d ?? null).includes(JSON.stringify(w)))));

  // ---- turn 3 (round 2): Alice again; turn 4: Bob, then game over ----
  const a3 = await waitFor(alice, 'round_start', (d) => d.turnId === 3, 2500);
  check('turn 3 is round 2 and Alice draws again', a3.round === 2 && a3.drawerId === alice.id && a3.wordOptions.length === 3);
  await request(alice, 'word_chosen', { word: a3.wordOptions[2] });
  await waitFor(alice, 'round_end', (d) => d.turnId === 3, 4000);
  const b4 = await waitFor(bob, 'round_start', (d) => d.turnId === 4, 2500);
  check('turn 4 is Bob again (rotation repeats in join order)', b4.drawerId === bob.id && b4.round === 2);
  await request(bob, 'word_chosen', { word: b4.wordOptions[0] });
  const end4 = await waitFor(bob, 'round_end', (d) => d.turnId === 4, 4000);
  check('last turn: nextDrawerId null / isLastTurn', end4.nextDrawerId === null && end4.isLastTurn === true);
  const over = await waitFor(alice, 'game_over', () => true, 3000);
  await sleep(300);
  check('game_over emitted exactly once per client', evs(alice, 'game_over').length === 1 && evs(bob, 'game_over').length === 1);
  check('final leaderboard has both players (no scoring yet -> tie)', over.leaderboard.length === 2 && over.winners.length === 2 && over.winner === null && over.leaderboard.every((e) => e.rank === 1));
  const final = stateOf(alice);
  check('final state: game_over, no drawer, results public', final.phase === 'game_over' && final.drawerId === null && final.game.results.leaderboard.length === 2);
  check('4 turns happened: ids 1..4', [1, 2, 3, 4].every((n) => evs(alice, 'round_end', (d) => d.turnId === n).length === 1) && evs(alice, 'round_end').length === 4);
  check('no drawing after game over', (await request(alice, 'draw_start', stroke('post-game-001'))).error?.code === 'WRONG_PHASE');
  check('no word choice after game over', (await request(alice, 'word_chosen', { word: 'cat' })).error?.code === 'WRONG_PHASE');
  check('no timers left running for a finished game', (await health()).timers === 0);

  console.log('B. departures (3 players)');
  const x = await connect(); const y = await connect(); const z = await connect();
  const roomX = await request(x, 'create_room', { username: 'X', settings: { rounds: 2, drawTime: 60, hints: 0 } });
  await request(y, 'join_room', { roomCode: roomX.room.code, username: 'Y' });
  await request(z, 'join_room', { roomCode: roomX.room.code, username: 'Z' });
  await request(x, 'start_game', {});
  const xStart = await waitFor(x, 'round_start', (d) => d.turnId === 1, 2000);
  await request(x, 'word_chosen', { word: xStart.wordOptions[0] });
  await waitFor(y, 'game_state', (d) => d.phase === 'drawing', 2000);
  check('hints disabled (0): no hints planned', stateOf(y).game.hintsTotal === 0);
  y.disconnect(); // a guesser leaves mid-turn
  await sleep(150);
  check('a guesser leaving does not end the turn', stateOf(z).phase === 'drawing' && stateOf(z).players.length === 2);
  x.disconnect(); // the DRAWER leaves while only Z would remain -> not enough players
  await sleep(200);
  check('drawer left and < 2 players remain -> room returns to lobby', stateOf(z).phase === 'lobby' && stateOf(z).game === null);
  check('lobby has no stale drawer', stateOf(z).drawerId === null);
  z.disconnect();
  await sleep(150);

  const p = await connect(); const q = await connect(); const r = await connect();
  const roomP = await request(p, 'create_room', { username: 'P', settings: { rounds: 2, drawTime: 60, hints: 0 } });
  await request(q, 'join_room', { roomCode: roomP.room.code, username: 'Q' });
  await request(r, 'join_room', { roomCode: roomP.room.code, username: 'R' });
  await request(p, 'start_game', {});
  await waitFor(p, 'round_start', (d) => d.turnId === 1, 2000);
  p.disconnect(); // drawer leaves during WORD_SELECTION; Q and R remain
  const endP = await waitFor(q, 'round_end', (d) => d.turnId === 1, 2000);
  check('drawer leaving ends the turn with reason drawer_left (no word was chosen)', endP.reason === 'drawer_left' && endP.word === null);
  await sleep(100);
  check('only one round_end for that turn', evs(q, 'round_end', (d) => d.turnId === 1).length === 1);
  const q2 = await waitFor(q, 'round_start', (d) => d.turnId === 2, 2500);
  check('next drawer is Q (leaver skipped, join order kept)', q2.drawerId === q.id && q2.wordOptions.length === 3);
  check('no auto-pick fired for the departed drawer\'s turn', evs(q, 'word_chosen', (d) => d.turnId === 1).length === 0 && evs(r, 'word_chosen').length === 0);
  q.disconnect(); r.disconnect(); alice.disconnect(); bob.disconnect(); lone.disconnect();
  await sleep(250);
  const h = await health();
  check('all rooms removed and no timers leaked', h.rooms === 0 && h.timers === 0);

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
  process.exit();
}
