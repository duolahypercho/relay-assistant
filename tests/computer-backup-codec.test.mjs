// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptComputerBackup, decryptComputerBackup } from '../server/computer-backup-codec.mjs';
const password = 'a synthetic backup test password';
async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const source = async function* (bytes, width = 31001) {
  for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width);
};
test('authenticated backup frames stream binary bytes without revealing filenames or contents', async () => {
  const plain = Buffer.concat([
    Buffer.from('private-file.txt: synthetic private contents'),
    randomBytes(2200000),
  ]);
  const a = await collect(encryptComputerBackup(source(plain), password));
  const b = await collect(encryptComputerBackup(source(plain), password));
  assert.notDeepEqual(a, b);
  assert.ok(!a.includes('private-file.txt'));
  assert.ok(!a.includes(password));
  assert.deepEqual(await collect(decryptComputerBackup(source(a, 17), password)), plain);
});
test('wrong passwords, header edits, payload/tag corruption, truncation, reordering and trailing bytes fail closed', async () => {
  const a = await collect(encryptComputerBackup(source(Buffer.alloc(2200000, 37)), password));
  const changed = (index) => {
    const b = Buffer.from(a);
    b[index] ^= 1;
    return b;
  };
  const firstEnd = 40 + 4 + 1048576 + 16;
  const variants = [
    changed(0),
    changed(20),
    changed(35),
    changed(44),
    changed(firstEnd - 1),
    a.subarray(0, 8),
    a.subarray(0, firstEnd),
    a.subarray(0, -1),
    Buffer.concat([a, Buffer.from('x')]),
    Buffer.concat([a.subarray(0, 40), a.subarray(firstEnd), a.subarray(40, firstEnd)]),
  ];
  for (const bytes of variants)
    await assert.rejects(collect(decryptComputerBackup(source(bytes), password)));
  let delivered = 0;
  await assert.rejects(async () => {
    for await (const chunk of decryptComputerBackup(source(a), 'wrong-password-long-enough'))
      delivered += chunk.length;
  });
  assert.equal(delivered, 0);
});
test('invalid passwords and oversized frame declarations are rejected without large allocation', async () => {
  for (const password of ['', 'short', 'x'.repeat(1025)])
    await assert.rejects(
      collect(encryptComputerBackup(source(Buffer.alloc(1)), password)),
      /password/,
    );
  const a = await collect(encryptComputerBackup(source(Buffer.from('small')), password));
  a.writeUInt32BE(0xffffffff, 40);
  await assert.rejects(collect(decryptComputerBackup(source(a), password)));
});
