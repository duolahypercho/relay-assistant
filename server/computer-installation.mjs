// SPDX-License-Identifier: MIT
// Owner-only bootstrap of a deployment-owned VM. Never reconfigures an existing engine.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, release as osRelease, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, mkdir, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { ComputerEngineRelease } from './computer-engine-release.mjs';
const key = 'computer-installation';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status, ownerMessage: message });
const gib = 1024 ** 3;
// OpenSSH reserves a random suffix while creating its control socket. Check
// that temporary name too, not only the shorter final socket and network paths.
const shortEnough = (root) =>
  [
    'colima/_lima/colima-relay/ssh.sock.1234567890123456',
    'colima/_lima/_networks/user-v2/user-v2_qemu.sock',
  ].every((name) => Buffer.byteLength(join(root, name)) < 104);
const privateHome = () => {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
};
export class ComputerInstallation {
  constructor(
    setup,
    {
      root = join(privateHome(), '.relay', 'vm', setup.computer.owner),
      platform = process.platform,
      arch = process.arch,
      systemRelease = osRelease(),
      memory = totalmem,
      disk = statfs,
      releaseOptions = {},
      timeout = 45 * 60000,
    } = {},
  ) {
    this.setup = setup;
    this.store = setup.computer.store;
    this.root = resolve(root);
    this.memory = memory;
    this.disk = disk;
    this.timeout = timeout;
    this.supported =
      platform === 'darwin' &&
      arch === 'arm64' &&
      Number(systemRelease.split('.')[0]) >= 23 &&
      shortEnough(this.root);
    this.release = new ComputerEngineRelease(this.root, releaseOptions);
    this.host = `unix://${join(this.root, 'colima/relay/docker.sock')}`;
    this.profile = 'relay';
    this.colima = join(this.root, 'tools/bin/colima');
    this.env = {
      HOME: join(this.root, 'home'),
      PATH: join(this.root, 'tools/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
      COLIMA_HOME: join(this.root, 'colima'),
      XDG_CACHE_HOME: join(this.root, 'cache'),
      DOCKER_CONFIG: join(this.root, 'docker-config'),
      TMPDIR: join(this.root, 'tmp'),
      LANG: 'en_US.UTF-8',
      DOCKER_HOST: '',
      DOCKER_CONTEXT: '',
    };
    this.pending = null;
    this.state = null;
    const saved = this.store.secret(key);
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (
          !uuid.test(state.id) ||
          !['running', 'ready', 'cancelled', 'error', 'interrupted'].includes(state.phase)
        )
          throw Error();
        this.state = {
          id: state.id,
          phase: state.phase === 'running' ? 'interrupted' : state.phase,
          completed: 0,
          stage: '',
          error: '',
        };
        if (this.state.phase === 'interrupted')
          this.state.error = 'Setup was interrupted. Continue when you’re ready.';
        if (this.state.phase === 'error')
          this.state.error = 'Your private computer was not ready. Try again.';
        this.persist();
      } catch {
        throw fail('Private computer installation status could not be read.', 503);
      }
    }
  }
  persist() {
    this.store.secret(key, JSON.stringify(this.state));
  }
  get policyAllows() {
    const s = this.setup;
    return (
      this.supported &&
      s.allowed &&
      s.explicit !== 'true' &&
      !s.context &&
      (!s.host || s.host === this.host) &&
      (!s.computer.enabled || s.computer.dockerHost === this.host)
    );
  }
  get selected() {
    return this.bound && this.setup.computer.dockerHost === this.host;
  }
  view(available = false) {
    return {
      supported: this.supported,
      available,
      managed: !!this.selected,
      bytes: this.release.release.artifacts.reduce((n, a) => n + a.bytes, 0),
      busy: !!this.pending,
      cancellable: !!this.pending && !['opening', 'cancelling'].includes(this.state?.stage),
      installation: this.state && { ...this.state },
    };
  }
  async status() {
    if (!this.policyAllows || this.closed) return this.view();
    if (this.pending || this.selected) return this.view(true);
    const engine = await this.setup.engineControl.status();
    return this.view(!engine.running && !engine.canStart && !engine.busy);
  }
  async owned() {
    try {
      if (!(await lstat(this.root)).isDirectory()) return false;
      const path = join(this.root, 'relay-engine.json');
      if (!(await lstat(path)).isFile()) return false;
      const marker = JSON.parse(await readFile(path, 'utf8'));
      return marker.owner === this.setup.computer.owner && marker.version === 1;
    } catch {
      return false;
    }
  }
  async restore() {
    if (!this.policyAllows || !this.state || !(await this.owned())) return;
    if (await this.release.installed()) this.bind();
  }
  bind() {
    const p = this.setup.computer;
    p.docker = join(this.root, 'tools/bin/docker');
    p.dockerHost = this.host;
    p.dockerEnvironment = this.env;
    this.setup.host = this.host;
    this.bound = true;
    this.setup.engineControl.checkedAt = 0;
  }
  async createHome() {
    if (await this.owned()) return;
    await mkdir(join(this.root, '..'), { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST')
        throw fail(
          'The private computer folder already exists and could not be verified. Its files were kept.',
        );
      throw error;
    }
    await writeFile(
      join(this.root, 'relay-engine.json'),
      JSON.stringify({ version: 1, owner: this.setup.computer.owner }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  start(input) {
    if (!this.policyAllows || this.closed)
      throw fail('In-app computer installation is unavailable for this server.', 503);
    const id = input?.id || randomUUID();
    if (typeof id !== 'string' || !uuid.test(id)) throw fail('Choose a new setup request.', 400);
    if (this.state?.id === id) return this.view(true);
    if (this.pending || this.setup.pending || this.setup.engineControl.pending)
      throw fail('Computer setup is already running.');
    this.setup.computer.assertAvailable();
    const previous = this.state?.id;
    this.controller = new AbortController();
    this.state = { id, phase: 'running', stage: 'checking', completed: 0, error: '' };
    this.persist();
    this.pending = this.run(id, previous, this.controller.signal).finally(() => {
      this.pending = null;
      this.setup.engineControl.checkedAt = 0;
    });
    return this.view(true);
  }
  async run(id, previous, ownerSignal) {
    const signal = AbortSignal.any([ownerSignal, AbortSignal.timeout(this.timeout)]);
    try {
      if (!this.selected) {
        // Check again on mutation; a cached UI offer is never authority to replace a runtime.
        const existing = await this.setup.engineControl.inspect(signal);
        if (existing.running || existing.canStart)
          throw fail('An existing computer runtime is available. Use Set up computer to keep it.');
      }
      signal.throwIfAborted();
      if (this.memory() < 8 * gib)
        throw fail('Private computer setup needs a Mac with at least 8 GB of memory.');
      await this.createHome();
      if (!shortEnough(await realpath(this.root)))
        throw fail(
          'The private computer folder path is too long for this Mac. Use an existing Docker or Colima engine instead.',
        );
      const disk = await this.disk(this.root);
      if (Number(disk.bavail) * Number(disk.bsize) < 40 * gib)
        throw fail('Free at least 40 GB on the Relay Mac, then try again.');
      for (const name of ['home', 'colima', 'cache', 'docker-config', 'tmp']) {
        await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
        if (!(await lstat(join(this.root, name))).isDirectory())
          throw fail('A private computer folder could not be verified.');
      }
      if (previous)
        await rm(join(this.root, '.install-' + previous), { recursive: true, force: true });
      this.state.stage = 'downloading';
      this.persist();
      await this.release.install(id, signal, (completed) => {
        this.state.completed = completed;
      });
      await writeFile(
        join(this.root, 'docker-config/config.json'),
        JSON.stringify({ cliPluginsExtraDirs: [join(this.root, 'tools/cli-plugins')] }),
        { mode: 0o600 },
      );
      // Colima's `none` rule serializes a zero port range in this release. An
      // explicit private Lima override blocks every TCP/UDP guest port while
      // preserving the required Unix Docker socket and loopback SSH transport.
      const limaConfig = join(this.root, 'colima/_lima/_config');
      await mkdir(limaConfig, { recursive: true, mode: 0o700 });
      await writeFile(
        join(limaConfig, 'override.yaml'),
        JSON.stringify({
          portForwards: [
            {
              guestIP: '0.0.0.0',
              guestIPMustBeZero: false,
              guestPortRange: [1, 65535],
              hostPortRange: [1, 65535],
              proto: 'any',
              ignore: true,
            },
          ],
        }),
        { mode: 0o600 },
      );
      this.bind();
      this.state.stage = 'creating';
      this.persist();
      const result = await this.setup.runner(
        this.colima,
        [
          'start',
          '--profile',
          this.profile,
          '--vm-type',
          'vz',
          '--runtime',
          'docker',
          '--cpu',
          '4',
          '--memory',
          '4',
          '--disk',
          '25',
          '--root-disk',
          '10',
          '--mount',
          'none',
          '--activate=false',
          '--ssh-config=false',
          '--template=false',
          '--ssh-agent=false',
          '--binfmt=false',
          '--network-address=false',
          '--network-host-addresses=false',
          '--port-forwarder=none',
        ],
        { env: this.env, signal, timeout: 15 * 60000 },
      );
      signal.throwIfAborted();
      if (result.exitCode)
        throw fail(
          'Your private computer could not start. Check your connection and free disk space, then try again.',
        );
      if ((await this.setup.engine(signal)) !== this.host)
        throw fail('The private computer could not be verified.');
      this.state.stage = 'preparing';
      this.persist();
      if (!this.setup.computer.enabled) await this.setup.prepare(signal, { host: this.host });
      signal.throwIfAborted();
      this.state.stage = 'opening';
      this.persist();
      await this.setup.computer.start('owner');
      this.state.phase = 'ready';
      this.state.stage = '';
    } catch (error) {
      this.state.phase = ownerSignal.aborted ? 'cancelled' : 'error';
      this.state.error = ownerSignal.aborted
        ? ''
        : error.ownerMessage ||
          'Setup could not finish. Check your connection and try again; your private files are kept.';
      // Only this deployment's newly provisioned VM is eligible for cancellation cleanup.
      // Never delete it, its disks or its downloaded image layers.
      if (this.bound && !this.setup.computer.enabled && (await this.owned())) {
        this.state.stage = 'cancelling';
        try {
          // During a first boot, the Docker service may not yet exist. Force-stop
          // skips Docker shutdown and stops our owned VM even in that partial state.
          const stopped = await this.setup.runner(
            this.colima,
            ['stop', '--force', '--profile', this.profile],
            { env: this.env, timeout: 60000 },
          );
          const listed = await this.setup.runner(this.colima, ['list', '--json'], {
            env: this.env,
            timeout: 15000,
          });
          const rows = listed.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          if (
            listed.exitCode ||
            rows.some((row) => row.name === this.profile && row.status !== 'Stopped')
          )
            throw Error();
        } catch {
          this.state.error =
            'Setup stopped, but its private computer could not be stopped. Continue setup to recover it.';
        }
      }
      this.state.stage = '';
    } finally {
      this.persist();
    }
  }
  async cancel(input) {
    if (!this.state || (input?.id && input.id !== this.state.id))
      throw fail('This setup request is no longer current.');
    if (this.pending && this.state.stage === 'opening')
      throw fail('The computer is opening. Use Stop once it is ready.');
    this.controller?.abort();
    await this.pending;
    return this.view(this.policyAllows);
  }
  async close() {
    this.closed = true;
    if (this.state?.stage !== 'opening') this.controller?.abort();
    await this.pending;
  }
}
