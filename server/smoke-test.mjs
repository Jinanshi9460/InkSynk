// Real Socket.IO smoke test: starts the server as a child process and drives it with
// real socket.io-client connections (no mocks). Run with: npm run smoke
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 4010;
const URL = `http://localhost:${PORT}`;
let passed = 0;

function check(name, condition) {
  if (!condition) throw new Error(`FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
}

const request = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const once = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const connect = () =>
  new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });

const server = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173' },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

try {
  await waitForServer();
  const host = await connect();
  const guest = await connect();
  const third = await connect();

  console.log('Room creation / joining');
  check('invalid username rejected', (await request(host, 'create_room', { username: '   ' })).error?.code === 'INVALID_USERNAME');
  const created = await request(host, 'create_room', { username: 'Alice' });
  check('create_room ok', created.ok && /^[A-Z0-9]{5}$/.test(created.room.code));
  check('host flagged', created.room.hostId === created.playerId);
  const code = created.room.code;

  check('unknown room rejected', (await request(guest, 'join_room', { roomCode: 'ZZZZZ', username: 'Bob' })).error?.code === 'ROOM_NOT_FOUND');
  check('duplicate name rejected', (await request(guest, 'join_room', { roomCode: code, username: 'alice' })).error?.code === 'NAME_TAKEN');

  const joinedEvent = once(host, 'player_joined');
  const stateEvent = once(host, 'game_state');
  const joined = await request(guest, 'join_room', { roomCode: code.toLowerCase(), username: 'Bob' });
  check('join_room ok (case-insensitive code)', joined.ok && joined.room.players.length === 2);
  check('host receives player_joined', (await joinedEvent).player.username === 'Bob');
  check('host receives game_state with 2 players', (await stateEvent).players.length === 2);

  console.log('Permissions and validation');
  check('non-host cannot update settings', (await request(guest, 'update_settings', { settings: { rounds: 4 } })).error?.code === 'NOT_HOST');
  check('non-host cannot start', (await request(guest, 'start_game', {})).error?.code === 'NOT_HOST');
  check('out-of-range rounds rejected', (await request(host, 'update_settings', { settings: { rounds: 11 } })).error?.code === 'INVALID_SETTINGS');
  check('non-integer drawTime rejected', (await request(host, 'update_settings', { settings: { drawTime: 'abc' } })).error?.code === 'INVALID_SETTINGS');
  check('maxPlayers equal to player count accepted',(await request(host, 'update_settings', { settings: { maxPlayers: 2, rounds: 3 } })).ok === true); // 2 players, max 2 is allowed
  check('room full at maxPlayers=2', (await request(third, 'join_room', { roomCode: code, username: 'Cara' })).error?.code === 'ROOM_FULL');
  const updated = await request(host, 'update_settings', { settings: { maxPlayers: 6, rounds: 4, drawTime: 30 } });
  check('valid settings applied', updated.ok && updated.room.settings.rounds === 4 && updated.room.settings.drawTime === 30);

  console.log('Create-time settings (Phase 2)');
  const solo = await connect();
  check('create_room rejects out-of-range settings', (await request(solo, 'create_room', { username: 'Zed', settings: { rounds: 99 } })).error?.code === 'INVALID_SETTINGS');
  check('create_room rejects non-boolean isPublic', (await request(solo, 'create_room', { username: 'Zed', settings: { isPublic: 'yes' } })).error?.code === 'INVALID_SETTINGS');
  check('create_room rejects non-object settings', (await request(solo, 'create_room', { username: 'Zed', settings: 5 })).error?.code === 'INVALID_SETTINGS');
  check('failed creates did not make rooms', (await (await fetch(`${URL}/health`)).json()).rooms === 1);
  const custom = await request(solo, 'create_room', {
    username: 'Zed', hostId: 'spoofed', settings: { maxPlayers: 4, rounds: 5, drawTime: 90, wordChoices: 2, hints: 0, isPublic: true },
  });
  check('create_room applies custom settings', custom.ok && custom.room.settings.maxPlayers === 4 && custom.room.settings.rounds === 5 && custom.room.settings.hints === 0 && custom.room.settings.isPublic === true);
  check('server ignores client-supplied hostId', custom.room.hostId === solo.id && custom.playerId === solo.id);
  check('defaults: private room', created.room.settings.isPublic === false && created.room.settings.rounds === 3);
  solo.disconnect();
  await new Promise((r) => setTimeout(r, 200));

  console.log('Start game and host transfer');
  const startState = once(guest, 'game_state');
  check('host starts game', (await request(host, 'start_game', {})).ok === true);
  check('guest sees word_selection phase', (await startState).phase === 'word_selection');
  check('late join blocked after start', (await request(third, 'join_room', { roomCode: code, username: 'Cara' })).error?.code === 'GAME_IN_PROGRESS');

  const leftEvent = once(guest, 'player_left');
  host.disconnect();
  const left = await leftEvent;
  check('player_left reports new host', left.newHostId === joined.playerId);
  const health = await (await fetch(`${URL}/health`)).json();
  check('room still exists with one player', health.rooms === 1);

  guest.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  check('empty room cleaned up', (await (await fetch(`${URL}/health`)).json()).rooms === 0);
  third.disconnect();

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
}
