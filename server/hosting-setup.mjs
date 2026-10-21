// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['access-key', 'token-key'];
async function durableFile(path, contents) {
  const handle = await open(path, 'wx', 0o400);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function existing(directory) {
  if (!(await lstat(directory)).isDirectory())
    throw Error('The hosting key directory is invalid. Restore it from your backup.');
  const result = [];
  for (const name of names) {
    const file = join(directory, name),
      stat = await lstat(file);
    if (!stat.isFile() || stat.size > 100)
      throw Error('Invalid hosting keys. Restore them from your backup.');
    result.push((await readFile(file, 'utf8')).trim());
  }
  if (!/^[a-f0-9]{64}$/.test(result[0]) || !/^[A-Za-z0-9+/]{43}=$/.test(result[1]))
    throw Error('Invalid hosting keys. Restore them from your backup.');
  return result[0];
}

export async function initializeHostingSecrets(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw Error('Use a real directory for hosting keys.');
  const destination = join(root, 'current');
  let present = false;
  try {
    await lstat(destination);
    present = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (present) return { created: false, accessKey: await existing(destination) };
  const stage = join(root, '.setup-' + randomUUID());
  await mkdir(stage, { mode: 0o700 });
  try {
    await durableFile(join(stage, names[0]), randomBytes(32).toString('hex') + '\n');
    await durableFile(join(stage, names[1]), randomBytes(32).toString('base64') + '\n');
    await syncDirectory(stage);
    let created = true;
    try {
      await rename(stage, destination);
      await syncDirectory(root);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      created = false;
    }
    return { created, accessKey: await existing(destination) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--show-access-key'))
      throw Error('Use --show-access-key to display the owner key.');
    const result = await initializeHostingSecrets('/run/relay-secrets');
    console.log(
      process.argv.includes('--show-access-key')
        ? result.accessKey
        : 'Relay hosting keys are ready. Existing keys are preserved.',
    );
  } catch {
    console.error(
      'Hosting keys could not be initialized. Check the private secrets volume or restore its backup; no existing key was replaced.',
    );
    process.exitCode = 1;
  }
}
