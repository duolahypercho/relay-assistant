// SPDX-License-Identifier: MIT
// Build Relay's original bridge against a verified upstream public C API.
// Usage: node scripts/build-listening-helper.mjs /path/to/whisper-v1.9.2-xcframework.zip
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as yauzl from 'yauzl';
import { listeningRelease } from '../server/local-listening-artifacts.mjs';
if (process.platform !== 'darwin' || !process.argv[2])
  throw Error(
    'On a Mac with Xcode command-line tools, supply the pinned whisper.cpp xcframework ZIP.',
  );
const bytes = await readFile(process.argv[2]),
  expected = listeningRelease.artifacts[0];
if (
  bytes.length !== expected.bytes ||
  createHash('sha256').update(bytes).digest('hex') !== expected.sha256
)
  throw Error('The framework archive does not match the pinned release.');
const directory = await mkdtemp(join(tmpdir(), 'relay-listening-build-'));
let zip;
try {
  zip = await yauzl.fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const prefix = listeningRelease.libraryEntry.replace(/whisper$/, 'Headers/');
  const headers = new Set();
  for await (const entry of zip.eachEntry()) {
    if (!entry.fileName.startsWith(prefix)) continue;
    const name = entry.fileName.slice(prefix.length);
    if (!/^[a-z0-9_-]+\.h$/.test(name)) continue;
    if (entry.uncompressedSize > 1024 * 1024 || headers.has(name))
      throw Error('Unexpected public header');
    const stream = await zip.openReadStreamPromise(entry),
      chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    await writeFile(join(directory, name), Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
    headers.add(name);
  }
  if (!headers.has('whisper.h')) throw Error('Missing public C API');
  const output = resolve('native/audio/relay-transcribe-macos');
  execFileSync(
    '/usr/bin/clang',
    [
      '-O2',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=14.0',
      '-I',
      directory,
      'native/audio/transcribe.c',
      '-o',
      output,
    ],
    { stdio: 'inherit' },
  );
  console.log(
    JSON.stringify({
      helper: output,
      sha256: createHash('sha256')
        .update(await readFile(output))
        .digest('hex'),
      architectures: ['arm64', 'x86_64'],
      minimumMacOS: '14.0',
      upstreamVersion: listeningRelease.version,
    }),
  );
} finally {
  zip?.close();
  await rm(directory, { recursive: true, force: true });
}
