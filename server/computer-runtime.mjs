// SPDX-License-Identifier: MIT
// Commands live in a separate PID/cgroup boundary. Docker's freezer suspends
// their descendants, including double-forked apps, without stopping the viewer.
const none = (value) => !value || Object.keys(value).length === 0;
const fail = (message) => Object.assign(new Error(message), { status: 503 });

export class ComputerRuntime {
  constructor(computer) {
    this.computer = computer;
    this.name = `${computer.name}-commands`;
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async inspect() {
    const p = this.computer;
    const names = await p.checked([
      'container',
      'ls',
      '-a',
      '--filter',
      `name=^/${this.name}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (!names.trim()) return null;
    // Inspect the runtime and its two volumes in one daemon request. Keep all
    // validation below; avoid three separate CLI launches for each job poll.
    const inspected = JSON.parse(
      await p.checked(['inspect', this.name, p.volume, p.displayVolume]),
    );
    if (!Array.isArray(inspected) || inspected.length !== 3)
      throw fail('The command runtime returned incomplete isolation details.');
    const c = inspected[0];
    const h = c.HostConfig || {},
      config = c.Config || {},
      mounts = c.Mounts || [];
    const files = mounts.find((m) => m.Destination === '/workspace');
    const display = mounts.find((m) => m.Destination === '/tmp/.X11-unix');
    const desktopId = config.Labels?.['org.relay.desktop'];
    if (!(
      c.Name === `/${this.name}` &&
      /^sha256:[a-f0-9]{64}$/.test(config.Image || '') &&
      config.Image === c.Image &&
      config.Labels?.['org.relay.owner'] === p.owner &&
      config.Labels?.['org.relay.role'] === 'commands' &&
      /^[a-f0-9]{64}$/.test(desktopId || '') &&
      h.NetworkMode === `container:${desktopId}` &&
      config.User === '1000:1000' &&
      config.WorkingDir === '/workspace' &&
      h.ReadonlyRootfs &&
      !h.Privileged &&
      h.CapDrop?.includes('ALL') &&
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
      none(h.Binds) &&
      none(h.Devices) &&
      none(h.DeviceRequests) &&
      none(h.PortBindings) &&
      !h.PidMode &&
      h.IpcMode === 'private' &&
      h.RestartPolicy?.Name === 'no' &&
      mounts.length === 2 &&
      files?.Type === 'volume' &&
      files.Name === p.volume &&
      files.RW &&
      display?.Type === 'volume' &&
      display.Name === p.displayVolume &&
      !display.RW &&
      Object.keys(h.Tmpfs || {}).length === 1 &&
      h.Tmpfs?.['/tmp'] === 'rw,nosuid,nodev,size=134217728,mode=1777' &&
      JSON.stringify(config.Entrypoint) === '["/usr/bin/tini"]' &&
      JSON.stringify(config.Cmd) === '["--","/bin/sh","/opt/relay/runtime-start.sh"]' &&
      config.Env?.every((v) => /^(PATH|HOME|LANG|DISPLAY)=/.test(v))
    ))
      throw fail('The command runtime’s isolation settings changed. Relay will not attach to it.');
    await p.verifyVolume(p.volume, inspected[1]);
    await p.verifyVolume(p.displayVolume, inspected[2]);
    return c;
  }
  async ensure(desktop) {
    return this.serial(async () => {
      const p = this.computer;
      if (!desktop?.State.Running) throw fail('Start the desktop before running commands.');
      if (!desktop.Mounts?.some((m) => m.Name === p.displayVolume))
        throw fail(
          'Stop and start the computer to apply its runtime update. Your files will stay.',
        );
      let existing = await this.inspect();
      if (
        existing &&
        (existing.Image !== desktop.Image ||
          existing.Config.Labels['org.relay.desktop'] !== desktop.Id ||
          existing.Config.Labels['org.relay.desktop.boot'] !== desktop.State.StartedAt ||
          !existing.State.Running)
      ) {
        await this.remove(existing);
        existing = null;
      }
      if (!existing) {
        await p.checked(
          [
            'run',
            '-d',
            '--name',
            this.name,
            '--label',
            `org.relay.owner=${p.owner}`,
            '--label',
            'org.relay.role=commands',
            '--label',
            `org.relay.desktop=${desktop.Id}`,
            '--label',
            `org.relay.desktop.boot=${desktop.State.StartedAt}`,
            '--network',
            `container:${desktop.Id}`,
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
            '--user',
            '1000:1000',
            '--ipc',
            'private',
            '--tmpfs',
            '/tmp:rw,nosuid,nodev,size=134217728,mode=1777',
            '--mount',
            `type=volume,source=${p.volume},target=/workspace`,
            '--mount',
            `type=volume,source=${p.displayVolume},target=/tmp/.X11-unix,readonly`,
            '--env',
            'HOME=/workspace/.runtime-home',
            '--entrypoint',
            '/usr/bin/tini',
            desktop.Image,
            '--',
            '/bin/sh',
            '/opt/relay/runtime-start.sh',
          ],
          { timeout: 30000 },
        );
      }
      await this.setPaused(p.controller === 'owner');
    });
  }
  async setPaused(paused) {
    const c = await this.inspect();
    if (!c?.State.Running) return;
    if (!!c.State.Paused === paused) return;
    await this.computer.checked([paused ? 'pause' : 'unpause', this.name]);
    const result = await this.inspect();
    if (!result?.State.Running || !!result.State.Paused !== paused)
      throw fail(
        'The command runtime did not confirm its control state. Try again before using the desktop.',
      );
  }
  pause(guard = () => true) {
    return this.serial(() => (guard() ? this.setPaused(true) : undefined));
  }
  resume() {
    return this.serial(() => this.setPaused(false));
  }
  stop() {
    return this.serial(async () => {
      await this.computer.stdio?.stopAll();
      const c = await this.inspect();
      if (c) await this.remove(c);
    });
  }
  async jobStop(runtime, id) {
    // The owner can cancel a job even while its runtime is frozen. The helper
    // shares only that verified PID namespace, with no network or host mounts.
    const output = await this.computer.checked(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '1000:1000',
        '--pids-limit',
        '16',
        '--memory',
        '64m',
        '--memory-swap',
        '64m',
        '--cpus',
        '1',
        '--pid',
        `container:${runtime.Id}`,
        '--workdir',
        '/tmp',
        '--entrypoint',
        '/usr/bin/python3',
        '-i',
        runtime.Image,
        '/opt/relay/jobs.py',
      ],
      { timeout: 30000, input: JSON.stringify({ action: 'stop', id }) },
    );
    const data = JSON.parse(output);
    if (data.error) throw fail(data.error);
    return data.result;
  }
  async remove(c, name = this.name) {
    const p = this.computer;
    if (c.State.Running) {
      if (!c.State.Paused) await p.checked(['pause', name]);
      // Docker's own kill/remove path thaws after signalling only PID 1. Queue
      // SIGKILL for every workload process first, while they cannot fork. This
      // short-lived helper shares only the target PID namespace, has the same
      // unprivileged UID, no capabilities, no mounts and no network. PID 1 is
      // the fixed image's tini; kill(-1) excludes it and the calling helper.
      await p.checked(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          '1000:1000',
          '--pids-limit',
          '16',
          '--memory',
          '64m',
          '--memory-swap',
          '64m',
          '--cpus',
          '1',
          '--pid',
          `container:${c.Id}`,
          '--workdir',
          '/tmp',
          '--entrypoint',
          '/usr/bin/python3',
          c.Image,
          '-c',
          'import os,signal; os.kill(-1, signal.SIGKILL)',
        ],
        { timeout: 30000 },
      );
    }
    await p.checked(['rm', '-f', name]);
  }
}
