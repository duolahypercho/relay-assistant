// SPDX-License-Identifier: MIT
// Original certificate creation for an administrator-owned, dedicated VM.
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { isIP } from 'node:net';
const exec = promisify(execFile);
export async function createComputerCertificates(
  directory,
  hostname,
  { openssl = 'openssl' } = {},
) {
  if (
    typeof hostname !== 'string' ||
    hostname.length > 253 ||
    (!isIP(hostname) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) ||
    hostname.includes('..')
  )
    throw Error('Use one computer hostname or IP address.');
  await mkdir(directory, { mode: 0o700 });
  const run = (...args) =>
    exec(openssl, args, { cwd: directory, timeout: 30000, maxBuffer: 64000 });
  const caConfig =
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Relay computer CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n';
  await writeFile(join(directory, 'ca.cnf'), caConfig, { mode: 0o600 });
  await run(
    'req',
    '-new',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '3650',
    '-sha256',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca-key.pem',
    '-out',
    'ca.pem',
  );
  for (const role of ['server', 'client']) {
    const ext =
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=' +
      role +
      'Auth\n' +
      (role === 'server' ? `subjectAltName=${isIP(hostname) ? 'IP' : 'DNS'}:${hostname}\n` : '');
    await writeFile(join(directory, role + '.cnf'), ext, { mode: 0o600 });
    await run(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=Relay computer ' + role,
      '-keyout',
      role + '-key.pem',
      '-out',
      role + '.csr',
    );
    await run(
      'x509',
      '-req',
      '-in',
      role + '.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca-key.pem',
      '-CAcreateserial',
      '-days',
      '365',
      '-sha256',
      '-extfile',
      role + '.cnf',
      '-out',
      role + '-cert.pem',
    );
  }
  for (const file of ['ca-key.pem', 'client-key.pem', 'server-key.pem'])
    await chmod(join(directory, file), 0o600);
  return {
    ca: await readFile(join(directory, 'ca.pem'), 'utf8'),
    certificate: await readFile(join(directory, 'client-cert.pem'), 'utf8'),
    privateKey: await readFile(join(directory, 'client-key.pem'), 'utf8'),
  };
}
