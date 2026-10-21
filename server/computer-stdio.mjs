// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

// Configuration arrives over the attached private stdin, never Docker argv/env,
// container metadata or a workspace file. Read exactly through the first newline
// so exec leaves subsequent MCP protocol bytes intact for the configured program.
const bootstrap = `import os,json
data=bytearray()
while len(data)<=64000:
 b=os.read(0,1)
 if not b: raise SystemExit(1)
 if b==b'\\n': break
 data.extend(b)
else: raise SystemExit(1)
p=json.loads(data); folder=os.path.realpath(p['cwd'])
if folder!='/workspace' and not folder.startswith('/workspace/'): raise SystemExit(1)
os.chdir(folder)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/workspace/.tool-home','LANG':'C.UTF-8'}
env.update(p['env'])
os.execvpe(p['command'],[p['command']]+p['args'],env)
`;
const entrypoint = ['/usr/bin/tini'];
const command = [
  '--',
  '/usr/bin/timeout',
  '--signal=KILL',
  '90',
  '/usr/bin/python3',
  '-u',
  '-c',
  bootstrap,
];
const empty = (value) => !value || Object.keys(value).length === 0;
const failure = () =>
  Error(
    'The local tool computer could not be verified or stopped. Check the computer before continuing.',
  );

export class ComputerStdio {
  constructor(computer) {
    this.computer = computer;
    this.active = new Map();
    computer.db.exec(
      'CREATE TABLE IF NOT EXISTS computer_stdio (name TEXT PRIMARY KEY, image TEXT NOT NULL, volume TEXT NOT NULL)',
    );
  }
  rows() {
    return this.computer.db.prepare('SELECT * FROM computer_stdio').all();
  }
  async inspect(row) {
    const p = this.computer;
    if (!new RegExp(`^${p.name}-tool-[a-f0-9]{24}$`).test(row.name)) throw failure();
    if (
      !(
        await p.checked([
          'container',
          'ls',
          '-a',
          '--filter',
          `name=^/${row.name}$`,
          '--format',
          '{{.Names}}',
        ])
      ).trim()
    )
      return null;
    const c = JSON.parse(await p.checked(['inspect', row.name]))[0];
    const h = c.HostConfig || {},
      cfg = c.Config || {},
      mounts = c.Mounts || [];
    if (!(
      c.Name === `/${row.name}` &&
      cfg.Image === row.image &&
      c.Image === row.image &&
      cfg.Labels?.['org.relay.owner'] === p.owner &&
      cfg.Labels?.['org.relay.role'] === 'local-tool' &&
      cfg.User === '1000:1000' &&
      cfg.WorkingDir === '/workspace' &&
      h.NetworkMode === 'none' &&
      h.ReadonlyRootfs &&
      !h.Privileged &&
      h.CapDrop?.includes('ALL') &&
      empty(h.CapAdd) &&
      h.SecurityOpt?.length === 1 &&
      h.SecurityOpt[0].startsWith('no-new-privileges') &&
      h.PidsLimit === 64 &&
      h.Memory === 536870912 &&
      h.MemorySwap === h.Memory &&
      h.NanoCpus === 1e9 &&
      empty(h.Binds) &&
      empty(h.Devices) &&
      empty(h.DeviceRequests) &&
      empty(h.PortBindings) &&
      !h.PidMode &&
      h.IpcMode === 'private' &&
      h.RestartPolicy?.Name === 'no' &&
      h.LogConfig?.Type === 'none' &&
      mounts.length === 1 &&
      mounts[0].Type === 'volume' &&
      mounts[0].Name === row.volume &&
      mounts[0].Destination === '/workspace' &&
      mounts[0].RW &&
      Object.keys(h.Tmpfs || {}).length === 1 &&
      h.Tmpfs['/tmp'] === 'rw,nosuid,nodev,size=67108864,mode=1777' &&
      JSON.stringify(cfg.Entrypoint) === JSON.stringify(entrypoint) &&
      JSON.stringify(cfg.Cmd) === JSON.stringify(command) &&
      cfg.Env?.every((v) => /^(PATH|HOME|LANG|DISPLAY)=/.test(v))
    ))
      throw failure();
    await p.verifyVolume(row.volume);
    return c;
  }
  async remove(row) {
    const c = await this.inspect(row);
    if (c) await this.computer.runtime.remove(c, c.Id);
    this.computer.db.prepare('DELETE FROM computer_stdio WHERE name=?').run(row.name);
  }
  async recover() {
    for (const row of this.rows()) if (!this.active.has(row.name)) await this.remove(row);
  }
  async stopAll() {
    await Promise.all([...this.active.values()].map((t) => t.close()));
    await this.recover();
  }
  transport(launch) {
    if (this.active.size >= 4)
      throw Error('Four local tool sessions are already active. Wait for one to finish.');
    const transport = new WorkspaceTransport(this, launch);
    this.active.set(transport.name, transport);
    return transport;
  }
}

class WorkspaceTransport {
  constructor(manager, launch) {
    this.manager = manager;
    this.computer = manager.computer;
    this.launch = launch;
    this.name = `${this.computer.name}-tool-${randomBytes(12).toString('hex')}`;
    this.epoch = this.computer.epoch;
    this.buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });
    this.bytes = 0;
    this.closed = false;
  }
  guard() {
    if (this.closed) throw Error('The local tool session ended.');
    this.computer.assertAvailable();
    this.computer.assertControl('agent', this.epoch);
  }
  async start() {
    const p = this.computer;
    if (this.creation) throw Error('This local tool session already started.');
    this.creation = p.serial(async () => {
      this.guard();
      await this.manager.recover();
      this.guard();
      const desktop = await p.requireRunning();
      this.guard();
      this.row = { name: this.name, image: desktop.Image, volume: p.volume };
      p.db
        .prepare('INSERT INTO computer_stdio VALUES (?,?,?)')
        .run(this.name, desktop.Image, p.volume);
      await p.checked(
        [
          'create',
          '--name',
          this.name,
          '--label',
          `org.relay.owner=${p.owner}`,
          '--label',
          'org.relay.role=local-tool',
          '--network',
          'none',
          '--log-driver',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '64',
          '--memory',
          '512m',
          '--memory-swap',
          '512m',
          '--cpus',
          '1',
          '--user',
          '1000:1000',
          '--ipc',
          'private',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
          '--mount',
          `type=volume,source=${p.volume},target=/workspace`,
          '--workdir',
          '/workspace',
          '--entrypoint',
          '/usr/bin/tini',
          '-i',
          desktop.Image,
          ...command,
        ],
        { timeout: 30000 },
      );
      this.container = await this.manager.inspect(this.row);
      this.guard();
      if (!this.container) throw failure();
    });
    try {
      await this.creation;
      this.guard();
      const args = ['start', '--attach', '--interactive', this.container.Id];
      const child = (this.child = spawn(
        p.docker,
        p.dockerHost ? ['--host', p.dockerHost, ...args] : args,
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...p.dockerEnvironment,
            DOCKER_HOST: p.dockerHost ? '' : process.env.DOCKER_HOST,
            DOCKER_CONTEXT: p.dockerHost ? '' : process.env.DOCKER_CONTEXT,
          },
        },
      ));
      child.stdout.on('data', (chunk) => {
        if (this.closed) return;
        try {
          this.bytes += chunk.length;
          if (this.bytes > 8 * 1024 * 1024) throw Error('Local tool output exceeded its limit.');
          this.buffer.append(chunk);
          let message;
          while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
        } catch {
          this.onerror?.(Error('The local tool returned invalid or oversized output.'));
          void this.close().catch(() => {});
        }
      });
      let stderr = 0;
      child.stderr.on('data', (chunk) => {
        stderr += chunk.length;
        if (stderr > 256000) {
          this.onerror?.(Error('Local tool diagnostics exceeded their limit.'));
          void this.close().catch(() => {});
        }
      });
      child.stdin.on('error', () => this.onerror?.(Error('The local tool input closed.')));
      child.on('error', () => this.onerror?.(Error('The local tool could not start.')));
      child.on('close', () => this.onclose?.());
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () =>
          child.stdin.write(JSON.stringify(this.launch) + '\n', (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async send(message) {
    this.guard();
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > 128000) throw Error('This local tool request is too large.');
    await new Promise((resolve, reject) =>
      this.child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
    );
  }
  close() {
    this.closed = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.creation?.catch(() => {});
      if (this.row) await this.manager.remove(this.row);
      this.child?.stdin.destroy();
      this.child?.kill('SIGKILL');
      this.buffer.clear();
      this.manager.active.delete(this.name);
      this.onclose?.();
    })().catch((error) => {
      this.closing = null;
      throw error;
    });
    return this.closing;
  }
}
