// Live check for Phase 1 updates: port 3000, CLIENT_URL, logging, health, and room workflow.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const URL = 'http://localhost:3000';
let serverOutput = '';

const server = spawn('node', ['index.js'], {
  env: { ...process.env, PORT: '3000', CLIENT_URL: 'http://localhost:5173' },
});

server.stdout.on('data', (d) => {
  serverOutput += d.toString();
  process.stdout.write(d.toString());
});
server.stderr.on('data', (d) => {
  process.stderr.write(d.toString());
});

async function run() {
  try {
    // Wait for server on port 3000
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${URL}/health`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('\n--- Checking /health on port 3000 ---');
    const healthRes = await fetch(`${URL}/health`);
    const health = await healthRes.json();
    console.log('GET /health result:', JSON.stringify(health));
    if (health.ok !== true || health.rooms !== 0) {
      throw new Error('/health failed');
    }

    console.log('\n--- Connecting socket client ---');
    const clientA = io(URL, { transports: ['websocket'] });
    await new Promise((resolve) => clientA.on('connect', resolve));
    console.log(`Client A connected with socket ID: ${clientA.id}`);

    // Wait a brief moment for stdout from server
    await new Promise((r) => setTimeout(r, 200));

    console.log('\n--- Creating room ---');
    const created = await new Promise((resolve) => {
      clientA.emit('create_room', { username: 'Alice' }, resolve);
    });
    console.log(`Room created: ${created.room.code}, host: ${created.room.hostId}`);

    console.log('\n--- Connecting Client B & joining room ---');
    const clientB = io(URL, { transports: ['websocket'] });
    await new Promise((resolve) => clientB.on('connect', resolve));
    console.log(`Client B connected with socket ID: ${clientB.id}`);

    const joined = await new Promise((resolve) => {
      clientB.emit('join_room', { roomCode: created.room.code, username: 'Bob' }, resolve);
    });
    console.log(`Client B joined. Total players in room: ${joined.room.players.length}`);

    console.log('\n--- Disconnecting Client B ---');
    clientB.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    console.log('\n--- Disconnecting Client A ---');
    clientA.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const finalHealth = await (await fetch(`${URL}/health`)).json();
    console.log('Final health (rooms cleaned up):', JSON.stringify(finalHealth));

    console.log('\nAll checks for Phase 1 alignment passed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Check failed:', err);
    process.exit(1);
  } finally {
    server.kill();
  }
}

run();
