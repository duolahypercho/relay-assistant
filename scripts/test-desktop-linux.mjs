// SPDX-License-Identifier: MIT
// Copy only reviewed source into a disposable Linux build and real Electron run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { collectSourceFiles } from './source-release.mjs';
const root = resolve(import.meta.dirname, '..');
const stamp = Date.now();
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence',
  `linux-desktop-${stamp}`,
);
const output = resolve(root, `release/desktop/linux-validation-${stamp}`);
const directory = await mkdtemp(join(tmpdir(), 'relay-linux-desktop-'));
const identity = `relay-linux-desktop-${randomUUID().slice(0, 8)}`;
const docker = process.env.RELAY_TEST_DOCKER || 'docker';
const receipt = {
  startedAt: new Date().toISOString(),
  passed: false,
  evidence,
  output,
  checks: [],
};
await mkdir(evidence, { recursive: true });
async function run(args, logName, cwd = root) {
  const path = join(evidence, logName);
  const log = await open(path, 'w');
  let code;
  try {
    code = await new Promise((accept, reject) => {
      const child = spawn(docker, args, {
        cwd,
        stdio: ['ignore', log.fd, log.fd],
        timeout: args[0] === 'build' ? 1200000 : 300000,
        killSignal: 'SIGKILL',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => accept(code ?? signal));
    });
  } finally {
    await log.close();
  }
  const tail = (await readFile(path, 'utf8')).slice(-8000).trim();
  if (code !== 0)
    throw Error(`Docker ${args[0]} failed (${code}). See ${logName}: ${tail.slice(-1500)}`);
  return tail;
}

try {
  const target = await run(['info', '--format', '{{.OSType}} {{.Architecture}}'], 'target.log');
  assert.match(target, /^linux (aarch64|arm64|x86_64|amd64)$/);
  const arch = /aarch64|arm64/.test(target) ? 'arm64' : 'x64';
  receipt.target = target;
  const source = await collectSourceFiles(root);
  receipt.sourceTree = createHash('sha256').update(source.manifestBytes).digest('hex');
  receipt.sourceFiles = source.entries.length;
  for (const entry of source.entries) {
    const path = join(directory, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes, { mode: entry.mode });
  }
  // The entire staging directory already came from the source allowlist.
  await writeFile(join(directory, '.dockerignore'), 'node_modules\nrelease\n.git\n');
  await run(
    ['build', '-f', 'scripts/desktop-linux.Dockerfile', '-t', identity, '.'],
    'build.log',
    directory,
  );
  receipt.checks.push(
    'Clean Linux dependencies and native-architecture Electron package built from reviewed source.',
  );
  await run(
    [
      'create',
      '--name',
      identity,
      '--label',
      'org.relay.acceptance=desktop-linux',
      '--network',
      'none',
      '--shm-size=512m',
      '--security-opt',
      'seccomp=unconfined',
      identity,
    ],
    'create.log',
  );
  // Chromium uses its own renderer sandbox. The outer disposable container permits
  // namespace syscalls, and has no host bind mounts, credentials, ports or Docker socket.
  let runError;
  try {
    await run(['start', '-a', identity], 'app.log');
  } catch (error) {
    runError = error;
  }
  await run(['cp', `${identity}:/evidence/.`, evidence], 'copy-evidence.log');
  if (runError) throw runError;
  const lifecycle = JSON.parse(
    await readFile(join(evidence, `native-desktop-packaged-linux-${arch}.json`)),
  );
  const links = JSON.parse(
    await readFile(join(evidence, `device-links-native-linux-${arch}-acceptance.json`)),
  );
  assert.equal(lifecycle.passed, true);
  assert.equal(links.passed, true);
  assert.equal(lifecycle.runtime.sandboxDisabled, false);
  assert.equal(links.deviceName, 'My Linux PC');
  receipt.backend = JSON.parse(await readFile(join(evidence, 'backend-tests.json')));
  assert.equal(receipt.backend.passed, true);
  assert(receipt.backend.tests > 0);
  const video = JSON.parse(
    await readFile(join(evidence, `video-reader-linux-${arch}-acceptance.json`)),
  );
  assert.equal(video.passed, true);
  receipt.video = video;
  receipt.checks.push(
    'Native video preview, unchanged attachment/draft, timestamped real frames and soundtrack decoding pass with controlled model/transcription services.',
    `${receipt.backend.tests} backend tests pass on Linux.`,
    ...lifecycle.checks,
    ...links.checks,
  );
  await mkdir(output, { recursive: true });
  await run(
    ['cp', `${identity}:/app/release/desktop/Relay-linux-${arch}`, output],
    'copy-package.log',
  );
  receipt.bundle = join(output, `Relay-linux-${arch}`);
  const debArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const debName = `relay-assistant_${source.manifest.version}_${debArch}.deb`;
  for (const suffix of ['', '.sha256'])
    await run(
      [
        'cp',
        `${identity}:/app/release/desktop/${debName}${suffix}`,
        join(output, debName + suffix),
      ],
      `copy-deb${suffix ? '-checksum' : ''}.log`,
    );
  receipt.installer = join(output, debName);
  receipt.installerSha256 = createHash('sha256')
    .update(await readFile(receipt.installer))
    .digest('hex');
  assert(
    (await readFile(receipt.installer + '.sha256', 'utf8')).startsWith(
      receipt.installerSha256 + '  ',
    ),
  );
  receipt.checks.push(
    'Debian installer installs the app menu entry and root-owned sandbox helper; actual journeys use its installed executable.',
  );
  receipt.passed = true;
} catch (error) {
  receipt.error = error.stack;
  process.exitCode = 1;
} finally {
  await run(['rm', '-f', identity], 'cleanup-container.log').catch(() => {});
  await run(['image', 'rm', '--no-prune', identity], 'cleanup-image.log').catch(() => {});
  await rm(directory, { recursive: true, force: true });
  receipt.completedAt = new Date().toISOString();
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
