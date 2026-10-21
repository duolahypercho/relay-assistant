// SPDX-License-Identifier: MIT
// Releases use reviewed file names, never the contents of a developer's working directory.
import { constants, createWriteStream } from 'node:fs';
import { open, readFile, lstat, mkdir, realpath, link, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import archiver from 'archiver';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rootFiles = new Set([
  '.dockerignore',
  '.env.example',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  'CONTRIBUTING.md',
  'Dockerfile',
  'Dockerfile.dockerignore',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'capacitor.config.ts',
  'index.html',
  'native-connection.html',
  'package-lock.json',
  'package.json',
  'playwright.config.ts',
  'tsconfig.json',
  'vite.config.ts',
  'source-files.json',
]);
const roots = new Set([
  '.github',
  'src',
  'server',
  'shared',
  'public',
  'scripts',
  'tests',
  'docs',
  'docker',
  'deploy',
  'native',
  'third-party-licenses',
]);
const forbidden = new Set([
  '.git',
  '.openai',
  '.sites-runtime',
  'node_modules',
  'data',
  'work',
  'dist',
  'release',
  'evidence',
  'test-results',
  'playwright-report',
  'DerivedData',
  'build',
  '.gradle',
  '.idea',
  'xcuserdata',
  '.DS_Store',
]);
const required = ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'source-files.json'];
const fixedDate = new Date('2000-01-01T00:00:00Z');

export function validateSourceFiles(input) {
  if (
    input?.version !== 1 ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 5000
  )
    throw Error('Use a version 1 source file list with 1–5,000 paths.');
  const seen = new Set();
  for (const name of input.files) {
    if (typeof name !== 'string' || name.length > 500 || !/^[A-Za-z0-9_@./-]+$/.test(name))
      throw Error('Source paths must be portable relative file names.');
    const parts = name.split('/');
    const basename = parts.at(-1);
    if (
      parts.some((p) => !p || p === '.' || p === '..' || forbidden.has(p)) ||
      (parts.length === 1 ? !rootFiles.has(name) : !roots.has(parts[0])) ||
      (basename !== '.env.example' && /(?:^|\.)env(?:\.|$)/i.test(basename)) ||
      /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|pem|key|p8|p12|pfx|jks|keystore|mobileprovision|relaybackup|log)$/i.test(
        basename,
      ) ||
      /^(?:local\.properties|google-services\.json|GoogleService-Info\.plist|firebase-service-account.*\.json|capacitor\.(?:config|plugins)\.json)$/i.test(
        basename,
      ) ||
      /^native\/mobile\/(?:ios\/App\/(?:App\/)?public|android\/app\/src\/main\/assets\/public)(?:\/|$)/.test(
        name,
      )
    )
      throw Error(`Not a releasable source path: ${name}`);
    if (seen.has(name.toLowerCase())) throw Error(`Duplicate source path: ${name}`);
    seen.add(name.toLowerCase());
  }
  for (const name of required)
    if (!input.files.includes(name)) throw Error(`Source list is missing ${name}.`);
  return [...input.files].sort();
}

async function regularFile(root, name) {
  const parts = name.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw Error(`Source must be a regular file with no linked parent: ${name}`);
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw Error(`Source file is too large or invalid: ${name}`);
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw Error(`Source changed while reading: ${name}`);
    if (/^-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\r?$/m.test(bytes.toString('utf8')))
      throw Error(`Private-key material cannot enter a source release: ${name}`);
    return { path: name, bytes, mode: stat.mode & 0o111 ? 0o755 : 0o644 };
  } finally {
    await handle.close();
  }
}

export async function collectSourceFiles(root) {
  root = await realpath(root);
  const sourceList = await regularFile(root, 'source-files.json');
  const names = validateSourceFiles(JSON.parse(sourceList.bytes.toString('utf8')));
  const entries = [];
  let total = 0;
  for (const name of names) {
    const entry = name === 'source-files.json' ? sourceList : await regularFile(root, name);
    total += entry.bytes.length;
    if (total > 128 * 1024 * 1024)
      throw Error('Source release exceeds 128 MB. Review the file list.');
    entries.push(entry);
  }
  const version = JSON.parse(entries.find((e) => e.path === 'package.json').bytes).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw Error('Use a valid release version.');
  const manifest = {
    format: 1,
    name: 'relay-assistant',
    version,
    files: entries.map((e) => ({
      path: e.path,
      bytes: e.bytes.length,
      mode: e.mode,
      sha256: digest(e.bytes),
    })),
  };
  return {
    root,
    entries,
    manifest,
    manifestBytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  };
}

async function publishFile(temporary, destination) {
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      digest(await readFile(destination)) !== digest(await readFile(temporary))
    )
      throw Error(`Release already exists with different bytes: ${destination}`);
  }
}

export async function packageSourceRelease(root, output) {
  const source = await collectSourceFiles(root);
  const treeHash = digest(source.manifestBytes);
  const folder = `Relay-${source.manifest.version}-source`;
  const name = `${folder}-${treeHash.slice(0, 16)}.zip`;
  output = resolve(output);
  await mkdir(output, { recursive: true });
  const temporary = join(output, `.source-${randomUUID()}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 }, forceLocalTime: false });
  const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o644 });
  const done = finished(stream);
  // Fail together; a compression error must not leave a completion wait pending.
  archive.on('error', (error) => stream.destroy(error));
  archive.on('warning', (error) => stream.destroy(error));
  archive.pipe(stream);
  try {
    for (const entry of source.entries)
      archive.append(entry.bytes, {
        name: `${folder}/${entry.path}`,
        date: fixedDate,
        mode: entry.mode,
      });
    archive.append(source.manifestBytes, {
      name: `${folder}/SOURCE-MANIFEST.json`,
      date: fixedDate,
      mode: 0o644,
    });
    await Promise.all([archive.finalize(), done]);
    const bytes = await readFile(temporary);
    const sha256 = digest(bytes);
    const destination = join(output, name);
    await publishFile(temporary, destination);
    const checksumTemp = join(output, `.source-${randomUUID()}.sha256`);
    const { writeFile } = await import('node:fs/promises');
    try {
      await writeFile(checksumTemp, `${sha256}  ${name}\n`, { flag: 'wx', mode: 0o644 });
      await publishFile(checksumTemp, destination + '.sha256');
    } finally {
      await rm(checksumTemp, { force: true });
    }
    return {
      archive: destination,
      checksum: destination + '.sha256',
      sha256,
      treeHash,
      files: source.entries.length,
      bytes: bytes.length,
      folder,
    };
  } finally {
    archive.abort();
    stream.destroy();
    await done.catch(() => {});
    await rm(temporary, { force: true });
  }
}
