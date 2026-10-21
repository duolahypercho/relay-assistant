// SPDX-License-Identifier: MIT
// An administrator can dedicate a separate VM to one Relay workspace. This
// credential grants control of that VM's engine, never of the application host.
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const invalid = () =>
  Error(
    'The remote computer connection file is invalid. Check its endpoint, image and certificates.',
  );
export function remoteComputerEndpoint(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\s\u0000-\u001f]/.test(value))
    throw invalid();
  const url = new URL(value);
  if (
    url.protocol !== 'tcp:' ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535
  )
    throw invalid();
  if (
    !/^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.test(url.hostname) ||
    url.hostname.includes('..')
  )
    throw invalid();
  return `tcp://${url.hostname.toLowerCase()}:${Number(url.port)}`;
}

export function validateRemoteComputer(value, { now = Date.now() } = {}) {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'ca,certificate,endpoint,image,kind,privateKey,version,workspaceId' ||
      value.kind !== 'relay-computer' ||
      value.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(value.workspaceId) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.image)
    )
      throw invalid();
    const endpoint = remoteComputerEndpoint(value.endpoint);
    for (const key of ['ca', 'certificate', 'privateKey']) {
      if (typeof value[key] !== 'string' || value[key].length > 16000 || value[key].includes('\0'))
        throw invalid();
    }
    // A connection has one pinned signing CA; arbitrary certificate chains,
    // extra PEM objects and password-protected key prompts are not accepted.
    const certPattern =
      /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;
    if (
      !certPattern.test(value.ca) ||
      !certPattern.test(value.certificate) ||
      !/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/.test(
        value.privateKey,
      )
    )
      throw invalid();
    const ca = new X509Certificate(value.ca),
      certificate = new X509Certificate(value.certificate);
    for (const cert of [ca, certificate]) {
      if (!(Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now)) throw invalid();
    }
    if (
      !ca.ca ||
      !ca.verify(ca.publicKey) ||
      certificate.ca ||
      !certificate.checkIssued(ca) ||
      !certificate.verify(ca.publicKey) ||
      !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2')
    )
      throw invalid();
    const key = createPrivateKey(value.privateKey);
    if (
      !createPublicKey(key)
        .export({ type: 'spki', format: 'der' })
        .equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    )
      throw invalid();
    return { ...value, endpoint, fingerprint: ca.fingerprint256 };
  } catch {
    throw invalid();
  }
}

export function readRemoteComputer(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw invalid();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64000 || stat.mode & 0o077) throw invalid();
    const bytes = Buffer.alloc(64001);
    let size = 0,
      count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)))
      size += count;
    if (!size || size > 64000) throw invalid();
    return validateRemoteComputer(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))),
    );
  } catch {
    throw invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function remoteComputerFromEnvironment(environment = process.env) {
  const path = environment.RELAY_REMOTE_COMPUTER_FILE;
  if (!path) return null;
  if (
    environment.RELAY_DESKTOP_ENABLED !== 'true' ||
    environment.RELAY_COMPUTER_ENABLED === 'true' ||
    environment.DOCKER_HOST ||
    environment.DOCKER_CONTEXT ||
    environment.RELAY_DESKTOP_IMAGE
  )
    throw Error(
      'Remote computer setup requires RELAY_DESKTOP_ENABLED=true and no other Docker host, context or desktop image setting.',
    );
  const config = readRemoteComputer(path);
  const directory = await mkdtemp(join(tmpdir(), 'relay-computer-tls-'));
  try {
    await mkdir(join(directory, 'config'), { mode: 0o700 });
    for (const [name, value] of [
      ['ca.pem', config.ca],
      ['cert.pem', config.certificate],
      ['key.pem', config.privateKey],
    ])
      await writeFile(join(directory, name), value, { mode: 0o400, flag: 'wx' });
    return {
      endpoint: config.endpoint,
      image: config.image,
      deployment: `remote:${config.workspaceId}`,
      fingerprint: config.fingerprint,
      environment: {
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: directory,
        DOCKER_CONFIG: join(directory, 'config'),
      },
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
