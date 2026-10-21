// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerEngine } from './computer-engine.mjs';

const sources = [
  'desktop.Dockerfile',
  'guest.py',
  'accessibility.py',
  'jobs.py',
  'network-bridge.py',
  'desktop-start.sh',
  'runtime-start.sh',
  'desktop-home.html',
  'office-policy.xcd',
];
const failure = (message, code = 'runtime') => Object.assign(new Error(message), { code });
const validImage = (result, fingerprint) => {
  try {
    const config = JSON.parse(result.stdout)[0].Config;
    return (
      !result.exitCode &&
      config.Labels?.['org.relay.computer.source'] === fingerprint &&
      config.User === '1000:1000' &&
      config.WorkingDir === '/workspace' &&
      JSON.stringify(config.Entrypoint) ===
        JSON.stringify(['/usr/bin/tini', '--', '/bin/sh', '/opt/relay/desktop-start.sh'])
    );
  } catch {
    return false;
  }
};
export const localDockerHost = (host) =>
  typeof host === 'string' && /^unix:\/\/\/[^\r\n\0]+$/.test(host);

// Fixed commands only. No caller-provided image, executable, arguments or environment.
// Keep only a bounded diagnostic tail; do not send engine output into chat or the model.
export function setupProcess(binary, args, { signal, cwd, timeout = 15000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env },
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-32000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32000);
    });
    const kill = () => {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    signal?.addEventListener('abort', kill, { once: true });
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    };
    child.once('error', (error) => {
      clear();
      reject(error);
    });
    child.once('close', (code) => {
      clear();
      if (signal?.aborted) return reject(signal.reason);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), timedOut });
    });
  });
}

export class ComputerSetup {
  constructor(
    computer,
    { root, environment = process.env, runner = setupProcess, home = homedir() } = {},
  ) {
    this.computer = computer;
    this.root = root;
    this.runner = runner;
    this.home = home;
    this.explicit = environment.RELAY_DESKTOP_ENABLED;
    this.host = environment.DOCKER_HOST;
    this.context = environment.DOCKER_CONTEXT;
    this.allowed = this.explicit !== 'false';
    this.phase = 'idle';
    this.error = '';
    this.code = '';
    this.engineControl = new ComputerEngine(this);
    computer.db.exec(
      'CREATE TABLE IF NOT EXISTS computer_setup_config (id INTEGER PRIMARY KEY CHECK(id=1), image TEXT NOT NULL, host TEXT NOT NULL)',
    );
    if (this.allowed && this.explicit !== 'true') {
      const saved = computer.db
        .prepare('SELECT image, host FROM computer_setup_config WHERE id=1')
        .get();
      if (
        saved &&
        /^relay-desktop:setup-[a-f0-9]{16}$/.test(saved.image) &&
        localDockerHost(saved.host) &&
        !this.context &&
        (!this.host || this.host === saved.host)
      ) {
        computer.image = saved.image;
        computer.dockerHost = saved.host;
        computer.enabled = true;
      }
    }
  }
  status() {
    return {
      phase: this.computer.enabled ? 'ready' : this.phase,
      available: this.allowed,
      busy: !!this.pending,
      error: this.error,
      code: this.code,
    };
  }
  start() {
    if (!this.allowed)
      throw Object.assign(new Error('Computer setup is disabled by this server’s owner.'), {
        status: 403,
      });
    if (this.installation?.pending)
      throw Object.assign(new Error('Private computer setup is already running.'), { status: 409 });
    if (this.pending || this.computer.enabled) return this.status();
    this.error = this.code = '';
    this.phase = 'checking';
    this.controller = new AbortController();
    this.pending = this.prepare(this.controller.signal)
      .catch((error) => {
        this.phase = this.controller.signal.aborted ? 'cancelled' : 'error';
        this.error = this.controller.signal.aborted
          ? ''
          : ['install', 'remote', 'runtime', 'build', 'image'].includes(error.code)
            ? error.message
            : 'Setup could not finish. Check that the Relay server has free disk space, then try again.';
        this.code = this.controller.signal.aborted ? '' : error.code || 'setup';
      })
      .finally(() => {
        this.pending = null;
      });
    return this.status();
  }
  async cancel() {
    this.controller?.abort(new Error('Setup cancelled.'));
    await this.pending;
    return this.status();
  }
  async engine(signal) {
    const run = (args) =>
      this.runner(this.computer.docker, args, { signal, env: this.computer.dockerEnvironment });
    try {
      const version = await run(['--version']);
      if (version.exitCode) throw new Error('missing');
    } catch (error) {
      signal.throwIfAborted();
      throw failure(
        'Install Docker on the computer running Relay, open it, then try again.',
        'install',
      );
    }
    const candidates = await this.engineHosts(signal);
    for (const host of candidates) {
      const result = await run(['--host', host, 'info', '--format', '{{.OSType}}']);
      if (!result.exitCode && result.stdout.trim() === 'linux') return host;
    }
    throw failure(
      'Open Docker or start Colima on the computer running Relay, then try again.',
      'runtime',
    );
  }
  async engineHosts(signal) {
    const run = (args) =>
      this.runner(this.computer.docker, args, { signal, env: this.computer.dockerEnvironment });
    // A configured workspace stays on its original engine even when it is offline.
    if (this.computer.enabled && this.computer.dockerHost) {
      if (!localDockerHost(this.computer.dockerHost))
        throw failure('This computer uses an externally managed runtime.', 'remote');
      return [this.computer.dockerHost];
    }
    // An explicitly selected remote engine must never silently become a local one.
    const candidates = [];
    if (this.context) {
      const result = await run(['context', 'inspect', this.context]);
      try {
        candidates.push(JSON.parse(result.stdout)[0].Endpoints.docker.Host);
      } catch {
        /* handled below */
      }
    } else if (this.host) candidates.push(this.host);
    else {
      if (!this.computer.enabled)
        candidates.push(`unix://${join(this.home, '.colima/relay/docker.sock')}`);
      const result = await run(['context', 'inspect']);
      try {
        candidates.push(JSON.parse(result.stdout)[0].Endpoints.docker.Host);
      } catch {
        /* check known local sockets */
      }
      if (!this.computer.enabled)
        candidates.push(
          `unix://${join(this.home, '.docker/run/docker.sock')}`,
          'unix:///var/run/docker.sock',
        );
    }
    if ((this.host || this.context) && !localDockerHost(candidates[0]))
      throw failure(
        'This server uses a remote container engine. Ask its owner to configure the computer on that server.',
        'remote',
      );
    return [...new Set(candidates)].filter(localDockerHost);
  }
  async prepare(signal, { activate = true, host: chosenHost } = {}) {
    const host = chosenHost || (await this.engine(signal));
    signal.throwIfAborted();
    this.phase = 'preparing';
    const files = await Promise.all(
      sources.map(async (name) => [name, await readFile(join(this.root, 'docker', name))]),
    );
    const hash = createHash('sha256').update('relay-setup-v1;file-mode=0644\0');
    for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes);
    const fingerprint = hash.digest('hex');
    const image = `relay-desktop:setup-${fingerprint.slice(0, 16)}`;
    const run = (args, options = {}) =>
      this.runner(this.computer.docker, ['--host', host, ...args], {
        signal,
        env: this.computer.dockerEnvironment,
        ...options,
      });
    let directory;
    try {
      const existing = await run(['image', 'inspect', image]);
      const valid = validImage(existing, fingerprint);
      if (!valid || existing.exitCode) {
        directory = await mkdtemp(join(tmpdir(), 'relay-computer-build-'));
        await mkdir(join(directory, 'docker'));
        for (const [name, bytes] of files)
          await writeFile(join(directory, 'docker', name), bytes, { mode: 0o644 });
        signal.throwIfAborted();
        const build = await run(
          [
            'build',
            '--label',
            `org.relay.computer.source=${fingerprint}`,
            '-f',
            'docker/desktop.Dockerfile',
            '-t',
            image,
            '.',
          ],
          { cwd: directory, timeout: 20 * 60000 },
        );
        if (build.exitCode)
          throw failure(
            build.timedOut
              ? 'Setup took too long. Check your connection and try again; downloaded layers can be reused.'
              : 'The workspace could not be prepared. Check that Docker is running, has free disk space and can reach the internet, then try again.',
            'build',
          );
      }
      this.phase = 'finishing';
      const result = await run(['image', 'inspect', image]);
      if (!validImage(result, fingerprint))
        throw failure('The workspace did not pass its setup check. Try again.', 'image');
      const probe = `relay-setup-check-${randomBytes(12).toString('hex')}`;
      try {
        const smoke = await run(
          [
            'run',
            '--rm',
            '--name',
            probe,
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '32',
            '--memory',
            '256m',
            '--memory-swap',
            '256m',
            '--cpus',
            '1',
            '--user',
            '1000:1000',
            '--entrypoint',
            '/usr/bin/python3',
            image,
            '-c',
            'import pathlib, shutil, tkinter, PIL, docx, uno, pyatspi; ' +
              '[(pathlib.Path("/opt/relay") / n).read_bytes() for n in ' +
              JSON.stringify(
                sources.filter(
                  (name) => !['desktop.Dockerfile', 'office-policy.xcd'].includes(name),
                ),
              ) +
              ']; ' +
              'pathlib.Path("/etc/libreoffice/registry/relay.xcd").read_bytes(); ' +
              'assert all(shutil.which(n) for n in ["Xvfb", "chromium", "xterm", "mousepad", "node", "git", "libreoffice", "pdftotext", "dbus-daemon"])',
          ],
          { timeout: 30000 },
        );
        if (smoke.exitCode)
          throw failure(
            'The workspace did not pass its runtime check. Check Docker’s available memory and disk space, then try again.',
            'image',
          );
      } finally {
        // Cancelling the client must not leave its disposable validation container running.
        await this.runner(this.computer.docker, ['--host', host, 'rm', '-f', probe], {
          timeout: 10000,
          env: this.computer.dockerEnvironment,
        }).catch(() => {});
      }
      signal.throwIfAborted();
      if (!activate) return { image, host };
      this.computer.db
        .prepare('INSERT OR REPLACE INTO computer_setup_config VALUES (1,?,?)')
        .run(image, host);
      this.computer.image = image;
      this.computer.dockerHost = host;
      this.computer.enabled = true;
      this.phase = 'ready';
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
