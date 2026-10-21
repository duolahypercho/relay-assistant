// SPDX-License-Identifier: MIT
const types = {
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  'audio/flac': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/ogg': 'video',
  'video/quicktime': 'video',
};
const extensions = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};
export function mediaMime(file) {
  const mime = String(file?.mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (Object.hasOwn(types, mime))
    return (
      { 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/x-wav': 'audio/wav' }[mime] ||
      mime
    );
  // A real explicit type wins over an extension. Never render HTML/SVG as media.
  if (mime && mime !== 'application/octet-stream') return '';
  const extension = String(file?.name || '')
    .split('.')
    .at(-1)
    .toLowerCase();
  return Object.hasOwn(extensions, extension) ? extensions[extension] : '';
}
export const mediaKind = (file) => {
  const mime = mediaMime(file);
  return Object.hasOwn(types, mime) ? types[mime] : '';
};
