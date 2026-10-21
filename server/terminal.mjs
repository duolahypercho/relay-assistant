// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
export function boundedProcess(
  binary,
  args,
  { timeout = 30000, maxOutput = 128000, input, env = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    function collect(which, chunk) {
      bytes += chunk.length;
      if (bytes > maxOutput) {
        child.kill('SIGKILL');
        stderr += '\nOutput limit reached.';
        return;
      }
      if (which === 'out') stdout += chunk.toString();
      else stderr += chunk.toString();
    }
    child.stdout.on('data', (c) => collect('out', c));
    child.stderr.on('data', (c) => collect('err', c));
    // A guest can stop while a file is being copied. The child exit/result handles
    // a closed pipe; it must not become an unhandled error that kills Relay.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(error);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), timedOut });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
export class IsolatedTerminal {
  constructor({
    enabled = false,
    image = 'relay-workspace:local',
    deployment = 'local',
    runner = boundedProcess,
  } = {}) {
    this.enabled = enabled;
    this.image = image;
    this.name = `relay-${createHash('sha256').update(deployment).digest('hex').slice(0, 12)}`;
    this.volume = `${this.name}-files`;
    this.runner = runner;
  }
  async ensure() {
    if (!this.enabled)
      throw new Error(
        'Enable RELAY_COMPUTER_ENABLED and build the workspace image to run commands.',
      );
    const status = await this.runner('docker', ['inspect', this.name]);
    if (status.exitCode === 0) {
      let existing;
      try {
        existing = JSON.parse(status.stdout)[0];
      } catch {
        throw new Error('Could not inspect the existing workspace.');
      }
      const h = existing.HostConfig,
        c = existing.Config;
      const mounts = existing.Mounts || [];
      if (
        !h ||
        !c ||
        h.Privileged ||
        h.NetworkMode !== 'none' ||
        !h.ReadonlyRootfs ||
        c.User !== '1000:1000' ||
        c.Image !== this.image ||
        !h.CapDrop?.includes('ALL') ||
        !h.SecurityOpt?.some((x) => x.startsWith('no-new-privileges')) ||
        h.PidsLimit < 1 ||
        h.PidsLimit > 96 ||
        h.Memory < 1 ||
        h.Memory > 512 * 1024 * 1024 ||
        h.NanoCpus < 1 ||
        h.NanoCpus > 1e9 ||
        mounts.some((m) => m.Type === 'bind') ||
        !mounts.some(
          (m) => m.Type === 'volume' && m.Name === this.volume && m.Destination === '/workspace',
        ) ||
        mounts.some((m) => m.Destination !== '/workspace' && m.Type !== 'tmpfs')
      )
        throw new Error(
          'The existing workspace does not match the required isolation settings. Remove that container and recreate it; its named volume can be kept.',
        );
      if (existing.State.Running) return;
      const r = await this.runner('docker', ['start', this.name]);
      if (r.exitCode) throw new Error(r.stderr);
      return;
    }
    const r = await this.runner('docker', [
      'run',
      '-d',
      '--name',
      this.name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '96',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--user',
      '1000:1000',
      '--tmpfs',
      '/tmp:rw,nosuid,size=64m',
      '--mount',
      `type=volume,source=${this.volume},target=/workspace`,
      this.image,
      'sleep',
      'infinity',
    ]);
    if (r.exitCode) throw new Error(r.stderr || 'Could not start the isolated workspace.');
  }
  async run(command) {
    if (typeof command !== 'string' || !command.trim() || command.length > 2000)
      throw new Error('Use a workspace command of at most 2,000 characters.');
    await this.ensure();
    const r = await this.runner(
      'docker',
      [
        'exec',
        '--workdir',
        '/workspace',
        this.name,
        'timeout',
        '--signal=KILL',
        '30',
        'sh',
        '-lc',
        command,
      ],
      { timeout: 35000 },
    );
    return { ...r, command, detail: `Workspace command exited with code ${r.exitCode}.` };
  }
  async stop() {
    if (this.enabled) await this.runner('docker', ['stop', this.name], { timeout: 12000 });
  }
}
