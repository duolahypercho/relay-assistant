// SPDX-License-Identifier: MIT
// General-purpose upstream runtimes, downloaded only after an owner requests setup.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const exec = promisify(execFile);
export const engineRelease = Object.freeze({
  version: 'colima-0.10.3-lima-2.2.1-docker-29.8.2-buildx-0.38.0-arm64',
  artifacts: [
    {
      name: 'colima',
      bytes: 15656320,
      sha256: '980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34',
      url: 'https://github.com/abiosoft/colima/releases/download/v0.10.3/colima-Darwin-arm64',
      target: 'bin/colima',
    },
    {
      name: 'lima.tgz',
      bytes: 38328082,
      sha256: '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e',
      url: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz',
      archive: 'lima',
    },
    {
      name: 'docker.tgz',
      bytes: 19612997,
      sha256: '5ffa2bafbabe073470f0333f4a129599230b73d1170bb61146b3d9b08e1d1325',
      url: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.8.2.tgz',
      archive: 'docker',
    },
    {
      name: 'docker-buildx',
      bytes: 65462960,
      sha256: '85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344',
      url: 'https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.darwin-arm64',
      target: 'cli-plugins/docker-buildx',
    },
  ],
});
export async function downloadEngineArtifact(fetcher, artifact, signal) {
  let url = new URL(artifact.url);
  for (let i = 0; i < 4; i++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') || '', url);
      if (
        url.hostname === 'download.docker.com' ||
        next.protocol !== 'https:' ||
        next.hostname !== 'release-assets.githubusercontent.com' ||
        next.port ||
        next.username ||
        next.password
      )
        throw Error('Unexpected engine release redirect');
      url = next;
      continue;
    }
    if (
      !response.ok ||
      !response.body ||
      (response.headers.has('content-length') &&
        Number(response.headers.get('content-length')) !== artifact.bytes)
    ) {
      await response.body?.cancel();
      throw Error('Engine release unavailable or changed');
    }
    return response;
  }
  throw Error('Too many engine release redirects');
}
export async function unpackEngineArtifact(artifact, path, files, signal) {
  if (artifact.target) {
    const target = join(files, artifact.target);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await rename(path, target);
    await chmod(target, 0o755);
    return;
  }
  const options = {
    signal,
    timeout: 60000,
    maxBuffer: 128000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  };
  const { stdout } = await exec('/usr/bin/tar', ['-tzf', path], options);
  const entries = stdout.trim().split('\n');
  if (
    entries.length > 1000 ||
    entries.some(
      (name) =>
        !/^\.\/$|^(?:\.\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/?$/.test(name) ||
        name.split('/').includes('..'),
    )
  )
    throw Error('Unexpected engine archive');
  await exec(
    '/usr/bin/tar',
    ['-xzf', path, '-C', files, '--no-same-owner', '--no-same-permissions'],
    options,
  );
  if (artifact.archive === 'docker') {
    await rename(join(files, 'docker/docker'), join(files, 'bin/docker'));
    await rm(join(files, 'docker'), { recursive: true });
  }
}
export async function checkEngineFiles(files) {
  const root = await realpath(files);
  let bytes = 0,
    count = 0;
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        stat = await lstat(path);
      if (++count > 1500) throw Error('Unexpected engine file count');
      if (stat.isSymbolicLink()) {
        if (!(await realpath(path)).startsWith(root + sep)) throw Error('External engine link');
      } else if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 600 * 1024 * 1024 || stat.mode & 0o6000) throw Error('Unexpected engine file');
      } else throw Error('Unexpected engine file type');
    }
  }
  await walk(files);
  for (const name of ['bin/colima', 'bin/limactl', 'bin/docker', 'cli-plugins/docker-buildx']) {
    if (!(await lstat(join(files, name))).isFile()) throw Error('Missing engine executable');
    await access(join(files, name), constants.X_OK);
  }
}
export class ComputerEngineRelease {
  constructor(
    root,
    {
      release = engineRelease,
      fetcher = fetch,
      unpack = unpackEngineArtifact,
      check = checkEngineFiles,
    } = {},
  ) {
    Object.assign(this, { root, release, fetcher, unpack, check });
    this.destination = join(root, 'tools');
  }
  async installed() {
    try {
      if (!(await lstat(this.destination)).isDirectory()) return false;
      const marker = join(this.destination, 'relay-release.json');
      if (!(await lstat(marker)).isFile()) return false;
      const saved = JSON.parse(await readFile(marker, 'utf8'));
      if (JSON.stringify(saved) !== JSON.stringify(this.release)) return false;
      for (const name of ['bin/colima', 'bin/limactl', 'bin/docker', 'cli-plugins/docker-buildx']) {
        if (!(await lstat(join(this.destination, name))).isFile()) return false;
        await access(join(this.destination, name), constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }
  async install(id, signal, progress) {
    if (await this.installed()) return;
    try {
      await lstat(this.destination);
      throw Error('Engine destination already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const stage = join(this.root, '.install-' + id),
      files = join(stage, 'files');
    await mkdir(stage, { mode: 0o700 });
    let completed = 0;
    try {
      await mkdir(files, { mode: 0o700 });
      await mkdir(join(files, 'bin'), { mode: 0o700 });
      for (const artifact of this.release.artifacts) {
        signal.throwIfAborted();
        const path = join(stage, artifact.name),
          digest = createHash('sha256');
        const response = await downloadEngineArtifact(this.fetcher, artifact, signal);
        let count = 0;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            count += chunk.length;
            if (count > artifact.bytes) return callback(Error('Engine release too large'));
            digest.update(chunk);
            progress(completed + count);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          meter,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
        if (count !== artifact.bytes || digest.digest('hex') !== artifact.sha256)
          throw Error('Engine integrity check failed');
        completed += count;
        await this.unpack(artifact, path, files, signal);
      }
      await this.check(files);
      signal.throwIfAborted();
      await writeFile(join(files, 'relay-release.json'), JSON.stringify(this.release), {
        flag: 'wx',
        mode: 0o600,
      });
      // An unrelated or invalid destination is never overwritten.
      await rename(files, this.destination);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
