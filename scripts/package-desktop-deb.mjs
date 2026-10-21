// SPDX-License-Identifier: MIT
// Local Debian package; build on the target Linux architecture after desktop:package.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  readFile,
  writeFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
assert.equal(process.platform, 'linux', 'Build the Debian package on Linux.');
assert(['arm64', 'x64'].includes(process.arch), 'Use Linux arm64 or x64.');
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json')));
assert.match(version, /^\d+\.\d+\.\d+$/);
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const bundle = join(root, `release/desktop/Relay-linux-${process.arch}`);
assert((await stat(join(bundle, 'Relay'))).isFile(), 'Run desktop:package first.');
const stage = await mkdtemp(join(tmpdir(), 'relay-deb-'));
const output = join(root, 'release/desktop');
const name = `relay-assistant_${version}_${arch}.deb`;
const archive = join(output, name);
try {
  await chmod(stage, 0o755);
  await cp(bundle, join(stage, 'opt/relay-assistant'), { recursive: true });
  await chmod(join(stage, 'opt/relay-assistant/chrome-sandbox'), 0o4755);
  for (const folder of [
    'DEBIAN',
    'usr/bin',
    'usr/share/applications',
    'usr/share/icons/hicolor/scalable/apps',
    'usr/share/doc/relay-assistant',
  ])
    await mkdir(join(stage, folder), { recursive: true });
  await symlink('/opt/relay-assistant/Relay', join(stage, 'usr/bin/relay-assistant'));
  await cp(
    join(root, 'public/favicon.svg'),
    join(stage, 'usr/share/icons/hicolor/scalable/apps/org.relay.assistant.svg'),
  );
  await writeFile(
    join(stage, 'usr/share/applications/org.relay.assistant.desktop'),
    `[Desktop Entry]\nType=Application\nName=Relay\nComment=Your personal AI assistant\nExec=/usr/bin/relay-assistant %u\nMimeType=x-scheme-handler/relay-assistant;\nIcon=org.relay.assistant\nTerminal=false\nCategories=Office;Utility;\nStartupWMClass=org.relay.assistant\n`,
  );
  await writeFile(
    join(stage, 'usr/share/doc/relay-assistant/copyright'),
    await readFile(join(root, 'LICENSE')),
  );
  const size = (await exec('du', ['-sk', join(stage, 'opt'), join(stage, 'usr')])).stdout
    .trim()
    .split('\n')
    .reduce((sum, line) => sum + Number(line.split(/\s+/)[0]), 0);
  await writeFile(
    join(stage, 'DEBIAN/control'),
    `Package: relay-assistant\nVersion: ${version}\nArchitecture: ${arch}\nSection: utils\nPriority: optional\nMaintainer: Relay local build <local-build@localhost>\nInstalled-Size: ${size}\nDepends: libc6 (>= 2.41), libgtk-3-0t64, libnss3, libasound2t64, libgbm1, libatk-bridge2.0-0t64, libdrm2, libxss1, ffmpeg (>= 7:7.1)\nDescription: Personal AI assistant with a local workspace\n Independently implemented chat, saved work and a connection to your own server.\n This unsigned local build is not an official distribution repository release.\n`,
  );
  await exec('dpkg-deb', ['--root-owner-group', '--build', stage, archive], {
    maxBuffer: 1024 * 1024,
  });
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(archive + '.sha256', `${sha256}  ${name}\n`);
  console.log(JSON.stringify({ archive, sha256, platform: process.platform, arch }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
