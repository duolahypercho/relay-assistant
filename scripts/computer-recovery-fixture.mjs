// SPDX-License-Identifier: MIT
// Deliberate storage loss is restricted to this fixture's deployment-owned computer.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
export async function recoveryComputer(store, services, directory) {
  const dockerHost = process.env.RELAY_TEST_DOCKER_HOST;
  assert(
    dockerHost && dockerHost.includes('relay-live-acceptance'),
    'Use the dedicated relay-live-acceptance Docker engine.',
  );
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: directory,
    dockerHost,
    image: process.env.RELAY_TEST_COMPUTER_IMAGE || 'relay-desktop:setup-9b5d3f3833f38098',
  });
  const snapshots = new ComputerSnapshots(computer);
  Object.assign(services, { computer, computerSnapshots: snapshots });
  const originalVolumes = new Set();
  const owner = (payload) =>
    computer.perform({ ...payload, operationId: randomUUID() }, { actor: 'owner' });
  async function cleanup() {
    await snapshots.close();
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]);
    const names = (
      await computer.checked([
        'volume',
        'ls',
        '--filter',
        `label=org.relay.owner=${computer.owner}`,
        '--format',
        '{{.Name}}',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const name of names) {
      await computer.verifyVolume(name);
      await computer.checked(['volume', 'rm', name]);
    }
    const containers = (
      await computer.checked([
        'container',
        'ls',
        '-a',
        '--filter',
        `label=org.relay.owner=${computer.owner}`,
        '--format',
        '{{.Names}}',
      ])
    ).trim();
    assert.equal(containers, '');
    for (const name of originalVolumes) assert.equal(await snapshots.volumeExists(name), false);
  }
  try {
    await computer.start('owner');
    await computer.takeControl();
    await owner({
      kind: 'files',
      action: 'write',
      path: 'recovery.txt',
      base64: Buffer.from('My original saved work.').toString('base64'),
    });
    snapshots.save();
    await snapshots.pending;
    assert.equal(snapshots.phase, 'done', snapshots.error);
    const point = snapshots.points()[0];
    return {
      computer,
      snapshots,
      point,
      owner,
      async loseWorkspace() {
        const volume = computer.volume;
        await computer.verifyVolume();
        await computer.stop();
        await computer.checked(['rm', computer.name]);
        await computer.checked(['volume', 'rm', volume]);
        originalVolumes.add(volume);
        const status = await computer.status();
        assert.equal(status.state, 'missing');
        await assert.rejects(computer.start('owner'), /saved computer workspace/);
        assert.equal(await snapshots.volumeExists(volume), false);
        return volume;
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
