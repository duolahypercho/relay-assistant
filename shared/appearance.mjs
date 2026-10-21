// SPDX-License-Identifier: MIT
import pako from 'pako/lib/inflate.js';
export const AVATAR_IMAGE_LIMIT = 128000;
export const SHAPES = ['pebble', 'puff', 'star'];
const fail = () => {
  throw new Error('Choose a Relay character or a PNG picture up to 256 × 256 and 128 KB.');
};
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
function crc(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
// Images never become URLs, markup or model context. Keep only PNG pixel chunks;
// discard metadata/animation/profile chunks and reject trailing data.
export function avatarPNG(data) {
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(AVATAR_IMAGE_LIMIT / 3) * 4 + 22 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    fail();
  let raw;
  try {
    raw = Uint8Array.from(atob(data.slice(22)), (c) => c.charCodeAt(0));
  } catch {
    fail();
  }
  if (
    raw.length > AVATAR_IMAGE_LIMIT ||
    raw.length < 57 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => raw[i] === v)
  )
    fail();
  const chunks = [raw.slice(0, 8)];
  const compressed = [];
  let stride = 0,
    expected = 0;
  let at = 8,
    header = false,
    pixels = false,
    ended = false,
    imageClosed = false;
  while (at < raw.length) {
    if (at + 12 > raw.length) fail();
    const length = u32(raw, at),
      end = at + length + 12;
    if (end > raw.length) fail();
    const name = String.fromCharCode(...raw.slice(at + 4, at + 8));
    if (!/^[A-Za-z]{4}$/.test(name) || crc(raw.subarray(at + 4, end - 4)) !== u32(raw, end - 4))
      fail();
    if (!header && name !== 'IHDR') fail();
    if (name === 'IHDR') {
      if (header || length !== 13) fail();
      const width = u32(raw, at + 8),
        height = u32(raw, at + 12);
      if (
        !width ||
        !height ||
        width > 256 ||
        height > 256 ||
        raw[at + 16] !== 8 ||
        ![2, 6].includes(raw[at + 17]) ||
        raw[at + 18] ||
        raw[at + 19] ||
        raw[at + 20]
      )
        fail();
      header = true;
      stride = 1 + width * (raw[at + 17] === 6 ? 4 : 3);
      expected = stride * height;
    } else if (name === 'IDAT') {
      if (imageClosed) fail();
      pixels = true;
      compressed.push(raw.subarray(at + 8, end - 4));
    } else if (name === 'IEND') {
      if (length || !pixels || end !== raw.length) fail();
      ended = true;
    } else {
      if (pixels) imageClosed = true;
      // Unknown critical chunks change decoding. Truecolor canvas PNG needs no palette.
      if (name[0] === name[0].toUpperCase()) fail();
    }
    if (['IHDR', 'IDAT', 'IEND'].includes(name)) chunks.push(raw.slice(at, end));
    at = end;
  }
  if (!ended) fail();
  // Stream validation stops after at most one output chunk beyond the declared
  // pixel size, avoiding allocation proportional to an untrusted zlib stream.
  const inflater = new pako.Inflate({ windowBits: 15, chunkSize: 4096 });
  let produced = 0;
  inflater.onData = (part) => {
    if (produced + part.length > expected) fail();
    for (let i = 0; i < part.length; i++) if ((produced + i) % stride === 0 && part[i] > 4) fail();
    produced += part.length;
  };
  for (let i = 0; i < compressed.length; i++) {
    if (inflater.ended && compressed[i].length) fail();
    if (!inflater.ended && !inflater.push(compressed[i], i === compressed.length - 1)) fail();
    if (inflater.strm.avail_in) fail();
  }
  if (!inflater.ended || inflater.err || produced !== expected) fail();
  const bytes = new Uint8Array(chunks.reduce((sum, b) => sum + b.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:image/png;base64,' + btoa(binary);
}
/** @typedef {{kind:'sprout'} | {kind:'shape',shape:'pebble'|'puff'|'star'} | {kind:'image',data:string}} Appearance */
/** @returns {Appearance} */
export function validateAppearance(value) {
  if (value == null) return { kind: 'sprout' };
  if (typeof value !== 'object' || Array.isArray(value)) fail();
  const keys =
    value.kind === 'image'
      ? ['kind', 'data']
      : value.kind === 'shape'
        ? ['kind', 'shape']
        : ['kind'];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
  if (value.kind === 'sprout') return { kind: 'sprout' };
  if (value.kind === 'shape' && SHAPES.includes(value.shape))
    return { kind: 'shape', shape: value.shape };
  if (value.kind === 'image') return { kind: 'image', data: avatarPNG(value.data) };
  fail();
}
export const shapePaths = {
  pebble: 'M17 62C9 43 16 19 36 13C55 6 79 12 86 32C94 50 89 73 72 84C53 94 27 85 17 62Z',
  puff: 'M18 69C5 64 4 46 16 39C12 23 28 13 40 20C49 7 69 10 74 24C91 24 97 43 86 54C97 69 83 86 68 81C57 96 38 92 32 80C26 81 20 77 18 69Z',
  star: 'M46 12Q50 5 55 13L64 30Q66 34 72 34L87 36Q96 37 90 45L77 58Q74 61 76 67L79 84Q81 93 72 89L54 79Q50 77 46 80L29 89Q19 94 22 83L25 65Q26 60 22 56L10 44Q3 36 15 35L33 33Q38 33 40 27Z',
};
