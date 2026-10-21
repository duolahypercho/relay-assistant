// SPDX-License-Identifier: MIT
import { posix } from 'node:path';
export function connectorLaunch(input, prior) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Enter a local tool program.');
  const { command, args = [], cwd = '/workspace', env = {} } = input;
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(command) ||
    command !== command.trim() ||
    (!command.startsWith('/') && /\s/.test(command))
  )
    throw Error('Enter the program name or path, with arguments in the separate field.');
  if (
    !Array.isArray(args) ||
    args.length > 100 ||
    args.some((a) => typeof a !== 'string' || a.length > 4096 || a.includes('\0')) ||
    JSON.stringify(args).length > 16000
  )
    throw Error('Use up to 100 arguments, one per line.');
  if (typeof cwd !== 'string' || cwd.length > 1024 || /[\x00-\x1f\x7f]/.test(cwd))
    throw Error('Choose a folder inside /workspace.');
  const folder = posix.resolve('/workspace', cwd);
  if (folder !== '/workspace' && !folder.startsWith('/workspace/'))
    throw Error('Choose a folder inside /workspace.');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 32)
    throw Error('Use up to 32 environment variables.');
  const same =
    prior &&
    prior.command === command &&
    prior.cwd === folder &&
    JSON.stringify(prior.args) === JSON.stringify(args);
  const variables = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key))
      throw Error('Use a valid environment variable name.');
    const secret = value === null && same ? prior.env[key] : value;
    if (typeof secret !== 'string' || secret.length > 8192 || secret.includes('\0'))
      throw Error(
        'Re-enter saved environment values when changing the program, arguments or folder.',
      );
    Object.defineProperty(variables, key, { value: secret, enumerable: true, writable: true });
  }
  const launch = { command, args: [...args], cwd: folder, env: variables };
  if (Buffer.byteLength(JSON.stringify(launch)) > 64000)
    throw Error('This local tool configuration is too large.');
  return launch;
}
export function redactConnection(value, record) {
  const secrets = [
    ...new Set([record.token, ...Object.values(record.launch?.env || {})].filter(Boolean)),
  ].sort((a, b) => b.length - a.length);
  function clean(item) {
    if (typeof item === 'string')
      return secrets.reduce((v, secret) => v.split(secret).join('[redacted]'), item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [clean(k), clean(v)]));
    return item;
  }
  return clean(value);
}
