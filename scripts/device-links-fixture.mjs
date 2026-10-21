// SPDX-License-Identifier: MIT
// All certificates and accounts are disposable acceptance data. No host trust changes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { request, Agent } from 'node:https';
const exec = promisify(execFile);
export async function deviceLinksFixture(directory, { configure } = {}) {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Device Link Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await writeFile(
    join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',
  );
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-config',
    join(directory, 'ca.conf'),
    '-keyout',
    join(directory, 'ca.key'),
    '-out',
    join(directory, 'ca.pem'),
  ]);
  await exec('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.csr'),
  ]);
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    join(directory, 'server.csr'),
    '-CA',
    join(directory, 'ca.pem'),
    '-CAkey',
    join(directory, 'ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    join(directory, 'leaf.ext'),
    '-out',
    join(directory, 'server.pem'),
  ]);
  const key = 'native-fixture-owner-key-24-characters';
  const f = await assistantsFixture(directory, {
    configure,
    accessKey: key,
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    respond: () => ({ role: 'assistant', content: 'Your devices are sharing this conversation.' }),
  });
  const agent = new Agent({ ca: await readFile(join(directory, 'ca.pem')) });
  let cookie;
  async function raw(path, body) {
    return await new Promise((resolve, reject) => {
      const req = request(
        f.url + path,
        {
          agent,
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            Origin: f.url,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(Error(`Fixture HTTP ${res.statusCode}`));
            if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
            try {
              resolve(JSON.parse(text));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  return {
    ...f,
    key,
    caPath: join(directory, 'ca.pem'),
    async ownerCall(path, body) {
      if (!cookie) await raw('/api/login', { key });
      return raw(path, body);
    },
    async close() {
      await f.close();
      agent.destroy();
    },
  };
}
