// Automated execution of the exact manual test steps described for Phase 2
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';

const request = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const once = (socket, event, ms = 2500) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const connect = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error('Connect timeout')), 3000);
    s.on('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
  });

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function run() {
  console.log('Testing Phase 2 Manual Workflow on http://localhost:3000...\n');

  // Step 1: Alice creates room with rounds=4 and isPublic=true
  console.log('Step 1: Alice creates room with custom settings (rounds=4, isPublic=true)');
  const alice = await connect();
  const createRes = await request(alice, 'create_room', {
    username: 'Alice',
    settings: {
      maxPlayers: 8,
      rounds: 4,
      drawTime: 60,
      wordChoices: 3,
      hints: 2,
      isPublic: true,
    },
  });
  assert(createRes.ok === true, 'Alice creates room successfully');
  const code = createRes.room.code;
  assert(/^[A-Z0-9]{5}$/.test(code), `Room code is 5 chars: ${code}`);
  assert(createRes.room.hostId === alice.id, 'Alice is host');
  assert(createRes.room.settings.isPublic === true, 'Setting isPublic is true');
  assert(createRes.room.settings.rounds === 4, 'Setting rounds is 4');

  // Step 2: Bob joins with lowercase code
  console.log('\nStep 2: Bob joins using lowercase code');
  const bob = await connect();
  const aliceJoinNoticePromise = once(alice, 'player_joined');
  const aliceStatePromise = once(alice, 'game_state');
  const bobJoinRes = await request(bob, 'join_room', {
    roomCode: code.toLowerCase(),
    username: 'Bob',
  });
  assert(bobJoinRes.ok === true, 'Bob joined room');
  assert(bobJoinRes.room.players.length === 2, 'Room has 2 players');
  const joinEv = await aliceJoinNoticePromise;
  assert(joinEv.player.username === 'Bob', 'Alice receives "Bob joined" notice');
  const stateEv = await aliceStatePromise;
  assert(stateEv.players.length === 2, 'Alice receives game_state with 2 players');

  // Step 5 check: Bogus code and duplicate username
  console.log('\nStep 5: Testing bogus code and duplicate username');
  const third = await connect();
  const bogusRes = await request(third, 'join_room', { roomCode: 'ZZZZZ', username: 'Charlie' });
  assert(bogusRes.ok === false && bogusRes.error.code === 'ROOM_NOT_FOUND', 'Bogus code returns ROOM_NOT_FOUND');

  const dupRes = await request(third, 'join_room', { roomCode: code, username: 'alice' });
  assert(dupRes.ok === false && dupRes.error.code === 'NAME_TAKEN', 'Duplicate name "alice" returns NAME_TAKEN');

  // Step 4 check: Bob (non-host) cannot start game or edit settings
  console.log('\nStep 4: Non-host controls verified');
  const bobStart = await request(bob, 'start_game', {});
  assert(bobStart.ok === false && bobStart.error.code === 'NOT_HOST', 'Bob cannot start game');
  const bobSettings = await request(bob, 'update_settings', { settings: { rounds: 5 } });
  assert(bobSettings.ok === false && bobSettings.error.code === 'NOT_HOST', 'Bob cannot update settings');

  // Step 6: Alice sets maxPlayers to 2, 3rd player rejected with ROOM_FULL
  console.log('\nStep 6: Alice sets maxPlayers to 2, 3rd player rejected');
  const bobStatePromise = once(bob, 'game_state');
  const updateRes = await request(alice, 'update_settings', { settings: { maxPlayers: 2 } });
  assert(updateRes.ok === true && updateRes.room.settings.maxPlayers === 2, 'Alice sets maxPlayers to 2');
  const bobStateAfterSettings = await bobStatePromise;
  assert(bobStateAfterSettings.settings.maxPlayers === 2, 'Bob sees updated settings');

  const fullRes = await request(third, 'join_room', { roomCode: code, username: 'Charlie' });
  assert(fullRes.ok === false && fullRes.error.code === 'ROOM_FULL', 'Charlie rejected with ROOM_FULL');

  // Step 7: Alice starts game; late join rejected
  console.log('\nStep 7: Host starts game; late join rejected');
  const bobGameStatePromise = once(bob, 'game_state');
  const startRes = await request(alice, 'start_game', {});
  assert(startRes.ok === true, 'Alice starts game');
  const bobGamePlaying = await bobGameStatePromise;
  assert(bobGamePlaying.phase === 'playing', 'Bob receives game_state with phase=playing');

  const lateJoin = await request(third, 'join_room', { roomCode: code, username: 'Charlie' });
  assert(lateJoin.ok === false && lateJoin.error.code === 'GAME_IN_PROGRESS', 'Late join blocked with GAME_IN_PROGRESS');

  // Step 8: Alice disconnects; Bob becomes host; all disconnect -> rooms=0
  console.log('\nStep 8: Host disconnects, host migration, room cleanup');
  const aliceId = alice.id;
  const bobLeftPromise = once(bob, 'player_left');
  const bobHostStatePromise = once(bob, 'game_state');
  alice.disconnect();

  const leftEv = await bobLeftPromise;
  assert(leftEv.playerId === aliceId, 'player_left reports Alice');
  assert(leftEv.newHostId === bob.id, 'Bob is assigned new host');

  const stateAfterLeave = await bobHostStatePromise;
  assert(stateAfterLeave.hostId === bob.id, 'game_state reflects Bob as host');
  assert(stateAfterLeave.players.length === 1, 'Only Bob remains');

  bob.disconnect();
  third.disconnect();

  await new Promise((r) => setTimeout(r, 300));
  const health = await (await fetch(`${URL}/health`)).json();
  assert(health.ok === true && health.rooms === 0, 'Health endpoint shows rooms: 0 after all leave');

  console.log('\nAll manual test step verifications PASSED!\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\nManual workflow test failed:', err);
  process.exit(1);
});
