// Builds the images one at a time, then starts the stack. Docker builds them all
// at once by default, which can run a small machine's Docker VM out of memory.
//
//   node scripts/up.mjs sim     No accounts
//   node scripts/up.mjs phone   Real AI in the browser. Needs OPENAI_API_KEY in .env

import { spawnSync } from 'node:child_process';

const SERVICES = ['call-gateway', 'knowledge-service', 'call-worker', 'admin-ui', 'ingest', 'sim'];

const envFiles = {
  sim: ['--env-file', 'deploy/sim/sim.env'],
  phone: ['--env-file', '.env', '--env-file', 'deploy/sim/phone.env'],
};

const mode = process.argv[2] ?? 'sim';
const compose = ['compose', ...(envFiles[mode] ?? envFiles.sim)];

function docker(...args) {
  const { status } = spawnSync('docker', [...compose, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (status !== 0) process.exit(status ?? 1);
}

for (const service of SERVICES) {
  console.log(`Building ${service}...`);
  docker('build', service);
}

docker('up', '-d', '--wait', '--wait-timeout', '180');

console.log(`
Ready:
  Test phone   http://localhost:9000
  Admin        http://localhost:8082
  Grafana      http://localhost:3000
  Jaeger       http://localhost:16686
  Mailpit      http://localhost:8025
`);
