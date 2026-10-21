// SPDX-License-Identifier: MIT
// Private child of Relay. IPC disconnect also drains Ollama after a parent crash.
import { spawn } from 'node:child_process';
let child,
  stopping = false,
  force;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) return process.exit(0);
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  kill('SIGTERM');
  // The group leader may exit before a runner. Keep the grace timer alive so
  // its descendants are drained even when the leader closes immediately.
  force = setTimeout(() => {
    kill('SIGKILL');
    process.exit(0);
  }, 1500);
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.once('message', (input) => {
  if (stopping || !input || typeof input.executable !== 'string') return process.exit(1);
  child = spawn(input.executable, ['serve'], {
    shell: false,
    detached: true,
    stdio: 'ignore',
    env: input.environment,
  });
  child.once('spawn', () => {
    if (process.connected) process.send({ started: child.pid });
  });
  child.once('error', () => {
    clearTimeout(force);
    process.exit(1);
  });
  child.once('close', stop);
});
