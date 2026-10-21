// SPDX-License-Identifier: MIT
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';

// Compose/Kubernetes secret mounts avoid embedding credentials in images or
// container environment listings. Existing local environment settings still work.
export function deploymentSecret(name, environment = process.env) {
  const value = environment[name] || '',
    path = environment[name + '_FILE'];
  if (!path) return value;
  if (value) throw new Error(`Set either ${name} or ${name}_FILE, not both.`);
  if (!isAbsolute(path)) throw new Error(`${name}_FILE must name an absolute secret file.`);
  let handle;
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size === 0 || stat.size > 8192) throw Error('Invalid secret file');
    const bytes = Buffer.alloc(8193);
    let size = 0,
      count;
    while (
      size < bytes.length &&
      (count = readSync(handle, bytes, size, bytes.length - size, null))
    )
      size += count;
    if (!size || size > 8192) throw Error('Invalid secret length');
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, size))
      .replace(/\r?\n$/, '');
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw Error('Invalid secret content');
    return text;
  } catch {
    throw new Error(`${name}_FILE could not be read as a bounded, single-line secret.`);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
