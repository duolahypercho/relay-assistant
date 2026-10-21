// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const env = { ...process.env };
async function run(bin, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, shell: false, stdio: quiet ? 'ignore' : 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}
try {
  let ready = await run('docker', ['info'], { quiet: true }).catch(() => 1);
  if (ready && process.platform === 'darwin') {
    const installed = await run('colima', ['version'], { quiet: true }).catch(() => 1);
    if (installed) throw new Error('Install the runtime with: brew install colima docker');
    console.log('Starting Relay’s dedicated Linux VM (no host folder mounts).');
    if (
      await run('colima', [
        'start',
        'relay',
        '--cpu',
        '4',
        '--memory',
        '4',
        '--disk',
        '24',
        '--mount',
        'none',
        '--activate=false',
        '--ssh-config=false',
        '--ssh-agent=false',
        '--vm-type',
        'vz',
        '--downloader',
        'curl',
      ])
    )
      throw new Error('Colima did not start. Retry after checking its output.');
    env.DOCKER_HOST = `unix://${join(homedir(), '.colima/relay/docker.sock')}`;
    ready = await run('docker', ['info'], { quiet: true });
  }
  if (ready) throw new Error('Start your Docker engine, then run this setup again.');
  if (
    await run('docker', [
      'build',
      '-f',
      'docker/desktop.Dockerfile',
      '-t',
      'relay-desktop:local',
      '.',
    ])
  )
    throw new Error('The desktop image build failed. Your server configuration was not changed.');
  let content = existsSync('.env') ? await readFile('.env', 'utf8') : '';
  const settings = {
    RELAY_DESKTOP_ENABLED: 'true',
    RELAY_DESKTOP_IMAGE: 'relay-desktop:local',
    ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}),
  };
  for (const [key, value] of Object.entries(settings)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : content.replace(/\s*$/, '') + '\n' + line + '\n';
  }
  await writeFile('.env', content, { mode: 0o600 });
  console.log('Computer ready. Restart Relay, then open My computer. Files persist when it stops.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
