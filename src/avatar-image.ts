import { avatarPNG, AVATAR_IMAGE_LIMIT } from '../shared/appearance.mjs';
export type PictureSource = { image: HTMLImageElement; url: string };
export async function readAvatarPicture(file: File): Promise<PictureSource> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10_000_000)
    throw new Error('Choose a PNG, JPEG or WebP picture under 10 MB.');
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => header[i] === n);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp =
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!(file.type === 'image/png' ? png : file.type === 'image/jpeg' ? jpeg : webp))
    throw new Error('This file is not a PNG, JPEG or WebP picture.');
  if (png && header.length === 24) {
    const dimensions = new DataView(header.buffer);
    if (dimensions.getUint32(16) * dimensions.getUint32(20) > 24_000_000)
      throw new Error('Choose a picture up to 24 megapixels.');
  }
  const url = URL.createObjectURL(file),
    image = new Image();
  image.src = url;
  try {
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 24_000_000
    )
      throw new Error('Choose a picture up to 24 megapixels.');
    return { image, url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e instanceof Error && e.message.includes('megapixels')
      ? e
      : new Error('This picture could not be opened. Try another PNG, JPEG or WebP.');
  }
}
export function cropAvatarPicture(source: PictureSource, zoom: number, x: number, y: number) {
  const { image } = source;
  const edge = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
  const left = (image.naturalWidth - edge) * x,
    top = (image.naturalHeight - edge) * y;
  const canvas = document.createElement('canvas');
  for (const size of [256, 192, 128]) {
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Picture editing is unavailable in this browser.');
    ctx.drawImage(image, left, top, edge, edge, 0, 0, size, size);
    const data = canvas.toDataURL('image/png');
    if (((data.length - 22) * 3) / 4 <= AVATAR_IMAGE_LIMIT) return avatarPNG(data);
  }
  throw new Error('This picture is too large. Try a simpler picture.');
}
