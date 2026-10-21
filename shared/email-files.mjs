// SPDX-License-Identifier: MIT
export function isEmailFile(file) {
  const mime = String(file?.mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return (
    mime === 'message/rfc822' ||
    (['', 'application/octet-stream', 'text/plain'].includes(mime) &&
      /\.eml$/i.test(file?.name || ''))
  );
}
