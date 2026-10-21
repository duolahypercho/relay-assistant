import { deflateSync } from 'node:zlib';
export function pngChunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.from(type),
    body = Buffer.concat([head, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
export function avatarFixture({ width = 120, height = 80, metadata = true, raw, pixels } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = raw || Buffer.alloc((width * 4 + 1) * height);
  if (!raw)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = y * (width * 4 + 1) + 1 + x * 4;
        const inside =
          ((x - width * 0.5) / (width * 0.33)) ** 2 + ((y - height * 0.5) / (height * 0.43)) ** 2 <
          1;
        rows[at] = inside ? 237 : 112;
        rows[at + 1] = inside ? 182 : 154;
        rows[at + 2] = inside ? 120 : 170;
        rows[at + 3] = 255;
        if (
          inside &&
          ((x - width * 0.4) ** 2 + (y - height * 0.43) ** 2 < 9 ||
            (x - width * 0.6) ** 2 + (y - height * 0.43) ** 2 < 9)
        )
          rows[at] = rows[at + 1] = rows[at + 2] = 30;
      }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(metadata ? [pngChunk('tEXt', Buffer.from('Comment\0private camera metadata'))] : []),
    pngChunk('IDAT', pixels || deflateSync(rows)),
    pngChunk('IEND'),
  ]);
}
export const avatarData = (options) =>
  'data:image/png;base64,' + avatarFixture(options).toString('base64');
