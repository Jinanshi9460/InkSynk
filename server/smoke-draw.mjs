// Real Socket.IO test for the drawing contract (Phase 3) with the real drawer rules (Phase 4). No mocks.
// Run with: npm run smoke:draw
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 4011;
const URL = `http://localhost:${PORT}`;
let passed = 0;

function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
}
const request = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.log = []; // every draw/canvas event this client receives, in order
    for (const ev of ['draw_data', 'draw_undo', 'canvas_clear']) s.on(ev, (d) => s.log.push({ ev, d }));
    s.on('round_start', (d) => { s.roundStart = d; }); // private word options arrive here (drawer only)
    s.on('round_end', (d) => { s.roundEnd = d; });
    s.on('connect', () => resolve(s));
  });
const once = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });

const server = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173', GAME_TIME_SCALE: '0.3' },
  stdio: 'ignore',
});
async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${URL}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

const stroke = (id, extra = {}) => ({ strokeId: id, x: 0.1, y: 0.2, color: '#ff0000', size: 5, mode: 'pen', ...extra });

try {
  await waitForServer();
  const host = await connect();
  const guest = await connect();
  const third = await connect(); // second guesser in the main room
  const outsider = await connect(); // in a different room
  const lonely = await connect(); // in no room

  const created = await request(host, 'create_room', { username: 'Alice' });
  const code = created.room.code;
  await request(guest, 'join_room', { roomCode: code, username: 'Bob' });
  await request(third, 'join_room', { roomCode: code, username: 'Cara' });
  for (const c of [host, guest, third]) c.log.length = 0; // ignore anything from joining
  const other = await request(outsider, 'create_room', { username: 'Eve' });
  check('second room exists', other.ok && other.room.code !== code);

  console.log('Before the game starts');
  check('draw_start in lobby rejected (WRONG_PHASE)', (await request(host, 'draw_start', stroke('lobby-stroke-1'))).error?.code === 'WRONG_PHASE');
  check('draw_sync works in lobby (empty)', (await request(guest, 'draw_sync', {})).strokes.length === 0);
  check('draw_sync outside a room rejected', (await request(lonely, 'draw_sync', {})).error?.code === 'NOT_IN_ROOM');
  check('draw_start outside a room rejected', (await request(lonely, 'draw_start', stroke('nowhere-1'))).error?.code === 'NOT_IN_ROOM');

  const state = once(guest, 'game_state');
  await request(host, 'start_game', {});
  const started = await state;
  check('game_state carries server-chosen drawerId (first player = host)', started.drawerId === created.playerId && started.phase === 'word_selection');
  check('drawer cannot draw before choosing a word (WRONG_PHASE)', (await request(host, 'draw_start', stroke('early-stroke-1'))).error?.code === 'WRONG_PHASE');
  await sleep(100);
  check('drawer received private word options', Array.isArray(host.roundStart?.wordOptions) && host.roundStart.wordOptions.length === 3);
  const picked = await request(host, 'word_chosen', { word: host.roundStart.wordOptions[0] });
  check('drawer chooses a word -> DRAWING', picked.ok === true);
  await sleep(50);
  host.log.length = 0; guest.log.length = 0; third.log.length = 0;

  console.log('Permissions: a non-drawer cannot do anything');
  check('guest draw_start rejected', (await request(guest, 'draw_start', stroke('guest-stroke-1'))).error?.code === 'NOT_DRAWER');
  check('guest draw_move rejected', (await request(guest, 'draw_move', { strokeId: 'guest-stroke-1', points: [[0.1, 0.1]] })).error?.code === 'NOT_DRAWER');
  check('guest draw_end rejected', (await request(guest, 'draw_end', { strokeId: 'guest-stroke-1' })).error?.code === 'NOT_DRAWER');
  check('guest draw_undo rejected', (await request(guest, 'draw_undo', {})).error?.code === 'NOT_DRAWER');
  check('guest canvas_clear rejected', (await request(guest, 'canvas_clear', {})).error?.code === 'NOT_DRAWER');
  check('guest cannot spoof drawerId', (await request(guest, 'draw_start', { ...stroke('guest-stroke-2'), drawerId: guest.id })).error?.code === 'NOT_DRAWER');
  check('dev_set_drawer no longer exists (no ack)', await new Promise((r) => { const t = setTimeout(() => r(true), 300); guest.emit('dev_set_drawer', { playerId: guest.id }, () => { clearTimeout(t); r(false); }); }));
  await sleep(100);
  check('rejected guest events broadcast nothing', host.log.length === 0 && guest.log.length === 0 && third.log.length === 0);

  console.log('Validation (drawer sending bad data)');
  const bad = async (name, payload) => check(name, (await request(host, 'draw_start', payload)).error?.code === 'INVALID_STROKE');
  await bad('bad color rejected', stroke('bad-color-1', { color: 'red' }));
  await bad('bad size rejected', stroke('bad-size-01', { size: 999 }));
  await bad('bad mode rejected', stroke('bad-mode-01', { mode: 'laser' }));
  await bad('bad id rejected', stroke('x'));
  await bad('NaN coordinate rejected', stroke('bad-coord-1', { x: 'a' }));
  check('move without active stroke rejected', (await request(host, 'draw_move', { strokeId: 'nothing-active', points: [[0.1, 0.1]] })).error?.code === 'INVALID_STROKE');

  console.log('Drawing: host draws, guest receives, host is not echoed');
  check('draw_start ok', (await request(host, 'draw_start', stroke('stroke-aaaa-1'))).ok === true);
  const batch = Array.from({ length: 30 }, (_, i) => [0.1 + i / 100, 0.2 + i / 200]);
  check('draw_move ok (30-point batch)', (await request(host, 'draw_move', { strokeId: 'stroke-aaaa-1', points: batch })).ok === true);
  check('oversized batch rejected', (await request(host, 'draw_move', { strokeId: 'stroke-aaaa-1', points: Array.from({ length: 101 }, () => [0.5, 0.5]) })).error?.code === 'INVALID_STROKE');
  check('out-of-range point clamped, not crashed', (await request(host, 'draw_move', { strokeId: 'stroke-aaaa-1', points: [[5, -3]] })).ok === true);
  check('draw_end ok', (await request(host, 'draw_end', { strokeId: 'stroke-aaaa-1' })).ok === true);
  await sleep(100);
  const g = guest.log.map((l) => l.d.phase);
  check('guest received start, move, move, end in order', JSON.stringify(g) === JSON.stringify(['start', 'move', 'move', 'end']));
  check('guest start has color/size/mode/id', guest.log[0].d.stroke.color === '#ff0000' && guest.log[0].d.stroke.size === 5 && guest.log[0].d.stroke.mode === 'pen' && guest.log[0].d.stroke.id === 'stroke-aaaa-1');
  check('guest move carries the 30 batched points', guest.log[1].d.points.length === 30);
  check('out-of-range point was clamped to 1,0', JSON.stringify(guest.log[2].d.points[0]) === '[1,0]');
  check('drawer is NOT echoed its own strokes', host.log.length === 0);
  check('other room received nothing', outsider.log.length === 0);

  console.log('Eraser, multiple strokes');
  await request(host, 'draw_start', stroke('stroke-bbbb-2', { mode: 'eraser', color: '#123456' }));
  await request(host, 'draw_end', { strokeId: 'stroke-bbbb-2' });
  await request(host, 'draw_start', stroke('stroke-cccc-3', { color: '#00ff00' }));
  await request(host, 'draw_end', { strokeId: 'stroke-cccc-3' });
  check('duplicate stroke id rejected', (await request(host, 'draw_start', stroke('stroke-cccc-3'))).error?.code === 'INVALID_STROKE');
  await sleep(50);
  const sync1 = await request(guest, 'draw_sync', {});
  check('sync returns 3 strokes in order', sync1.ok && sync1.strokes.map((s) => s.id).join() === 'stroke-aaaa-1,stroke-bbbb-2,stroke-cccc-3');
  check('eraser forced to white, mode kept', sync1.strokes[1].mode === 'eraser' && sync1.strokes[1].color === '#ffffff');
  check('sync strokes keep all their points', sync1.strokes[0].points.length === 1 + 30 + 1);
  check('sync reports drawerId', sync1.drawerId === created.playerId);

  console.log('Undo and clear');
  const guestUndo = once(guest, 'draw_undo');
  const hostUndo = once(host, 'draw_undo');
  const undone = await request(host, 'draw_undo', {});
  check('undo removes most recent completed stroke', undone.ok && undone.strokeId === 'stroke-cccc-3');
  check('guest got draw_undo with strokeId', (await guestUndo).strokeId === 'stroke-cccc-3');
  check('drawer also got draw_undo (single source of truth)', (await hostUndo).strokeId === 'stroke-cccc-3');
  check('history now has 2 strokes', (await request(guest, 'draw_sync', {})).strokes.length === 2);

  // an in-progress stroke is never undone
  await request(host, 'draw_start', stroke('stroke-dddd-4'));
  check('undo skips in-progress stroke', (await request(host, 'draw_undo', {})).strokeId === 'stroke-bbbb-2');
  await request(host, 'draw_end', { strokeId: 'stroke-dddd-4' });

  const guestClear = once(guest, 'canvas_clear');
  const hostClear = once(host, 'canvas_clear');
  check('canvas_clear ok', (await request(host, 'canvas_clear', {})).ok === true);
  await guestClear; await hostClear;
  check('both clients received canvas_clear', true);
  check('history empty after clear', (await request(guest, 'draw_sync', {})).strokes.length === 0);
  check('undo on empty canvas -> NOTHING_TO_UNDO', (await request(host, 'draw_undo', {})).error?.code === 'NOTHING_TO_UNDO');
  check('other room still untouched', outsider.log.length === 0);

  console.log('Drawer leaves mid-stroke -> turn ends, pen moves to the next player');
  await request(host, 'draw_start', stroke('stroke-open-5')); // left open on purpose
  await sleep(50);
  guest.log.length = 0; third.log.length = 0;
  const leftState = once(guest, 'game_state');
  host.disconnect();
  await leftState;
  await sleep(100);
  check('remaining players saw the dangling stroke end', guest.log.some((l) => l.d?.phase === 'end' && l.d.strokeId === 'stroke-open-5') && third.log.some((l) => l.d?.phase === 'end' && l.d.strokeId === 'stroke-open-5'));
  check('round_end sent with reason drawer_left', guest.roundEnd?.reason === 'drawer_left' && typeof guest.roundEnd.word === 'string');
  check('no one can draw during the round-end reveal', (await request(guest, 'draw_start', stroke('reveal-draw-1'))).error?.code === 'WRONG_PHASE');

  // Wait for the next turn: the server clears the canvas and picks Bob (next in join order).
  guest.log.length = 0; third.log.length = 0;
  await sleep(2200); // roundEnd pause is 1.5s at this time scale
  check('canvas_clear broadcast at the start of the next turn', guest.log.some((l) => l.ev === 'canvas_clear') && third.log.some((l) => l.ev === 'canvas_clear'));
  check('history is empty for the new turn', (await request(third, 'draw_sync', {})).strokes.length === 0);
  const nextSync = await request(guest, 'sync_game', {});
  check('next drawer is Bob (join order, leaver skipped)', nextSync.room.game.drawerId === guest.id && nextSync.you.role === 'drawer');
  await request(guest, 'word_chosen', { word: guest.roundStart.wordOptions[0] });
  check('new drawer (guest) can draw', (await request(guest, 'draw_start', stroke('guest-ok-001'))).ok === true);
  await request(guest, 'draw_end', { strokeId: 'guest-ok-001' });
  check('other guesser (Cara) still cannot draw', (await request(third, 'draw_start', stroke('cara-no-0001'))).error?.code === 'NOT_DRAWER');

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
  process.exit();
}
