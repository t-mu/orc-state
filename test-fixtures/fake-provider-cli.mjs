#!/usr/bin/env node
import readline from 'node:readline';

const provider = process.argv[2] ?? 'unknown';
const crashOnStart = process.env.FAKE_PROVIDER_CRASH_ON_START === '1';
const heartbeatMs = Number.parseInt(process.env.FAKE_PROVIDER_HEARTBEAT_MS ?? '', 10);

if (crashOnStart) {
  console.error('FIXTURE_CRASH_ON_START');
  process.exit(42);
}

console.log(`FIXTURE_READY provider=${provider}`);

let heartbeatTimer = null;
if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
  heartbeatTimer = setInterval(() => {
    console.log('FIXTURE_HEARTBEAT');
  }, heartbeatMs);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const command = line.trim();
  if (command === 'PING') {
    console.log('FIXTURE_PONG');
    return;
  }
  if (command === 'EXIT') {
    console.log('FIXTURE_BYE');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    rl.close();
    process.exit(0);
  }
  console.log(`FIXTURE_ECHO ${line}`);
});

rl.on('close', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});
