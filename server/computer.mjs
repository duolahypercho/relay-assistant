// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { boundedProcess } from './terminal.mjs';
import { ComputerNetwork, website } from './computer-network.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerRuntime } from './computer-runtime.mjs';
import { ComputerJobs } from './computer-jobs.mjs';
import { ComputerStdio } from './computer-stdio.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const fail = (text, status = 409) => Object.assign(new Error(text), { status });

// No HTTP/VNC port is published by the guest. Only the authenticated Relay server
// can send a bounded JSON request through docker exec's stdin.
export class PrivateComputer {
  constructor(
    store,
    {
      enabled = false,
      image = 'relay-desktop:local',
      deployment = 'local',
      runner = boundedProcess,
      docker,
      dockerHost,
      remoteEngine,
      web = false,
      networkOptions,
    } = {},
  ) {
    this.store = store;
    this.enabled = enabled;
    this.image = image;
    this.owner = digest(deployment).slice(0, 16);
    this.name = `relay-desktop-${this.owner}`;
    store.db.exec(`CREATE TABLE IF NOT EXISTS computer_workspace (
      id INTEGER PRIMARY KEY CHECK(id=1), volume TEXT NOT NULL);`);
    const hadPresence = store.db
      .prepare('PRAGMA table_info(computer_workspace)')
      .all()
      .some((column) => column.name === 'initialized');
    if (!hadPresence)
      store.db.exec(
        'ALTER TABLE computer_workspace ADD COLUMN initialized INTEGER NOT NULL DEFAULT 0',
      );
    store.db
      .prepare('INSERT OR IGNORE INTO computer_workspace (id,volume) VALUES (1,?)')
      .run(`${this.name}-files`);
    this.volume = store.db.prepare('SELECT volume FROM computer_workspace WHERE id=1').get().volume;
    if (remoteEngine && !this.volume.startsWith(this.name + '-')) {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'computer_*'")
        .all();
      const unused = tables.every(({ name }) => {
        if (name === 'computer_workspace')
          return !store.db.prepare('SELECT initialized FROM computer_workspace WHERE id=1').get()
            ?.initialized;
        if (name === 'computer_meta')
          return !store.db.prepare("SELECT 1 FROM computer_meta WHERE controller!='agent'").get();
        if (name === 'computer_web_revision')
          return !store.db.prepare('SELECT 1 FROM computer_web_revision WHERE value!=0').get();
        return !store.db
          .prepare('SELECT 1 FROM "' + name.replaceAll('"', '""') + '" LIMIT 1')
          .get();
      });
      if (!unused)
        throw fail(
          'This workspace already has computer history. Keep its original computer or use a separate Relay data directory for the remote connection.',
        );
      this.volume = `${this.name}-files`;
      store.db.prepare('UPDATE computer_workspace SET volume=? WHERE id=1').run(this.volume);
    }
    if (!new RegExp(`^${this.name}-(files|restore-[a-f0-9]{32})$`).test(this.volume))
      throw fail('The saved computer workspace does not belong to this deployment.');
    this.displayVolume = `${this.name}-display`;
    this.runner = runner;
    this.docker =
      docker || ['/opt/homebrew/bin/docker', '/usr/local/bin/docker'].find(existsSync) || 'docker';
    this.dockerHost = dockerHost;
    this.remoteEngine = remoteEngine;
    if (remoteEngine) this.dockerEnvironment = remoteEngine.environment;
    this.queue = Promise.resolve();
    this.epoch = 0;
    this.transitioning = 0;
    this.db = store.db;
    this.runtime = new ComputerRuntime(this);
    this.jobs = new ComputerJobs(this);
    this.network = web ? new ComputerNetwork(this, networkOptions) : null;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS computer_meta (id INTEGER PRIMARY KEY CHECK(id=1), controller TEXT NOT NULL);
      INSERT OR IGNORE INTO computer_meta VALUES (1,'agent');
      CREATE TABLE IF NOT EXISTS computer_operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created TEXT NOT NULL);`);
    // Old databases can prove prior use through completed work or a restored volume.
    // Otherwise the first verified observation establishes presence; failed setup alone does not.
    if (
      !hadPresence &&
      (this.volume.includes('-restore-') ||
        this.db.prepare("SELECT 1 FROM computer_operations WHERE status='completed' LIMIT 1").get())
    )
      this.db.prepare('UPDATE computer_workspace SET initialized=1 WHERE id=1').run();
    this.db
      .prepare(
        "UPDATE computer_operations SET status='interrupted', result=? WHERE status='running'",
      )
      .run(
        JSON.stringify({
          error:
            'The server restarted before this action was confirmed. Inspect the workspace before trying again.',
        }),
      );
  }
  get stdio() {
    return (this.stdioService ||= new ComputerStdio(this));
  }
  get controller() {
    return this.db.prepare('SELECT controller FROM computer_meta WHERE id=1').get().controller;
  }
  async waitForAgent(signal) {
    signal?.throwIfAborted();
    while (this.enabled && this.controller === 'owner') {
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async dockerRun(args, options = {}) {
    try {
      return await this.runner(
        this.docker,
        this.dockerHost ? ['--host', this.dockerHost, ...args] : args,
        {
          timeout: 12000,
          ...options,
          env: {
            ...options.env,
            ...this.dockerEnvironment,
            ...(this.dockerHost ? { DOCKER_CONTEXT: '', DOCKER_HOST: '' } : {}),
          },
        },
      );
    } catch (error) {
      if (error.code === 'ENOENT')
        throw fail('Install Docker or Colima on the Relay server to start its computer.', 503);
      throw error;
    }
  }
  async checked(args, options) {
    const r = await this.dockerRun(args, options);
    if (r.exitCode || r.timedOut)
      throw fail(
        r.stderr?.slice(0, 400) ||
          'The computer runtime did not respond. Check that Docker is running.',
        503,
      );
    return r.stdout;
  }
  async inspect() {
    if (!this.enabled) throw fail('The private computer is not enabled on this server.', 503);
    const names = await this.checked([
      'container',
      'ls',
      '-a',
      '--filter',
      `name=^/${this.name}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (!names.trim()) return null;
    const c = JSON.parse(await this.checked(['inspect', this.name]))[0];
    const h = c.HostConfig || {},
      config = c.Config || {};
    const mounts = c.Mounts || [];
    const none = (value) => !value || Object.keys(value).length === 0;
    const safe =
      c.Name === `/${this.name}` &&
      config.Image === this.image &&
      config.Labels?.['org.relay.owner'] === this.owner &&
      config.User === '1000:1000' &&
      config.WorkingDir === '/workspace' &&
      h.NetworkMode === 'none' &&
      h.ReadonlyRootfs &&
      !h.Privileged &&
      h.CapDrop?.includes('ALL') &&
      none(h.CapAdd) &&
      h.SecurityOpt?.length === 1 &&
      h.SecurityOpt[0].startsWith('no-new-privileges') &&
      h.PidsLimit > 0 &&
      h.PidsLimit <= 256 &&
      h.Memory > 0 &&
      h.Memory <= 2147483648 &&
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
      // A verified legacy desktop may be stopped and replaced with its files
      // intact. New command execution requires the separate display volume.
      [1, 2].includes(mounts.length) &&
      (mounts.length === 1 ||
        mounts.some(
          (m) =>
            m.Type === 'volume' &&
            m.Name === this.displayVolume &&
            m.Destination === '/tmp/.X11-unix' &&
            m.RW,
        )) &&
      mounts.some(
        (m) =>
          m.Type === 'volume' && m.Name === this.volume && m.Destination === '/workspace' && m.RW,
      ) &&
      mounts.every(
        (m) =>
          m.Name === this.volume ||
          (m.Type === 'volume' &&
            m.Name === this.displayVolume &&
            m.Destination === '/tmp/.X11-unix' &&
            m.RW),
      ) &&
      Object.keys(h.Tmpfs || {}).length === 1 &&
      h.Tmpfs?.['/tmp'] === 'rw,nosuid,nodev,size=268435456,mode=1777' &&
      JSON.stringify(config.Entrypoint) ===
        '["/usr/bin/tini","--","/bin/sh","/opt/relay/desktop-start.sh"]' &&
      none(config.Cmd) &&
      config.Env?.every((v) => /^(PATH|HOME|LANG|DISPLAY)=/.test(v));
    if (!safe)
      throw fail('This computer’s isolation settings changed. Relay will not attach to it.');
    await this.verifyVolume();
    if (mounts.length === 2) await this.verifyVolume(this.displayVolume);
    return c;
  }
  async verifyVolume(name = this.volume, inspected) {
    const v = inspected || JSON.parse(await this.checked(['volume', 'inspect', name]))[0];
    if (
      v.Name !== name ||
      v.Driver !== 'local' ||
      v.Scope !== 'local' ||
      Object.keys(v.Options || {}).length ||
      v.Labels?.['org.relay.owner'] !== this.owner
    )
      throw fail('This workspace volume does not belong to this Relay deployment.');
    if (name === this.volume)
      this.db
        .prepare(
          'UPDATE computer_workspace SET initialized=1 WHERE id=1 AND initialized=0 AND volume=?',
        )
        .run(name);
  }
  get workspaceInitialized() {
    return !!this.db.prepare('SELECT initialized FROM computer_workspace WHERE id=1').get()
      ?.initialized;
  }
  async workspaceExists() {
    // A successful listing distinguishes missing saved storage from an unreachable engine.
    const names = await this.checked([
      'volume',
      'ls',
      '--filter',
      `name=^${this.volume}$`,
      '--format',
      '{{.Name}}',
    ]);
    if (names.trim() !== this.volume) return false;
    await this.verifyVolume();
    return true;
  }
  missingWorkspaceError() {
    return fail(
      'Your saved computer workspace could not be found on this engine. Open Computer to restore a backup or choose a new empty workspace.',
    );
  }
  async status() {
    const common = {
      enabled: this.enabled,
      controller: this.controller,
      managedEngine: !!this.engineControl?.setup.installation?.selected,
      powerError:
        this.engineControl?.intent === 'stop' && this.engineControl.setup.installation?.selected
          ? this.engineControl.error
          : '',
      active: this.active?.label || '',
      network: this.network?.sites().some((s) => s.status === 'allowed')
        ? 'approved-sites'
        : 'offline',
      web: this.network?.status() || { enabled: false, sites: [] },
      width: 1280,
      height: 800,
    };
    if (!this.enabled) return { ...common, state: 'disabled' };
    if (this.engineStopping) return { ...common, state: 'stopping' };
    if (this.maintenance) return { ...common, state: 'updating' };
    if (this.snapshotBlocked)
      return {
        ...common,
        state: 'unavailable',
        snapshotBlocked: true,
        error: 'Finish the interrupted restore-point operation before using the computer.',
      };
    if (this.transitioning) return { ...common, state: 'switching' };
    try {
      const c = await this.inspect();
      if (!c && this.workspaceInitialized && !(await this.workspaceExists()))
        return {
          ...common,
          state: 'missing',
          workspaceMissing: true,
          error: this.missingWorkspaceError().message,
        };
      if (c?.State.Running && c.Mounts?.length === 1)
        return {
          ...common,
          state: 'unavailable',
          needsUpdate: true,
          error:
            'A computer update is ready. Stop and start it to enable isolated commands. Your workspace files will stay.',
        };
      // On service recovery reconcile the kernel boundary before allowing
      // owner input. A failed freeze makes the viewer unavailable, not usable.
      if (this.controller === 'owner') {
        await this.stdio.stopAll();
        await this.runtime.pause(
          // A status poll can wait behind handback. Recheck inside the runtime
          // queue so that an earlier owner observation never freezes new agent work.
          () =>
            this.controller === 'owner' &&
            !this.transitioning &&
            !this.maintenance &&
            !this.closing,
        );
      }
      if (c?.State.Running && (await this.isReady(c)) && this.network && !this.closing) {
        await this.network.start().catch(() => {});
        common.web = this.network.status();
      }
      return {
        ...common,
        state: !c?.State.Running ? 'stopped' : (await this.isReady(c)) ? 'running' : 'starting',
        apps: c?.State.Running ? this.desktopApps || [] : [],
      };
    } catch (error) {
      return { ...common, state: 'unavailable', error: error.message };
    }
  }
  async isReady(c) {
    const boot = `${c.Id}:${c.State.StartedAt}`;
    if (this.readyBoot === boot) return true;
    const health = await this.rpc({ kind: 'health' });
    if (!health.ready) return false;
    this.desktopApps = Array.isArray(health.apps) ? health.apps : [];
    this.readyBoot = boot;
    return true;
  }
  assertControl(actor, epoch) {
    this.assertAvailable();
    if (this.closing) throw fail('Relay is restarting. Wait for it to reconnect.');
    if (epoch !== undefined && epoch !== this.epoch)
      throw fail('Computer control changed. Inspect the screen before continuing.');
    if (actor === 'agent' && this.controller !== 'agent')
      throw fail(
        'The owner has taken control. Stop computer actions and wait until they give it back.',
      );
    if (actor === 'owner' && this.controller !== 'owner')
      throw fail('Take control before changing the computer.');
    if (actor === 'owner' && (this.stdio.active.size || this.stdio.rows().length))
      throw fail('Local app tools are still stopping. Retry taking control before continuing.');
  }
  assertAvailable() {
    if (this.engineStopping) throw fail('Wait for your computer to finish stopping.');
    if (this.closing) throw fail('Relay is restarting. Wait for it to reconnect.');
    if (this.snapshotBlocked)
      throw fail('Finish the interrupted restore-point operation before using the computer.');
    if (this.maintenance) throw fail('The computer is being refreshed. Wait for it to finish.');
  }
  async start(actor = 'agent') {
    this.assertAvailable();
    return this.serial(async () => {
      this.assertAvailable();
      return this.startUnlocked(actor);
    });
  }
  async startUnlocked(actor = 'agent') {
    if (actor === 'agent') this.assertControl(actor);
    let existing = await this.inspect();
    if (!existing && this.workspaceInitialized && !(await this.workspaceExists()))
      throw this.missingWorkspaceError();
    const desiredImage = (
      await this.checked(['image', 'inspect', this.image, '--format', '{{.Id}}'])
    ).trim();
    if (existing && existing.Image !== desiredImage) {
      if (existing.State.Running)
        throw fail(
          'A computer update is ready. Stop the computer, then start it to apply the update. Your workspace files will stay.',
        );
      this.network?.stop();
      await this.runtime.stop();
      await this.checked(['rm', this.name]);
      existing = null;
    }
    if (existing) {
      if (!existing.State.Running) await this.checked(['start', this.name], { timeout: 30000 });
    } else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/.test(this.image))
        throw fail('Invalid computer image.');
      for (const name of [this.volume, this.displayVolume]) {
        const names = await this.checked([
          'volume',
          'ls',
          '--filter',
          `name=^${name}$`,
          '--format',
          '{{.Name}}',
        ]);
        if (names.trim() !== name) {
          if (name === this.volume && this.workspaceInitialized) throw this.missingWorkspaceError();
          await this.checked([
            'volume',
            'create',
            '--label',
            `org.relay.owner=${this.owner}`,
            name,
          ]);
        }
        await this.verifyVolume(name);
      }
      await this.checked(
        [
          'run',
          '-d',
          '--name',
          this.name,
          '--label',
          `org.relay.owner=${this.owner}`,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '256',
          '--memory',
          '2g',
          '--memory-swap',
          '2g',
          '--cpus',
          '2',
          '--user',
          '1000:1000',
          '--ipc',
          'private',
          '--shm-size',
          '256m',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
          '--mount',
          `type=volume,source=${this.volume},target=/workspace`,
          '--mount',
          `type=volume,source=${this.displayVolume},target=/tmp/.X11-unix`,
          this.image,
        ],
        { timeout: 30000 },
      );
    }
    for (let n = 0; n < 35; n++) {
      try {
        const health = await this.rpc({ kind: 'health' });
        if (!health.ready) throw new Error('The desktop is still starting. Try again in a moment.');
        break;
      } catch (error) {
        if (n === 34) {
          await this.dockerRun(['stop', '-t', '2', this.name]).catch(() => {});
          throw fail(
            'The desktop did not finish starting. Its files are safe. Try starting it again.',
            503,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await this.runtime.ensure(await this.inspect());
    return await this.status();
  }
  async requireRunning() {
    this.assertAvailable();
    if (this.closing) throw fail('Relay is restarting. Wait for it to reconnect.');
    if (this.transitioning) throw fail('Computer control is switching. Wait for it to finish.');
    const c = await this.inspect();
    if (!c?.State.Running) throw fail('Start the computer first. Its saved files are still there.');
    if (c.Mounts?.length === 1)
      throw fail(
        'Stop and start the computer to enable isolated commands. Your workspace files will stay.',
      );
    if (!(await this.isReady(c)))
      throw fail('The desktop is still starting. Wait for Ready before continuing.');
    return c;
  }
  async rebuild(image, commit = () => {}) {
    this.assertAvailable();
    if (!this.enabled) throw fail('Set up the computer first.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/.test(image)) throw fail('Invalid computer image.');
    this.maintenance = true;
    this.epoch++;
    this.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    this.network?.stop();
    const previousImage = this.image;
    try {
      // All new input is blocked now; older observations fail their epoch check.
      await this.cancel().catch(() => {});
      await this.serial(async () => {
        const existing = await this.inspect();
        await this.checked(['image', 'inspect', image]);
        // Inspect both boundaries before removing anything; an unexpected
        // container or host mount must never be "fixed" by deleting it.
        await this.runtime.inspect();
        await this.runtime.stop();
        this.jobs.stopped();
        if (existing?.State.Running) await this.checked(['stop', '--time', '3', this.name]);
        if (existing) await this.checked(['rm', this.name]);
        this.readyBoot = null;
        // A crash before this commit recreates the previous image; after it,
        // the durable configuration recreates the prepared image. Files stay
        // in the same owned volume throughout. No automatic model handback.
        commit(image);
        this.image = image;
        try {
          await this.startUnlocked('owner');
        } catch (error) {
          if (image === previousImage) throw error;
          const replacement = await this.inspect();
          await this.runtime.stop();
          if (replacement?.State.Running) await this.checked(['stop', '--time', '3', this.name]);
          if (replacement) await this.checked(['rm', this.name]);
          commit(previousImage);
          this.image = previousImage;
          this.readyBoot = null;
          await this.startUnlocked('owner');
          throw fail(
            'The update could not start. Your previous computer software is restored, with saved files kept.',
          );
        }
      });
    } finally {
      this.maintenance = false;
    }
    return this.status();
  }
  async rpc(payload, target = this.name) {
    const r = await this.dockerRun(['exec', '-i', target, 'python3', '/opt/relay/guest.py'], {
      input: JSON.stringify(payload),
      timeout: payload.kind === 'exec' ? 70000 : payload.kind === 'jobs' ? 30000 : 15000,
      maxOutput: 12_000_000,
    });
    let data;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      throw fail(
        'The computer stopped responding. Inspect its status before repeating an action.',
        503,
      );
    }
    if (data.error || r.exitCode) throw fail(data.error || r.stderr || 'Computer action failed.');
    return data.result;
  }
  async screenshot({ controls = false } = {}) {
    const state = await this.status();
    if (state.state !== 'running') return state;
    return {
      ...state,
      ...(await this.rpc({
        kind: 'desktop',
        action: 'screenshot',
        ...(controls ? { controls: true } : {}),
      })),
    };
  }
  async copyClipboard(action, { signal } = {}) {
    if (!['copy', 'cut'].includes(action)) throw fail('Choose Copy or Cut.', 400);
    const epoch = this.epoch;
    this.assertControl('owner', epoch);
    return this.serial(async () => {
      signal?.throwIfAborted();
      this.assertControl('owner', epoch);
      await this.requireRunning();
      await this.runtime.pause();
      signal?.throwIfAborted();
      this.assertControl('owner', epoch);
      // Owner-only, memory-only transfer. Never save clipboard bytes to operation
      // receipts, teaching recordings, workspace state or agent tool outputs.
      const result = await this.rpc({ kind: 'clipboard', action });
      signal?.throwIfAborted();
      this.assertControl('owner', epoch);
      if (
        typeof result?.text !== 'string' ||
        !result.text ||
        result.text.includes('\0') ||
        Buffer.byteLength(result.text) > 65536
      )
        throw fail('Select up to 64 KB of plain text in the computer and try Copy again.');
      return { text: result.text };
    });
  }
  receipts() {
    return this.db
      .prepare(
        'SELECT id,label,actor,status,result,created FROM computer_operations ORDER BY created DESC LIMIT 30',
      )
      .all()
      .map((r) => ({ ...r, result: JSON.parse(r.result || '{}') }));
  }
  async perform(
    p,
    {
      actor = 'agent',
      scope = 'owner',
      signal,
      guard = () => {},
      observeControls = false,
      receiptOnly = false,
    } = {},
  ) {
    const epoch = this.epoch;
    this.assertControl(actor, epoch);
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(p.operationId || ''))
      throw fail('Give this action a unique operation ID.', 400);
    if (!['exec', 'desktop', 'files', 'app'].includes(p.kind))
      throw fail('Unsupported computer action.', 400);
    if (p.kind === 'app' && actor !== 'owner')
      throw fail('Document controls are owner-only. Use computer_run for agent apps.', 403);
    const id = digest(`${scope}:${p.operationId}`),
      hash = digest(JSON.stringify(p));
    return this.serial(async () => {
      guard();
      signal?.throwIfAborted();
      this.assertControl(actor, epoch);
      const previous = this.db.prepare('SELECT * FROM computer_operations WHERE id=?').get(id);
      if (previous) {
        if (previous.hash !== hash)
          throw fail('That operation ID belongs to a different action.', 409);
        if (previous.status !== 'completed')
          throw fail(
            'This action already failed or was interrupted. Inspect the workspace before trying a new action.',
            409,
          );
        return { ...JSON.parse(previous.result), repeated: true };
      }
      // Recovery may read a confirmed receipt, but must never turn a missing
      // journal entry into permission to run an action after a crash.
      if (receiptOnly)
        throw fail(
          'This computer action has no confirmed receipt. Inspect the saved work before retrying; Relay will not repeat it automatically.',
        );
      const desktop = await this.requireRunning();
      // Every agent shell, including its detached GUI children, runs in the
      // freezer boundary. Owner commands run on the available desktop.
      const target = p.kind === 'exec' && actor === 'agent' ? this.runtime.name : this.name;
      if (target === this.runtime.name) await this.runtime.ensure(desktop);
      else if (actor === 'owner') await this.runtime.pause();
      guard();
      signal?.throwIfAborted();
      this.assertControl(actor, epoch);
      const job = randomBytes(16).toString('hex');
      const label =
        p.kind === 'exec'
          ? p.command?.slice(0, 160) || 'Command'
          : `${p.kind}: ${p.action}${p.path ? ' ' + p.path : ''}`;
      this.db
        .prepare('INSERT INTO computer_operations VALUES (?,?,?,?,?,?,?)')
        .run(id, hash, label, actor, 'running', null, new Date().toISOString());
      this.active = { job, label, actor, target, aborted: false };
      let cancellation;
      const cancel = () => {
        if (this.active?.job === job) this.active.aborted = true;
        cancellation ||= this.rpc({ kind: 'cancel', job }, target).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (signal?.aborted) cancel();
        // Observation detail is not part of the input-action receipt. An
        // application update must not change the identity of a saved action.
        const result = await this.rpc(
          { ...p, ...(p.kind === 'desktop' && observeControls ? { controls: true } : {}), job },
          target,
        );
        await cancellation;
        if (this.active.aborted)
          throw fail('Computer work was stopped. Inspect its files before repeating the action.');
        guard();
        signal?.throwIfAborted();
        // Keep observations transient. A replay returns the acknowledgement, not
        // old screen coordinates that might target a changed app.
        const { screenshot, accessibility, base64, ...saved } = result;
        this.db
          .prepare("UPDATE computer_operations SET status='completed',result=? WHERE id=?")
          .run(JSON.stringify(saved), id);
        return { ...result, operationId: id };
      } catch (error) {
        this.db
          .prepare("UPDATE computer_operations SET status='interrupted',result=? WHERE id=?")
          .run(JSON.stringify({ error: error.message }), id);
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        this.active = null;
      }
    });
  }
  async takeControl() {
    this.assertAvailable();
    this.transitioning++;
    const epoch = ++this.epoch;
    this.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    try {
      await this.cancel();
      return await this.serial(async () => {
        if (epoch === this.epoch) {
          const c = await this.inspect();
          if (c?.State.Running && c.Mounts?.length === 1)
            throw fail(
              'Stop and start the computer to enable isolated commands. Your workspace files will stay.',
            );
          await this.runtime.pause();
        }
        return { controller: this.controller };
      });
    } finally {
      this.transitioning--;
    }
  }
  async release(_actor = 'owner', expectedEpoch) {
    this.assertAvailable();
    if (expectedEpoch !== undefined) this.assertControl('owner', expectedEpoch);
    this.transitioning++;
    const epoch = ++this.epoch;
    try {
      return await this.serial(async () => {
        if (epoch !== this.epoch) return { controller: this.controller };
        await this.runtime.resume();
        if (epoch !== this.epoch) {
          await this.runtime.pause();
          return { controller: this.controller };
        }
        this.db.prepare("UPDATE computer_meta SET controller='agent' WHERE id=1").run();
        return { controller: this.controller };
      });
    } finally {
      this.transitioning--;
    }
  }
  async releaseWhileAsleep(verifyAsleep, expectedEpoch) {
    this.assertControl('owner', expectedEpoch);
    this.transitioning++;
    const epoch = ++this.epoch;
    try {
      return await this.serial(async () => {
        this.assertControl('owner', epoch);
        // Only the engine service can supply fresh evidence of a stopped,
        // pinned local VM. Never substitute an unreachable Docker socket.
        await verifyAsleep();
        this.assertControl('owner', epoch);
        this.db.prepare("UPDATE computer_meta SET controller='agent' WHERE id=1").run();
        return { controller: this.controller };
      });
    } finally {
      this.transitioning--;
    }
  }
  async cancel() {
    await this.stdio.stopAll();
    const active = this.active;
    if (active) {
      active.aborted = true;
      await this.rpc({ kind: 'cancel', job: active.job }, active.target);
    }
  }
  shutdown() {
    if (this.shutdownTask) return this.shutdownTask;
    this.closing = true;
    this.epoch++;
    // Service lifetime is separate from desktop lifetime. Keep open apps and
    // offline background work; never unfreeze commands while the owner has control.
    // Foreground calls are cancelled and website grants end with this broker.
    this.network?.stop();
    this.shutdownTask = (async () => {
      await this.cancel();
      await this.serial(async () => {
        if (this.controller === 'owner') await this.runtime.pause();
      });
      return { detached: true };
    })();
    return this.shutdownTask;
  }
  async stop() {
    if (this.maintenance) throw fail('The computer is being refreshed. Wait for it to finish.');
    this.epoch++;
    this.network?.stop();
    await this.cancel();
    return this.serial(async () => {
      if (this.maintenance) throw fail('The computer is being refreshed. Wait for it to finish.');
      // Remove the command container while frozen; do not briefly resume its
      // background programs in order to shut them down.
      await this.runtime.stop();
      this.jobs.stopped();
      const c = await this.inspect();
      if (c?.State.Running) await this.checked(['stop', '--time', '3', this.name]);
      return this.status();
    });
  }
  async list(path = '.') {
    await this.requireRunning();
    return this.rpc({ kind: 'files', action: 'list', path });
  }
  async read(path) {
    await this.requireRunning();
    return this.rpc({ kind: 'files', action: 'read', path });
  }
  async requestWebsite(url, reason) {
    if (!this.network) throw fail('Website access is disabled on this server.', 503);
    return this.network.request(url, reason);
  }
  async decideWebsite(host, decision, runId) {
    if (!this.network) throw fail('Website access is disabled on this server.', 503);
    if (runId && decision === 'allow') this.network.continuation(runId, host);
    const result = await this.network.decide(host, decision);
    if (runId && decision === 'allow') Object.assign(result, this.network.resume(runId, host));
    return result;
  }
  async openWebsite(url, options = {}) {
    const target = website(url);
    if (!this.network?.allowed(target.host)) throw fail('Allow this website before opening it.');
    await this.requireRunning();
    await this.network.start();
    return this.perform(
      {
        kind: 'desktop',
        action: 'open_url',
        url: target.url,
        operationId: options.operationId || randomBytes(16).toString('hex'),
      },
      options,
    );
  }
}
