// SPDX-License-Identifier: MIT
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const MAGIC = Buffer.from('RELAY-COMPUTER-1');
const CHUNK = 1024 * 1024;
export { MAX_BACKUP_PLAIN, MAX_BACKUP_BYTES } from '../shared/computer-backup.mjs';
import { MAX_BACKUP_PLAIN } from '../shared/computer-backup.mjs';
const invalid = () => Error('The backup is incomplete, damaged, or its password is incorrect.');
export function checkBackupPassword(password) {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password) < 12 ||
    Buffer.byteLength(password) > 1024
  )
    throw Error(
      'Use a backup password between 12 and 1,024 UTF-8 bytes. Keep it somewhere safe; Relay cannot recover it.',
    );
}
async function keyFor(password, salt) {
  checkBackupPassword(password);
  return promisify(scrypt)(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 ** 2 });
}
class Reader {
  constructor(input) {
    this.iterator = input[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }
  async read(size, eof = false) {
    const chunks = [];
    let left = size;
    while (left) {
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (eof && left === size) return null;
          throw invalid();
        }
        this.buffer = Buffer.from(next.value);
        continue;
      }
      const take = Math.min(left, this.buffer.length);
      chunks.push(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      left -= take;
    }
    return Buffer.concat(chunks, size);
  }
}
function frame(header, index, length) {
  const iv = Buffer.alloc(12);
  header.copy(iv, 0, 32, 40);
  iv.writeUInt32BE(index, 8);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(index);
  counter.writeUInt32BE(length, 4);
  return { iv, aad: Buffer.concat([header, counter]), size: counter.subarray(4) };
}
// Each bounded frame is authenticated before any plaintext reaches the isolated importer.
// An authenticated empty final frame makes truncation (including at a frame boundary) fail.
export async function* encryptComputerBackup(input, password) {
  const header = Buffer.concat([MAGIC, randomBytes(16), randomBytes(8)]);
  const key = await keyFor(password, header.subarray(16, 32));
  let index = 0,
    total = 0,
    chunks = [],
    bytes = 0;
  const encode = (plain) => {
    const { iv, aad, size } = frame(header, index++, plain.length);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    return Buffer.concat([size, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  try {
    yield header;
    for await (const chunk of input) {
      total += chunk.length;
      if (total > MAX_BACKUP_PLAIN) throw Error('The computer backup exceeds its size limit.');
      let rest = Buffer.from(chunk);
      while (rest.length) {
        const take = Math.min(CHUNK - bytes, rest.length);
        chunks.push(rest.subarray(0, take));
        bytes += take;
        rest = rest.subarray(take);
        if (bytes === CHUNK) {
          yield encode(Buffer.concat(chunks, bytes));
          chunks = [];
          bytes = 0;
        }
      }
    }
    if (bytes) yield encode(Buffer.concat(chunks, bytes));
    yield encode(Buffer.alloc(0));
  } finally {
    key.fill(0);
  }
}
export async function* decryptComputerBackup(input, password) {
  checkBackupPassword(password);
  const reader = new Reader(input),
    header = await reader.read(40);
  if (!header.subarray(0, 16).equals(MAGIC)) throw invalid();
  const key = await keyFor(password, header.subarray(16, 32));
  let index = 0,
    total = 0,
    partial = false;
  try {
    while (true) {
      const length = (await reader.read(4)).readUInt32BE();
      if (length > CHUNK || (partial && length !== 0) || (total += length) > MAX_BACKUP_PLAIN)
        throw invalid();
      partial = length < CHUNK;
      const encrypted = await reader.read(length + 16),
        { iv, aad } = frame(header, index++, length);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(encrypted.subarray(length));
      let plain;
      try {
        plain = Buffer.concat([decipher.update(encrypted.subarray(0, length)), decipher.final()]);
      } catch {
        throw invalid();
      }
      if (!length) {
        if (await reader.read(1, true)) throw invalid();
        return;
      }
      yield plain;
    }
  } finally {
    key.fill(0);
  }
}
