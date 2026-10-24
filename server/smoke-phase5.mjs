// Phase 5 tests: guessing, chat, scoring, early round end, leaderboard, final winner.
// Part A drives the engine in-process with a fake io (exact payload/audience/race checks).
// Part B spawns the real server and plays whole games with real socket.io-client connections.
// Run with: npm run smoke:phase5
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

// Everything runs ~10x faster than real time. Must be set BEFORE game.js is imported.
process.env.GAME_TIME_SCALE = '0.1';
delete process.env.NODE_ENV;

const rooms = await import('./rooms.js');
const { createGameEngine, publicRoomState, TIMING } = await import('./game.js');
const scoring = await import('./scoring.js');

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================================
// PART A - scoring function + engine, in process
// =====================================================================================
console.log('A. scoring.js');
check('place 1..4 = 100, 80, 60, 40', [0, 1, 2, 3].map(scoring.pointsForGuess).join() === '100,80,60,40');
check('5th and later = 20 (the minimum)', [4, 5, 6, 19].every((i) => scoring.pointsForGuess(i) === 20));
check('invalid place = 0 points', [-1, 1.5, NaN, undefined, '0'].every((v) => scoring.pointsForGuess(v) === 0));
check('drawer bonus: 0 with no correct guess, 50 once there is one', scoring.drawerBonus(0) === 0 && scoring.drawerBonus(1) === 50 && scoring.drawerBonus(7) === 50);

console.log('A. engine with a fake io');
function fakeIo() {
  const log = [];
  return { log, to: (target) => ({ emit: (ev, payload) => log.push({ target, ev, payload }) }) };
}
const only = (fake, ev, pred = () => true) => fake.log.filter((l) => l.ev === ev && pred(l));

function makeRoom(names, settings = {}) {
  const base = rooms.validateSettings({ rounds: 2, drawTime: 15, wordChoices: 3, hints: 0, ...settings }).settings;
  const room = rooms.createRoom('p0', names[0], base);
  names.slice(1).forEach((n, i) => rooms.addPlayer(room, `p${i + 1}`, n));
  return room;
}
const scoresOf = (room) => Object.fromEntries([...room.players.values()].map((p) => [p.id, p.score]));
const leave = (engine, room, id) => engine.handlePlayerLeft(room, rooms.removePlayer(room, id).removed);

// ---------- A1: one turn, step by step (4 players: p0 draws) ----------
{
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const room = makeRoom(['Dee', 'Ann', 'Bob', 'Cy']);
  engine.startGame(room);
  const g = room.game;

  check('guess during word_selection is rejected', engine.submitGuess(room, 'p1', 'cat').error?.code === 'WRONG_PHASE');
  const word = engine.chooseWord(room, 'p0', g.wordOptions[0]).word;
  check('phase is drawing', room.phase === 'drawing');

  check('drawer guessing their own word: NOT_ELIGIBLE, no points', engine.submitGuess(room, 'p0', word).error?.code === 'NOT_ELIGIBLE' && scoresOf(room).p0 === 0);
  check('player outside the room is rejected', engine.submitGuess(room, 'ghost', word).error?.code === 'NOT_IN_ROOM');
  check('empty / whitespace-only guess rejected', engine.submitGuess(room, 'p1', '   ').error?.code === 'INVALID_MESSAGE');
  check('non-string guess rejected', engine.submitGuess(room, 'p1', { a: 1 }).error?.code === 'INVALID_MESSAGE');
  check('over-long guess rejected (not truncated)', engine.submitGuess(room, 'p1', 'x'.repeat(101)).error?.code === 'INVALID_MESSAGE');

  // wrong guess
  const wrong = engine.submitGuess(room, 'p1', 'definitely wrong');
  check('wrong guess: ok but correct:false, no points', wrong.ok && wrong.correct === false && wrong.points === undefined && scoresOf(room).p1 === 0);
  const wrongResults = only(fake, 'guess_result');
  check('wrong guess_result goes ONLY to the sender and has no word', wrongResults.length === 1 && wrongResults[0].target === 'p1' && wrongResults[0].payload.correct === false && !JSON.stringify(wrongResults[0].payload).includes(word));
  const wrongChat = only(fake, 'chat_message', (l) => l.payload.kind === 'guess');
  check('wrong guess text is shown to the whole room', wrongChat.length === 1 && wrongChat[0].target === room.code && wrongChat[0].payload.text === 'definitely wrong');

  // near misses are NOT correct (exact matching only)
  check('a prefix of the word is wrong', engine.submitGuess(room, 'p1', word.slice(0, -1)).correct === false);
  check('word + extra letter is wrong', engine.submitGuess(room, 'p1', `${word}s`).correct === false);
  check('nobody scored yet', Object.values(scoresOf(room)).every((s) => s === 0));

  // a guess that CONTAINS the answer must not be shown to players who are still guessing
  const before = fake.log.length;
  const leak = engine.submitGuess(room, 'p2', `it's a ${word}`);
  check('guess containing the word is not a correct guess', leak.ok && leak.correct === false && scoresOf(room).p2 === 0);
  const leakChats = fake.log.slice(before).filter((l) => l.ev === 'chat_message');
  check('...and is NOT broadcast to the room', leakChats.every((l) => l.target !== room.code));
  check('...only the sender and the drawer get it (Cy, still guessing, does not)', leakChats.map((l) => l.target).sort().join() === 'p0,p2');

  // correct guess: different case + surrounding/extra whitespace
  const messy = `   ${word.toUpperCase().replace(/ /g, '   ')}\t `;
  const ok1 = engine.submitGuess(room, 'p1', messy);
  check('correct guess with other capitalization and extra whitespace is accepted', ok1.ok && ok1.correct === true);
  check('first correct guess = 100 points, place 1', ok1.points === 100 && ok1.place === 1 && scoresOf(room).p1 === 100);
  check('drawer got the 50 bonus at the first correct guess', scoresOf(room).p0 === 50);
  const correctResult = only(fake, 'guess_result', (l) => l.payload.correct)[0];
  check('correct guess_result goes to the whole room', correctResult.target === room.code && correctResult.payload.playerId === 'p1' && correctResult.payload.points === 100 && correctResult.payload.playerName === 'Ann');
  const correctChat = only(fake, 'chat_message', (l) => l.payload.kind === 'correct')[0];
  check('notification says who guessed, never what', correctChat.target === room.code && correctChat.payload.text === 'Ann guessed the word!' && !correctChat.payload.text.includes(word));
  check('turn still going (2 guessers left)', room.phase === 'drawing');

  const pub = publicRoomState(room);
  check('public state lists who guessed', pub.game.guessedIds.join() === 'p1' && pub.game.guessersTotal === 3);
  check('public leaderboard is server-ranked: Ann #1 (100), Dee #2 (50)', pub.game.leaderboard[0].id === 'p1' && pub.game.leaderboard[0].rank === 1 && pub.game.leaderboard[1].id === 'p0' && pub.game.leaderboard[1].score === 50);
  check('leaderboard carries this-turn delta + guessed flag', pub.game.leaderboard[0].delta === 100 && pub.game.leaderboard[0].guessed === true);
  check('public state still has no secret word', !JSON.stringify(pub).includes(`"${word}"`));

  // no double scoring
  check('same player guessing again: ALREADY_GUESSED', engine.submitGuess(room, 'p1', word).error?.code === 'ALREADY_GUESSED');
  check('...and the score did not change', scoresOf(room).p1 === 100 && scoresOf(room).p0 === 50);

  // chat while drawing
  check('player still guessing cannot use chat during drawing', engine.sendChat(room, 'p2', 'the word is...').error?.code === 'CHAT_RESTRICTED');
  const chatBefore = fake.log.length;
  check('a player who guessed can chat', engine.sendChat(room, 'p1', `it was ${word}, easy`).ok === true);
  const secretChats = fake.log.slice(chatBefore).filter((l) => l.ev === 'chat_message');
  check('...but only the drawer and guessed players receive it', secretChats.map((l) => l.target).sort().join() === 'p0,p1' && secretChats.every((l) => l.payload.scope === 'guessed'));
  check('the drawer can chat during drawing (same restricted audience)', engine.sendChat(room, 'p0', 'nice').ok === true);

  // remaining guessers
  const ok2 = engine.submitGuess(room, 'p2', word);
  check('second correct guess = 80', ok2.points === 80 && ok2.place === 2 && scoresOf(room).p2 === 80);
  check('drawer bonus is NOT paid again', scoresOf(room).p0 === 50);
  check('turn not over while Cy has not guessed', room.phase === 'drawing' && only(fake, 'round_end').length === 0);
  const ok3 = engine.submitGuess(room, 'p3', word);
  check('third correct guess = 60', ok3.points === 60 && scoresOf(room).p3 === 60);

  // everyone guessed -> early end
  check('all guessers correct -> turn ends early (round_end phase)', room.phase === 'round_end');
  const ends = only(fake, 'round_end');
  check('exactly one round_end, reason all_guessed, word revealed', ends.length === 1 && ends[0].payload.reason === 'all_guessed' && ends[0].payload.word === word);
  check('round_end scores + deltas', ends[0].payload.scores.find((s) => s.id === 'p1').delta === 100 && ends[0].payload.scores.find((s) => s.id === 'p0').delta === 50 && ends[0].payload.scores.find((s) => s.id === 'p3').score === 60);
  check('system chat reveals the word after the turn', only(fake, 'chat_message', (l) => l.payload.kind === 'system').some((l) => l.payload.text.includes(word)));
  check('guess after the turn ended is rejected (round-ended guard)', engine.submitGuess(room, 'p2', word).error?.code === 'WRONG_PHASE');
  check('a late timer-style endTurn does nothing', engine.endTurn(room, 'time').ok === false && only(fake, 'round_end').length === 1);
  check('chat is open to everyone during round_end', engine.sendChat(room, 'p2', 'gg').ok === true && only(fake, 'chat_message', (l) => l.payload.text === 'gg')[0].target === room.code);

  // next turn: scores persist, per-turn data resets
  await sleep(TIMING.roundEndMs + 120);
  check('next turn started (word_selection, drawer p1)', room.phase === 'word_selection' && room.game.drawerId === 'p1');
  check('scores carried into the next turn', JSON.stringify(scoresOf(room)) === JSON.stringify({ p0: 50, p1: 100, p2: 80, p3: 60 }));
  const pub2 = publicRoomState(room);
  check('guessed list and deltas reset for the new turn', pub2.game.guessedIds.length === 0 && pub2.game.leaderboard.every((e) => e.delta === 0 && !e.guessed));
  check('guess during the new word_selection is rejected', engine.submitGuess(room, 'p2', word).error?.code === 'WRONG_PHASE');
  check('the drawer cannot chat while picking a word (could leak options)', engine.sendChat(room, 'p1', 'psst').error?.code === 'CHAT_RESTRICTED');
  check('others can chat while a word is being picked', engine.sendChat(room, 'p2', 'hi').ok === true);
  engine.disposeRoom(room);
}

// ---------- A2: a whole game; totals checked against independent arithmetic ----------
{
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const room = makeRoom(['X', 'Y', 'Z'], { rounds: 2 });
  engine.startGame(room);
  const expected = { p0: 0, p1: 0, p2: 0 };
  const table = [100, 80]; // independent copy of the scoring table for 2 guessers
  let turn = 0;
  const giveUp = Date.now() + 15000;
  while (room.phase !== 'game_over') {
    if (Date.now() > giveUp) throw new Error('FAILED: game did not finish in time');
    if (room.phase === 'word_selection') {
      const drawer = room.game.drawerId;
      const word = engine.chooseWord(room, drawer, room.game.wordOptions[0]).word;
      const guessers = ['p0', 'p1', 'p2'].filter((id) => id !== drawer);
      if (turn % 2 === 1) guessers.reverse(); // vary who is fastest
      guessers.forEach((id, i) => {
        engine.submitGuess(room, id, word);
        expected[id] += table[i];
      });
      expected[drawer] += 50;
      turn += 1;
    }
    await sleep(20);
  }
  check('6 turns were played (2 rounds x 3 players)', turn === 6);
  check('server scores equal the independently computed totals', JSON.stringify(scoresOf(room)) === JSON.stringify(expected));
  const over = only(fake, 'game_over');
  check('game_over emitted exactly once', over.length === 1);
  const lb = over[0].payload.leaderboard;
  check('final leaderboard sorted by score and matches totals', lb.every((e, i) => e.score === expected[e.id] && (i === 0 || lb[i - 1].score >= e.score)));
  const top = Math.max(...Object.values(expected));
  const expectedWinners = Object.keys(expected).filter((id) => expected[id] === top).sort().join();
  check('winner(s) are exactly the highest scorers', over[0].payload.winners.map((w) => w.id).sort().join() === expectedWinners && (over[0].payload.winner === null) === (expectedWinners.includes(',')));
  check('a round_end happened for each of the 6 turns, once each', only(fake, 'round_end').length === 6 && new Set(only(fake, 'round_end').map((l) => l.payload.turnId)).size === 6);
  check('guess after game over rejected', engine.submitGuess(room, 'p1', 'cat').error?.code === 'WRONG_PHASE');
  engine.disposeRoom(room);
}

// ---------- A3: timer expiry, with and without correct guesses ----------
{
  const fakeA = fakeIo();
  const fakeB = fakeIo();
  const engA = createGameEngine(fakeA);
  const engB = createGameEngine(fakeB);
  const partial = makeRoom(['P', 'Q', 'R']);
  const nobody = makeRoom(['S', 'T', 'U']);
  engA.startGame(partial);
  engB.startGame(nobody);
  const w1 = engA.chooseWord(partial, 'p0', partial.game.wordOptions[0]).word;
  engB.chooseWord(nobody, 'p0', nobody.game.wordOptions[0]);
  engA.submitGuess(partial, 'p1', w1); // one of two guessers
  check('partial: one guesser scored, turn continues', scoresOf(partial).p1 === 100 && partial.phase === 'drawing');
  await sleep(1500 + 150); // drawTime 15s x 0.1
  const endA = only(fakeA, 'round_end')[0];
  const endB = only(fakeB, 'round_end')[0];
  check('partial: timer ended the turn (reason time)', endA?.payload.reason === 'time' && only(fakeA, 'round_end').length === 1);
  check('partial: points kept, drawer bonus kept, non-guesser 0', JSON.stringify(scoresOf(partial)) === JSON.stringify({ p0: 50, p1: 100, p2: 0 }));
  check('nobody guessed: ended by time, nobody scored, no drawer bonus', endB?.payload.reason === 'time' && Object.values(scoresOf(nobody)).every((s) => s === 0));
  engA.disposeRoom(partial);
  engB.disposeRoom(nobody);
}

// ---------- A4: races between timer expiry, guesses and round advancement ----------
{
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const r1 = makeRoom(['A', 'B', 'C']); // timer wins the race
  const r2 = makeRoom(['D', 'E', 'F']); // last correct guess wins the race
  engine.startGame(r1);
  engine.startGame(r2);
  const w1 = engine.chooseWord(r1, 'p0', r1.game.wordOptions[0]).word;
  const w2 = engine.chooseWord(r2, 'p0', r2.game.wordOptions[0]).word;

  engine.submitGuess(r1, 'p1', w1);
  engine.endTurn(r1, 'time'); //                              the "timer" fires first...
  check('race 1: guess after expiry is rejected, not scored', engine.submitGuess(r1, 'p2', w1).error?.code === 'WRONG_PHASE' && scoresOf(r1).p2 === 0);

  engine.submitGuess(r2, 'p1', w2);
  engine.submitGuess(r2, 'p2', w2); //                        ...here the last guess ends it first
  check('race 2: turn ended by all_guessed', fake.log.find((l) => l.ev === 'round_end' && l.payload.reason === 'all_guessed'));
  check('race 2: the expiry that comes afterwards is a no-op', engine.endTurn(r2, 'time').ok === false);
  check('race 2: duplicate guesses from the same players change nothing', engine.submitGuess(r2, 'p1', w2).ok === false && engine.submitGuess(r2, 'p2', w2).ok === false && scoresOf(r2).p1 === 100 && scoresOf(r2).p2 === 80);

  await sleep(1500 + 200); // sleep past the ORIGINAL drawing deadline of both turns
  const r2Ends = fake.log.filter((l) => l.ev === 'round_end' && l.target === r2.code && l.payload.drawerName === 'D' && l.payload.turnId === 1);
  check('no second round_end appears when the cancelled drawing timer would have fired', r2Ends.length === 1 && r2Ends[0].payload.reason === 'all_guessed');
  engine.disposeRoom(r1);
  engine.disposeRoom(r2);
}

// ---------- A5: players leaving during the guessing phase ----------
{
  // (a) the only remaining guessers have all guessed -> the turn ends
  const fake = fakeIo();
  const engine = createGameEngine(fake);
  const room = makeRoom(['A', 'B', 'C', 'D']);
  engine.startGame(room);
  const word = engine.chooseWord(room, 'p0', room.game.wordOptions[0]).word;
  engine.submitGuess(room, 'p1', word);
  leave(engine, room, 'p2');
  check('leave (a): a pending guesser leaving does not end the turn while another is pending', room.phase === 'drawing');
  leave(engine, room, 'p3');
  check('leave (a): last pending guesser leaves -> everyone left has guessed -> turn ends (all_guessed)', room.phase === 'round_end' && fake.log.filter((l) => l.ev === 'round_end')[0].payload.reason === 'all_guessed');
  check('leave (a): scores kept for the players still here', scoresOf(room).p1 === 100 && scoresOf(room).p0 === 50);
  engine.disposeRoom(room);

  // (b) a player who already guessed leaves while another is still guessing -> keeps going
  const room2 = makeRoom(['A', 'B', 'C']);
  engine.startGame(room2);
  const word2 = engine.chooseWord(room2, 'p0', room2.game.wordOptions[0]).word;
  engine.submitGuess(room2, 'p1', word2);
  leave(engine, room2, 'p1');
  check('leave (b): a guessed player leaving with a guesser still pending does not end the turn', room2.phase === 'drawing' && room2.players.size === 2);
  engine.disposeRoom(room2);

  // (c) no eligible guessers left -> never "all guessed"; the game falls back to the lobby
  const fake3 = fakeIo();
  const engine3 = createGameEngine(fake3);
  const room3 = makeRoom(['A', 'B', 'C']);
  engine3.startGame(room3);
  engine3.chooseWord(room3, 'p0', room3.game.wordOptions[0]);
  leave(engine3, room3, 'p1');
  leave(engine3, room3, 'p2');
  check('leave (c): no guessers left -> back to lobby, no all_guessed round_end', room3.phase === 'lobby' && fake3.log.filter((l) => l.ev === 'round_end').length === 0);
  engine3.disposeRoom(room3);
}

// =====================================================================================
// PART B - real server, real sockets, full games
// =====================================================================================
const PORT = 4015;
const URL = `http://localhost:${PORT}`;
const server = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173', GAME_TIME_SCALE: '0.1' },
  stdio: 'ignore',
});
const request = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.events = [];
    s.onAny((ev, d) => s.events.push({ ev, d, t: Date.now() }));
    s.on('connect', () => resolve(s));
  });
async function waitFor(socket, ev, pred = () => true, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = socket.events.find((e) => e.ev === ev && pred(e.d));
    if (hit) return hit.d;
    if (Date.now() > end) throw new Error(`timeout waiting for ${ev}`);
    await sleep(15);
  }
}
const evs = (s, ev, pred = () => true) => s.events.filter((e) => e.ev === ev && pred(e.d));
const stateOf = (s) => evs(s, 'game_state').at(-1)?.d;
const scoreMap = (s) => Object.fromEntries(stateOf(s).players.map((p) => [p.username, p.score]));
async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${URL}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
const health = async () => (await fetch(`${URL}/health`)).json();

try {
  await waitForServer();
  console.log('B. full game over real sockets (3 players, 2 rounds)');
  const alice = await connect();
  const bob = await connect();
  const cara = await connect();
  const created = await request(alice, 'create_room', { username: 'Alice', settings: { rounds: 2, drawTime: 30, wordChoices: 3, hints: 2 } });
  const code = created.room.code;
  await request(bob, 'join_room', { roomCode: code, username: 'Bob' });
  await request(cara, 'join_room', { roomCode: code, username: 'Cara' });
  const byName = { Alice: alice, Bob: bob, Cara: cara };
  const expected = { Alice: 0, Bob: 0, Cara: 0 };

  check('guess in the lobby rejected', (await request(bob, 'guess', { text: 'cat' })).error?.code === 'WRONG_PHASE');
  check('chat in the lobby rejected', (await request(bob, 'chat', { text: 'hi' })).error?.code === 'WRONG_PHASE');
  await request(alice, 'start_game', {});

  // ---- turn 1: Alice draws; Bob and Cara guess ----
  const start1 = await waitFor(alice, 'round_start', (d) => d.turnId === 1);
  const word = (await request(alice, 'word_chosen', { word: start1.wordOptions[0] })).word;
  await waitFor(bob, 'game_state', (d) => d.phase === 'drawing' && d.game.turnId === 1);
  await waitFor(cara, 'game_state', (d) => d.phase === 'drawing' && d.game.turnId === 1);

  const wrong = await request(bob, 'guess', { text: 'nothing like it' });
  check('wrong guess: ack correct:false and the answer is not in the ack', wrong.ok && wrong.correct === false && !JSON.stringify(wrong).includes(word));
  await waitFor(bob, 'guess_result', (d) => d.correct === false);
  await sleep(80);
  check('wrong guess_result reached only Bob', evs(alice, 'guess_result').length === 0 && evs(cara, 'guess_result').length === 0);
  check('everyone sees the wrong guess in chat with the sender name', [alice, bob, cara].every((s) => evs(s, 'chat_message', (d) => d.kind === 'guess' && d.text === 'nothing like it' && d.playerName === 'Bob').length === 1));

  check('Cara (still guessing) cannot use chat while drawing', (await request(cara, 'chat', { text: 'hello' })).error?.code === 'CHAT_RESTRICTED');
  check('Alice (drawer) cannot guess', (await request(alice, 'guess', { text: word })).error?.code === 'NOT_ELIGIBLE');
  check('Alice sees no score change for a self guess', scoreMap(alice).Alice === 0);

  // answer-containing text from Cara must not reach Bob (still guessing)
  const leakText = `i think it is ${word}`;
  check('answer-containing guess is just a wrong guess', (await request(cara, 'guess', { text: leakText })).correct === false);
  await sleep(100);
  check('...Bob (guessing) never receives it', evs(bob, 'chat_message', (d) => d.text === leakText).length === 0);
  check('...Cara (sender) and Alice (drawer) do', evs(cara, 'chat_message', (d) => d.text === leakText).length === 1 && evs(alice, 'chat_message', (d) => d.text === leakText).length === 1);

  const ok1 = await request(bob, 'guess', { text: `   ${word.toUpperCase()}   ` });
  check('Bob: upper-case + padded correct guess accepted for 100', ok1.ok && ok1.correct === true && ok1.points === 100);
  expected.Bob += 100; expected.Alice += 50;
  await Promise.all([alice, bob, cara].map((s) => waitFor(s, 'guess_result', (d) => d.correct === true && d.playerName === 'Bob')));
  await Promise.all([alice, bob, cara].map((s) => waitFor(s, 'chat_message', (d) => d.kind === 'correct' && d.playerName === 'Bob')));
  check('all three clients got the correct-guess notification', [alice, bob, cara].every((s) => evs(s, 'chat_message', (d) => d.kind === 'correct' && d.text === 'Bob guessed the word!').length === 1));
  await sleep(100);
  check('scores are identical on every client right after the guess', JSON.stringify(scoreMap(alice)) === JSON.stringify(scoreMap(bob)) && JSON.stringify(scoreMap(bob)) === JSON.stringify(scoreMap(cara)) && scoreMap(cara).Bob === 100 && scoreMap(cara).Alice === 50);
  check('live leaderboard in game_state: Bob #1, Alice #2, Cara #3', stateOf(cara).game.leaderboard.map((e) => `${e.rank}:${e.username}`).join() === '1:Bob,2:Alice,3:Cara');
  check('Bob guessing again: ALREADY_GUESSED, still 100', (await request(bob, 'guess', { text: word })).error?.code === 'ALREADY_GUESSED');
  check('Bob (guessed) can chat and Cara (still guessing) does not see it', (await request(bob, 'chat', { text: 'that was easy' })).ok === true && (await sleep(100), evs(cara, 'chat_message', (d) => d.text === 'that was easy').length === 0) && evs(alice, 'chat_message', (d) => d.text === 'that was easy').length === 1);

  const ok2 = await request(cara, 'guess', { text: word });
  check('Cara: second correct guess = 80', ok2.correct === true && ok2.points === 80);
  expected.Cara += 80;
  const end1 = await Promise.all([alice, bob, cara].map((s) => waitFor(s, 'round_end', (d) => d.turnId === 1)));
  check('round ended early for everyone (all_guessed) and the word is revealed', end1.every((e) => e.reason === 'all_guessed' && e.word === word));
  await sleep(100);
  check('exactly one round_end per client', [alice, bob, cara].every((s) => evs(s, 'round_end', (d) => d.turnId === 1).length === 1));
  check('round_end scores equal on all clients', end1.every((e) => JSON.stringify(e.scores) === JSON.stringify(end1[0].scores)));
  check('scores match the rule (Alice 50, Bob 100, Cara 80)', JSON.stringify(scoreMap(cara)) === JSON.stringify(expected));
  check('guess after round end rejected', (await request(cara, 'guess', { text: word })).error?.code === 'WRONG_PHASE');

  // secrecy: nothing broadcast to the guessers before round_end contained the word
  const leaked = (s) => s.events
    .slice(0, s.events.findIndex((e) => e.ev === 'round_end'))
    .filter((e) => ['game_state', 'round_start', 'word_chosen', 'guess_result', 'draw_data', 'canvas_clear', 'player_joined'].includes(e.ev))
    .filter((e) => !(e.ev === 'game_state' && e.d.phase === 'round_end'))
    .some((e) => JSON.stringify(e.d).includes(`"${word}"`) || JSON.stringify(e.d).includes(word));
  check('SECRET: no state/guess_result event sent to Bob or Cara contained the word before round_end', !leaked(bob) && !leaked(cara));

  // ---- turn 2: Bob draws and nobody guesses -> timer ends it ----
  const start2 = await waitFor(bob, 'round_start', (d) => d.turnId === 2);
  await request(bob, 'word_chosen', { word: start2.wordOptions[0] });
  const end2 = await waitFor(cara, 'round_end', (d) => d.turnId === 2, 8000);
  check('turn 2: nobody guessed, the timer ended it', end2.reason === 'time' && end2.scores.every((s) => s.delta === 0));
  check('turn 2: scores unchanged and persisted', JSON.stringify(scoreMap(alice)) === JSON.stringify(expected));

  // ---- turns 3-6: Cara, Alice, Bob, Cara draw; guess order varies ----
  const plan = [
    { turn: 3, drawer: 'Cara', order: ['Alice', 'Bob'] },
    { turn: 4, drawer: 'Alice', order: ['Cara', 'Bob'] },
    { turn: 5, drawer: 'Bob', order: ['Alice', 'Cara'] },
    { turn: 6, drawer: 'Cara', order: ['Bob', 'Alice'] },
  ];
  for (const { turn, drawer, order } of plan) {
    const d = byName[drawer];
    const start = await waitFor(d, 'round_start', (x) => x.turnId === turn);
    const w = (await request(d, 'word_chosen', { word: start.wordOptions[0] })).word;
    await Promise.all(order.map((n) => waitFor(byName[n], 'game_state', (x) => x.phase === 'drawing' && x.game.turnId === turn)));
    for (const [i, n] of order.entries()) {
      const res = await request(byName[n], 'guess', { text: w });
      if (!(res.ok && res.correct && res.points === [100, 80][i])) throw new Error(`FAILED: turn ${turn} ${n} guess result ${JSON.stringify(res)}`);
      expected[n] += [100, 80][i];
    }
    expected[drawer] += 50;
    await waitFor(d, 'round_end', (x) => x.turnId === turn);
  }
  check('turns 3-6: every guess awarded 100 / 80 and each drawer +50', true);

  const over = await Promise.all([alice, bob, cara].map((s) => waitFor(s, 'game_over')));
  await sleep(100);
  check('game_over reached every client exactly once', [alice, bob, cara].every((s) => evs(s, 'game_over').length === 1));
  check('every client got the identical final leaderboard', over.every((o) => JSON.stringify(o.leaderboard) === JSON.stringify(over[0].leaderboard)));
  const finalByName = Object.fromEntries(over[0].leaderboard.map((e) => [e.username, e.score]));
  check('final scores = sum of all turns (scores persisted across rounds)', Object.keys(expected).every((k) => finalByName[k] === expected[k]));
  const topScore = Math.max(...Object.values(expected));
  const topNames = Object.keys(expected).filter((n) => expected[n] === topScore).sort().join();
  check('winner(s) are exactly the highest scorers', over[0].winners.map((w) => w.username).sort().join() === topNames);
  check('leaderboard ranks are consistent with scores', over[0].leaderboard.every((e, i, a) => i === 0 || a[i - 1].score >= e.score) && over[0].leaderboard[0].rank === 1);
  check('guess after game over rejected', (await request(bob, 'guess', { text: 'cat' })).error?.code === 'WRONG_PHASE');

  // ---- rate limit (needs a real room membership; messages are limited before game logic) ----
  console.log('B. rate limit');
  const dan = await connect();
  const eve = await connect();
  const rl = await request(dan, 'create_room', { username: 'Dan' });
  await request(eve, 'join_room', { roomCode: rl.room.code, username: 'Eve' });
  const results = [];
  for (let i = 0; i < 12; i += 1) results.push(await request(dan, 'chat', { text: `m${i}` }));
  check('first 10 messages are not rate limited', results.slice(0, 10).every((r) => r.error?.code !== 'RATE_LIMITED'));
  check('11th and 12th message are rate limited', results.slice(10).every((r) => r.error?.code === 'RATE_LIMITED'));
  check('a different socket is not affected by Dan\'s limit', (await request(eve, 'chat', { text: 'hi' })).error?.code !== 'RATE_LIMITED');

  alice.disconnect(); bob.disconnect(); cara.disconnect(); dan.disconnect(); eve.disconnect();
  await sleep(300);
  const h = await health();
  check('all rooms removed and no timers leaked', h.rooms === 0 && h.timers === 0);

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
}
