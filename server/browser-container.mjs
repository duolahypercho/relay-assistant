// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const fail = (message) => Object.assign(new Error(message), { status: 503 });
const none = (value) => !value || Object.keys(value).length === 0;
const local = (host) => typeof host === 'string' && /^unix:\/\/\/[^\r\n\0]+$/.test(host);
const digest = (value) => /^sha256:[a-f0-9]{64}$/.test(value || '');

export function validateBrowserContainer(c, { name, owner, image, source }) {
  const h = c?.HostConfig || {},
    config = c?.Config || {};
  if (!(
    c?.Name === '/' + name &&
    /^[a-f0-9]{64}$/.test(c.Id || '') &&
    config.Labels?.['org.relay.owner'] === owner &&
    config.Labels?.['org.relay.role'] === 'private-browser' &&
    digest(image) &&
    c.Image === image &&
    config.Image === image &&
    config.User === '1000:1000' &&
    config.WorkingDir === '/tmp' &&
    JSON.stringify(config.Entrypoint) === '["/usr/bin/tini"]' &&
    JSON.stringify(config.Cmd) ===
      JSON.stringify(['--', '/usr/bin/node', '--input-type=module', '-e', source]) &&
    config.OpenStdin &&
    !config.Tty &&
    config.StdinOnce &&
    config.Env?.every((v) => /^(PATH|HOME|LANG|DISPLAY)=/.test(v)) &&
    config.Env.includes('HOME=/tmp') &&
    config.Env.includes('DISPLAY=') &&
    h.NetworkMode === 'none' &&
    Object.keys(c.NetworkSettings?.Networks || {}).every((k) => k === 'none') &&
    h.ReadonlyRootfs &&
    !h.Privileged &&
    h.CapDrop?.length === 1 &&
    h.CapDrop[0] === 'ALL' &&
    none(h.CapAdd) &&
    h.SecurityOpt?.length === 1 &&
    h.SecurityOpt[0].startsWith('no-new-privileges') &&
    h.PidsLimit > 0 &&
    h.PidsLimit <= 128 &&
    h.Memory > 0 &&
    h.Memory <= 1073741824 &&
    h.MemorySwap === h.Memory &&
    h.NanoCpus > 0 &&
    h.NanoCpus <= 2e9 &&
    h.ShmSize > 0 &&
    h.ShmSize <= 134217728 &&
    !h.PidMode &&
    h.IpcMode === 'private' &&
    !h.UTSMode &&
    !h.UsernsMode &&
    h.AutoRemove &&
    h.RestartPolicy?.Name === 'no' &&
    none(h.Binds) &&
    none(h.Devices) &&
    none(h.DeviceRequests) &&
    none(h.PortBindings) &&
    none(h.Links) &&
    none(h.VolumesFrom) &&
    none(h.ExtraHosts) &&
    c.Mounts?.length === 0 &&
    Object.keys(h.Tmpfs || {}).length === 1 &&
    h.Tmpfs?.['/tmp'] === 'rw,nosuid,nodev,noexec,size=268435456,mode=1777'
  ))
    throw fail('The private browser’s isolation settings changed. Relay will not attach to it.');
  return c;
}

export class BrowserContainer {
  constructor(computer, { launch = (options) => chromium.launch(options) } = {}) {
    this.computer = computer;
    this.launchBrowser = launch;
    this.name = `relay-browser-${computer.owner}-${randomBytes(12).toString('hex')}`;
    this.closed = false;
  }
  async checked(args, options = {}) {
    const p = this.computer;
    const result = await p.runner(p.docker, this.host ? ['--host', this.host, ...args] : args, {
      timeout: 15000,
      ...options,
      env: {
        ...p.dockerEnvironment,
        DOCKER_CONTEXT: '',
        DOCKER_HOST: '',
        ...(this.host ? {} : { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || '' }),
      },
    });
    if (result.exitCode || result.timedOut)
      throw fail('The isolated browser could not start. Check the computer runtime and try again.');
    return result.stdout;
  }
  async launch() {
    if (this.closed) throw fail('The isolated browser is closed.');
    if (this.browser?.isConnected()) return this.browser;
    if (this.pending) return this.pending;
    this.pending = this.open();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async open() {
    try {
      if (this.id || this.directory || this.browser) await this.dispose();
      this.host = this.computer.dockerHost || process.env.DOCKER_HOST;
      if (!this.host)
        this.host = (
          await this.checked(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
        ).trim();
      if (!local(this.host) && this.host !== this.computer.remoteEngine?.endpoint)
        throw fail('The private browser requires a local Docker or Colima engine.');
      this.source = await readFile(
        new URL('./browser-container-guest.mjs', import.meta.url),
        'utf8',
      );
      const imageInfo = JSON.parse(await this.checked(['image', 'inspect', this.computer.image]));
      this.image = imageInfo[0]?.Id;
      if (!digest(this.image))
        throw fail('Prepare the computer image before opening the private browser.');
      const config = imageInfo[0]?.Config || {};
      if (!none(config.Volumes) || !none(config.OnBuild))
        throw fail('The browser image contains unexpected mounts or build hooks.');
      this.creating = true;
      const id = (
        await this.checked([
          'create',
          '--rm',
          '-i',
          '--name',
          this.name,
          '--label',
          `org.relay.owner=${this.computer.owner}`,
          '--label',
          'org.relay.role=private-browser',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '128',
          '--memory',
          '1g',
          '--memory-swap',
          '1g',
          '--cpus',
          '2',
          '--shm-size',
          '128m',
          '--ipc',
          'private',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,size=268435456,mode=1777',
          '--user',
          '1000:1000',
          '--workdir',
          '/tmp',
          '--env',
          'HOME=/tmp',
          '--env',
          'LANG=C.UTF-8',
          '--env',
          'DISPLAY=',
          '--entrypoint',
          '/usr/bin/tini',
          this.image,
          '--',
          '/usr/bin/node',
          '--input-type=module',
          '-e',
          this.source,
        ])
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(id))
        throw fail('The browser runtime returned an invalid identity.');
      this.id = id;
      await this.inspect();
      if (this.closed) throw fail('Browser startup was cancelled.');
      this.directory = await mkdtemp(join(tmpdir(), 'relay-browser-pipe-'));
      const path = join(this.directory, 'pipe.mjs');
      await writeFile(
        path,
        await readFile(new URL('./browser-container-pipe.mjs', import.meta.url)),
        { mode: 0o600 },
      );
      this.browser = await this.launchBrowser({
        executablePath: process.execPath,
        ignoreDefaultArgs: true,
        args: [path, this.computer.docker, this.host, this.id],
        timeout: 20000,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          ...this.computer.dockerEnvironment,
          ELECTRON_RUN_AS_NODE: '1',
        },
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      await this.inspect();
      if (this.closed) throw fail('Browser startup was cancelled.');
      return this.browser;
    } catch (error) {
      await this.dispose();
      throw error.status
        ? error
        : fail('The isolated browser could not start. Check the computer runtime and try again.');
    }
  }
  async inspect() {
    const c = JSON.parse(await this.checked(['inspect', this.id]))[0];
    return validateBrowserContainer(c, {
      name: this.name,
      owner: this.computer.owner,
      image: this.image,
      source: this.source,
    });
  }
  async dispose() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    if (!this.id && this.creating) {
      // A lost create acknowledgement can leave a stopped container. Recover
      // only this random name after validating its full ownership and policy.
      try {
        const candidate = JSON.parse(await this.checked(['inspect', this.name]))[0];
        validateBrowserContainer(candidate, {
          name: this.name,
          owner: this.computer.owner,
          image: this.image,
          source: this.source,
        });
        this.id = candidate.Id;
      } catch {}
    }
    if (this.id) {
      // Immutable ID returned by our create call; never remove a name discovered elsewhere.
      await this.checked(['rm', '-f', this.id]).catch(() => {});
      this.id = null;
    }
    this.creating = false;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = null;
  }
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
    await this.dispose();
  }
}
