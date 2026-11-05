// Runs the whole test suite with real Postgres and NATS, then removes them.
import { spawnSync } from 'node:child_process';

const compose = ['compose', '-f', 'docker-compose.test.yml', '-p', 'helpdesk-test'];

const run = (command, args, env) =>
  spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  }).status ?? 1;

let status = run('docker', [...compose, 'up', '-d', '--wait']);

if (status === 0) {
  status = run('npx', ['vitest', 'run'], {
    TEST_DATABASE_URL: 'postgres://helpdesk:helpdesk@127.0.0.1:55432/helpdesk',
    TEST_NATS_URL: 'nats://127.0.0.1:54222',
  });
}

run('docker', [...compose, 'down', '-v']);
process.exit(status);
