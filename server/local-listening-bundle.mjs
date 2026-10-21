// SPDX-License-Identifier: MIT
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { listeningRelease, listeningLinuxSource } from './local-listening-artifacts.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function linuxListeningBundle({
  arch = process.arch,
  directory = fileURLToPath(new URL('../native/audio/linux-' + arch, import.meta.url)),
} = {}) {
  if (!['arm64', 'x64'].includes(arch)) return null;
  try {
    if (!lstatSync(directory).isDirectory()) return null;
    const manifestPath = join(directory, 'manifest.json'),
      helperPath = join(directory, 'transcribe');
    const manifestStat = lstatSync(manifestPath),
      helperStat = lstatSync(helperPath);
    if (
      !manifestStat.isFile() ||
      manifestStat.size > 2048 ||
      !helperStat.isFile() ||
      helperStat.size < 64 ||
      helperStat.size > 50_000_000
    )
      return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      manifest.platform !== 'linux' ||
      manifest.arch !== arch ||
      manifest.version !== listeningLinuxSource.version ||
      manifest.sourceSha256 !== listeningLinuxSource.sha256 ||
      manifest.helperBytes !== helperStat.size ||
      !/^[a-f0-9]{64}$/.test(manifest.helperSha256)
    )
      return null;
    const helper = () => readFileSync(helperPath),
      bytes = helper();
    if (
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62) ||
      hash(bytes) !== manifest.helperSha256
    )
      return null;
    return {
      helper,
      artifact: {
        ...listeningRelease,
        version: `${listeningRelease.version}-linux-${arch}-${manifest.helperSha256.slice(0, 12)}`,
        embedded: true,
        helperSha256: manifest.helperSha256,
        helperBytes: bytes.length,
        artifacts: [listeningRelease.artifacts.find((a) => a.name === 'model.bin')],
      },
    };
  } catch {
    return null;
  }
}
