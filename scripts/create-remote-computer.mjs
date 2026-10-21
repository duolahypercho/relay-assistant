// SPDX-License-Identifier: MIT
// Run on a dedicated computer VM. Creates files only; never changes a daemon,
// opens a port, copies credentials or accepts a host's trust on the user's behalf.
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createComputerCertificates } from './remote-computer-certificates.mjs';
import { validateRemoteComputer } from '../server/remote-computer.mjs';

const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (
    !['--hostname', '--port', '--image', '--directory'].includes(name) ||
    !args[i + 1] ||
    Object.hasOwn(options, name)
  )
    throw Error(
      'Supply --hostname, --image (a sha256 image ID), --directory (a new absolute private folder), and optionally --port.',
    );
  options[name] = args[i + 1];
}
const hostname = options['--hostname'],
  image = options['--image'],
  directory = options['--directory'];
const port = options['--port'] || '2376';
if (
  !hostname ||
  !/^sha256:[a-f0-9]{64}$/.test(image || '') ||
  !directory ||
  !isAbsolute(directory) ||
  !/^[1-9][0-9]{0,4}$/.test(port) ||
  Number(port) > 65535
)
  throw Error(
    'Supply a hostname, immutable image ID, valid port and new absolute private directory.',
  );
const keys = await createComputerCertificates(directory, hostname);
const config = {
  kind: 'relay-computer',
  version: 1,
  workspaceId: randomBytes(16).toString('hex'),
  endpoint: `tcp://${hostname.includes(':') ? '[' + hostname + ']' : hostname}:${port}`,
  image,
  ...keys,
};
validateRemoteComputer(config);
await writeFile(join(directory, 'connection.json'), JSON.stringify(config, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(
  join(directory, 'daemon.json'),
  JSON.stringify(
    {
      hosts: ['unix:///var/run/docker.sock', `tcp://0.0.0.0:${port}`],
      tlsverify: true,
      tlscacert: join(directory, 'ca.pem'),
      tlscert: join(directory, 'server-cert.pem'),
      tlskey: join(directory, 'server-key.pem'),
      labels: ['org.relay.computer=dedicated'],
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(
  `Created ${join(directory, 'connection.json')}. Keep it private: it controls this dedicated computer VM. Review docs/REMOTE_COMPUTER.md before enabling the generated daemon configuration. No daemon or network settings were changed.`,
);
