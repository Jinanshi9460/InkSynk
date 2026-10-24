// Comprehensive Phase 0 automated test suite
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 4020;
const URL = `http://localhost:${PORT}`;
let passed = 0;
let totalChecks = 0;

function assert(condition, message) {
  totalChecks += 1;
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const request = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const once = (socket, event, ms = 2500) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const connectClient = () =>
  new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 3000);
    s.on('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

// Spawn server process
const serverProcess = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: String(PORT), CLIENT_URL: 'http://localhost:5173' },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${URL}/health`);
      if (res.ok) return;
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not start in time');
}

async function runTests() {
  try {
    await waitForServer();
    console.log('\n--- 1. Health Endpoint ---');
    const healthInit = await (await fetch(`${URL}/health`)).json();
    assert(healthInit.ok === true && healthInit.rooms === 0, 'Health endpoint reports ok and 0 rooms initially');

    console.log('\n--- 2. Username Validation & Sanitization ---');
    const client1 = await connectClient();

    // Invalid usernames
    const rEmpty = await request(client1, 'create_room', { username: '' });
    assert(rEmpty.ok === false && rEmpty.error.code === 'INVALID_USERNAME', 'Rejects empty username');

    const rWhitespace = await request(client1, 'create_room', { username: '    ' });
    assert(rWhitespace.ok === false && rWhitespace.error.code === 'INVALID_USERNAME', 'Rejects whitespace-only username');

    const rNonString = await request(client1, 'create_room', { username: 12345 });
    assert(rNonString.ok === false && rNonString.error.code === 'INVALID_USERNAME', 'Rejects non-string username');

    const rTooLong = await request(client1, 'create_room', { username: 'A'.repeat(25) });
    assert(rTooLong.ok === false && rTooLong.error.code === 'INVALID_USERNAME', 'Rejects username longer than 20 chars');

    // Valid with whitespace and control chars that should be cleaned
    const rSanitized = await request(client1, 'create_room', { username: '  Player\x00One  ' });
    assert(rSanitized.ok === true, 'Accepts valid username with padding');
    assert(rSanitized.room.players[0].username === 'PlayerOne', 'Sanitizes and trims username correctly');
    const roomCode1 = rSanitized.room.code;
    assert(/^[A-Z0-9]{5}$/.test(roomCode1), `Room code generated is 5 alphanumeric chars (${roomCode1})`);
    assert(rSanitized.playerId === client1.id, 'Returns playerId matching socket ID');
    assert(rSanitized.room.hostId === client1.id, 'Host ID matches client1');

    console.log('\n--- 3. Room Membership Constraints ---');
    // Cannot create or join another room while in a room
    const rDoubleCreate = await request(client1, 'create_room', { username: 'Another' });
    assert(rDoubleCreate.ok === false && rDoubleCreate.error.code === 'ALREADY_IN_ROOM', 'Cannot create room if already in one');

    const rDoubleJoin = await request(client1, 'join_room', { roomCode: roomCode1, username: 'Another' });
    assert(rDoubleJoin.ok === false && rDoubleJoin.error.code === 'ALREADY_IN_ROOM', 'Cannot join room if already in one');

    console.log('\n--- 4. Joining Rooms & Validation ---');
    const client2 = await connectClient();
    const client3 = await connectClient();
    const client4 = await connectClient();

    // Unknown room code
    const rBadRoom = await request(client2, 'join_room', { roomCode: 'NOPE1', username: 'PlayerTwo' });
    assert(rBadRoom.ok === false && rBadRoom.error.code === 'ROOM_NOT_FOUND', 'Rejects non-existent room code');

    // Case-insensitive duplicate name
    const rDupName = await request(client2, 'join_room', { roomCode: roomCode1, username: 'playerone' });
    assert(rDupName.ok === false && rDupName.error.code === 'NAME_TAKEN', 'Rejects duplicate username case-insensitively');

    // Valid join with case-insensitive lowercase room code
    const joinPromise1 = once(client1, 'player_joined');
    const statePromise1 = once(client1, 'game_state');
    const rJoin2 = await request(client2, 'join_room', { roomCode: roomCode1.toLowerCase(), username: 'PlayerTwo' });
    assert(rJoin2.ok === true, 'Player 2 joins successfully');
    assert(rJoin2.room.players.length === 2, 'Room now has 2 players');

    const evJoined1 = await joinPromise1;
    assert(evJoined1.player.username === 'PlayerTwo', 'Host received player_joined event');

    const evState1 = await statePromise1;
    assert(evState1.players.length === 2, 'Host received game_state event with 2 players');

    console.log('\n--- 5. Settings Validation & Permissions ---');
    // Non-host attempts
    const rGuestSettings = await request(client2, 'update_settings', { settings: { rounds: 5 } });
    assert(rGuestSettings.ok === false && rGuestSettings.error.code === 'NOT_HOST', 'Non-host cannot update settings');

    // Host invalid settings
    const rBadRounds = await request(client1, 'update_settings', { settings: { rounds: 1 } }); // min 2
    assert(rBadRounds.ok === false && rBadRounds.error.code === 'INVALID_SETTINGS', 'Rejects rounds < 2');

    const rBadRoundsHigh = await request(client1, 'update_settings', { settings: { rounds: 15 } }); // max 10
    assert(rBadRoundsHigh.ok === false && rBadRoundsHigh.error.code === 'INVALID_SETTINGS', 'Rejects rounds > 10');

    const rBadDrawTimeLow = await request(client1, 'update_settings', { settings: { drawTime: 10 } }); // min 15
    assert(rBadDrawTimeLow.ok === false && rBadDrawTimeLow.error.code === 'INVALID_SETTINGS', 'Rejects drawTime < 15s');

    const rBadDrawTimeHigh = await request(client1, 'update_settings', { settings: { drawTime: 300 } }); // max 240
    assert(rBadDrawTimeHigh.ok === false && rBadDrawTimeHigh.error.code === 'INVALID_SETTINGS', 'Rejects drawTime > 240s');

    const rBadHints = await request(client1, 'update_settings', { settings: { hints: -1 } }); // min 0
    assert(rBadHints.ok === false && rBadHints.error.code === 'INVALID_SETTINGS', 'Rejects negative hints');

    const rBadWordChoices = await request(client1, 'update_settings', { settings: { wordChoices: 6 } }); // max 5
    assert(rBadWordChoices.ok === false && rBadWordChoices.error.code === 'INVALID_SETTINGS', 'Rejects wordChoices > 5');

    const rFloatSetting = await request(client1, 'update_settings', { settings: { rounds: 3.5 } });
    assert(rFloatSetting.ok === false && rFloatSetting.error.code === 'INVALID_SETTINGS', 'Rejects non-integer settings');

    // Setting maxPlayers lower than current count
    const rLowerMax = await request(client1, 'update_settings', { settings: { maxPlayers: 1 } });
    assert(rLowerMax.ok === false && rLowerMax.error.code === 'INVALID_SETTINGS', 'Rejects maxPlayers < current player count');

    // Valid partial settings update
    const statePromise2 = once(client2, 'game_state');
    const rValidSettings = await request(client1, 'update_settings', {
      settings: { maxPlayers: 3, rounds: 5, drawTime: 45, hints: 3, wordChoices: 4 },
    });
    assert(rValidSettings.ok === true, 'Host updates settings with valid ranges');
    assert(rValidSettings.room.settings.maxPlayers === 3, 'maxPlayers set to 3');
    assert(rValidSettings.room.settings.rounds === 5, 'rounds set to 5');
    assert(rValidSettings.room.settings.drawTime === 45, 'drawTime set to 45');
    assert(rValidSettings.room.settings.hints === 3, 'hints set to 3');
    assert(rValidSettings.room.settings.wordChoices === 4, 'wordChoices set to 4');

    const evState2 = await statePromise2;
    assert(evState2.settings.drawTime === 45, 'Guest receives real-time updated settings');

    console.log('\n--- 6. Room Capacity Enforcement ---');
    // Join 3rd player (max is 3)
    const rJoin3 = await request(client3, 'join_room', { roomCode: roomCode1, username: 'PlayerThree' });
    assert(rJoin3.ok === true && rJoin3.room.players.length === 3, 'Player 3 joins (room now at capacity of 3)');

    // 4th player tries to join -> ROOM_FULL
    const rJoin4 = await request(client4, 'join_room', { roomCode: roomCode1, username: 'PlayerFour' });
    assert(rJoin4.ok === false && rJoin4.error.code === 'ROOM_FULL', 'Rejects join when room is full');

    console.log('\n--- 7. Start Game Permissions & Phase Transitions ---');
    // Non-host tries to start
    const rGuestStart = await request(client2, 'start_game', {});
    assert(rGuestStart.ok === false && rGuestStart.error.code === 'NOT_HOST', 'Non-host cannot start game');

    // Host starts game
    const guestStatePlayingPromise = once(client2, 'game_state');
    const rHostStart = await request(client1, 'start_game', {});
    assert(rHostStart.ok === true, 'Host starts game');

    const guestStatePlaying = await guestStatePlayingPromise;
    assert(guestStatePlaying.phase === 'word_selection', 'Guest receives game_state with phase=word_selection (round 1 begins)');

    // Cannot start again when already playing
    const rDoubleStart = await request(client1, 'start_game', {});
    assert(rDoubleStart.ok === false && rDoubleStart.error.code === 'WRONG_PHASE', 'Cannot start game when already playing');

    // Cannot update settings when playing
    const rSettingsInGame = await request(client1, 'update_settings', { settings: { rounds: 4 } });
    assert(rSettingsInGame.ok === false && rSettingsInGame.error.code === 'WRONG_PHASE', 'Cannot update settings during game');

    // Late join blocked when game in progress
    const rLateJoin = await request(client4, 'join_room', { roomCode: roomCode1, username: 'LateComer' });
    assert(rLateJoin.ok === false && rLateJoin.error.code === 'GAME_IN_PROGRESS', 'Late join blocked when game is in progress');

    console.log('\n--- 8. Host Migration & Disconnection ---');
    // Client1 (original host) disconnects
    const hostId = client1.id;
    const leftPromiseFromHost = once(client2, 'player_left');
    const statePromiseAfterHostLeft = once(client2, 'game_state');
    client1.disconnect();

    const evLeft = await leftPromiseFromHost;
    assert(evLeft.playerId === hostId, 'player_left reports host playerId');
    assert(evLeft.newHostId === client2.id, 'Host transferred to Client 2 (second oldest player)');

    const evStateHostLeft = await statePromiseAfterHostLeft;
    assert(evStateHostLeft.hostId === client2.id, 'game_state reflects Client 2 as new host');
    assert(evStateHostLeft.players.length === 2, '2 players remain in room');
    assert(['word_selection', 'drawing', 'round_end'].includes(evStateHostLeft.phase), 'Game still running (not aborted) with 2 players');

    // Client 3 leaves voluntarily via leave_room
    const leaveStatePromise = once(client2, 'game_state');
    const rLeave3 = await request(client3, 'leave_room', {});
    assert(rLeave3.ok === true, 'Client 3 leaves room via leave_room event');

    const evStateAfter3Left = await leaveStatePromise;
    assert(evStateAfter3Left.players.length === 1, 'Only Client 2 remains');
    assert(evStateAfter3Left.phase === 'lobby', 'Room reverts to lobby when player count drops below 2');

    // Now Client 2 is alone in lobby, can they start alone? No, requires >= 2 players
    const rAloneStart = await request(client2, 'start_game', {});
    assert(rAloneStart.ok === false && rAloneStart.error.code === 'NOT_ENOUGH_PLAYERS', 'Cannot start game with < 2 players');

    // Client 4 can now join the room since it reverted to lobby and capacity is not exceeded
    const rRejoin4 = await request(client4, 'join_room', { roomCode: roomCode1, username: 'PlayerFour' });
    assert(rRejoin4.ok === true, 'Player 4 successfully joins reverted lobby');

    console.log('\n--- 9. Empty Room Cleanup & Memory Management ---');
    client2.disconnect();
    client3.disconnect();
    client4.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const healthFinal = await (await fetch(`${URL}/health`)).json();
    assert(healthFinal.rooms === 0, 'All players disconnected: room is cleaned up from memory');

    console.log(`\n========================================`);
    console.log(`Phase 0 Automated Tests: ${passed}/${totalChecks} PASSED`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error(`\nTest failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    serverProcess.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  }
}

runTests();
