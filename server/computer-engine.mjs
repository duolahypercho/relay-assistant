// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const safeProfile = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const stopKey = 'computer-engine-stop';

// Owner-only recovery for an already installed, selected local Colima profile.
// No model tool exposes this service. Only an installation-owned VM can be stopped.
export class ComputerEngine {
  constructor(setup, { platform = process.platform, colima } = {}) {
    this.setup = setup;
    this.platform = platform;
    this.colima =
      colima || ['/opt/homebrew/bin/colima', '/usr/local/bin/colima'].find(existsSync) || 'colima';
    this.phase = 'idle';
    this.error = '';
    this.pending = null;
    setup.computer.engineControl = this;
    const interrupted = setup.computer.store.secret(stopKey);
    if (interrupted) {
      this.intent = 'stop';
      this.phase = 'error';
      this.error = 'The last stop was not confirmed. Try stopping your private computer again.';
    }
  }
  view(result = this.last || {}) {
    const unrelatedStop =
      this.intent === 'stop' && !this.pending && !this.setup.installation?.selected;
    return {
      available: this.setup.allowed,
      canStart: !!result.canStart && this.setup.allowed,
      canContinueChat:
        !!result.canStart &&
        !result.running &&
        this.setup.allowed &&
        this.setup.computer.enabled &&
        !this.setup.computer.remoteEngine &&
        result.host === this.selectedHost() &&
        !this.pending &&
        !this.setup.pending &&
        !this.setup.installation?.pending,
      running: !!result.running,
      runtime: result.runtime,
      profile: result.profile,
      managed: !!this.setup.installation?.selected || !!result.managed,
      phase: unrelatedStop ? 'idle' : this.phase,
      intent: unrelatedStop ? 'open' : this.intent || 'open',
      busy: !!this.pending,
      cancellable:
        !!this.pending &&
        this.intent !== 'stop' &&
        !['releasing', 'cancelling'].includes(this.phase) &&
        (this.phase !== 'opening' || this.intent === 'resume'),
      error: unrelatedStop ? '' : this.error,
    };
  }
  selectedHost() {
    // Manually configured servers can select an explicit DOCKER_HOST without
    // a saved setup record. A mutable/default Docker context is not a pin.
    return this.setup.computer.dockerHost || (!this.setup.context ? this.setup.host : undefined);
  }
  async status() {
    if (this.setup.computer.remoteEngine) return { available: false };
    if (
      this.setup.installation?.pending ||
      (this.setup.installation?.selected && !this.setup.computer.enabled)
    )
      return { available: false };
    if (this.pending) return this.view();
    if (this.checkedAt && Date.now() - this.checkedAt < 3000) return this.view();
    if (!this.probing) {
      this.probeController = new AbortController();
      this.probing = this.inspect(this.probeController.signal)
        .then((result) => {
          this.last = result;
          this.checkedAt = Date.now();
        })
        .finally(() => {
          this.probing = null;
        });
    }
    await this.probing;
    return this.view();
  }
  async inspect(signal) {
    if (!this.setup.allowed || !['darwin', 'linux'].includes(this.platform)) return {};
    try {
      return {
        host: await this.setup.engine(signal),
        running: true,
        managed: !!this.setup.installation?.selected,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error.code !== 'runtime') return {};
    }
    try {
      const hosts = await this.setup.engineHosts(signal);
      const managed = this.setup.installation?.selected ? this.setup.installation : null;
      const prefix = `unix://${managed ? join(managed.root, 'colima') : join(this.setup.home, '.colima')}/`;
      const profiles = hosts.flatMap((host) => {
        if (!host.startsWith(prefix)) return [];
        const parts = host.slice(prefix.length).split('/');
        return parts.length === 2 && parts[1] === 'docker.sock' && safeProfile.test(parts[0])
          ? [{ host, profile: parts[0] }]
          : [];
      });
      if (!profiles.length) return {};
      const result = await this.setup.runner(managed?.colima || this.colima, ['list', '--json'], {
        signal,
        env: managed?.env,
      });
      if (result.exitCode) return {};
      const rows = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const candidate of profiles) {
        const row = rows.find((item) => item.name === candidate.profile);
        if (row?.runtime === 'docker' && row.status === 'Stopped')
          return {
            ...candidate,
            canStart: true,
            runtime: managed ? 'Relay' : 'Colima',
            managed: !!managed,
          };
      }
    } catch {
      signal.throwIfAborted();
    }
    return {};
  }
  resume() {
    const computer = this.setup.computer;
    if (!computer.enabled) throw fail('Set up the computer before resuming Relay.');
    computer.assertControl('owner');
    if (this.pending && this.intent !== 'resume')
      throw fail('The computer is already opening. Give it back when it is ready.');
    return this.start({ resume: true });
  }
  continueChat() {
    const computer = this.setup.computer;
    if (!this.setup.allowed) throw fail('Computer setup is disabled by this server’s owner.', 403);
    if (!computer.enabled || computer.remoteEngine)
      throw fail('Open Computer to check its state before resuming Relay.');
    computer.assertControl('owner');
    if (this.pending || this.setup.pending || this.setup.installation?.pending)
      throw fail('Wait for the computer operation to finish.');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.intent = 'chat';
    this.phase = 'checking';
    this.error = '';
    const host = this.selectedHost();
    this.pending = computer
      .releaseWhileAsleep(async () => {
        // Do not trust the cached status used to offer the button. A running,
        // changed or unknown engine always retains the normal handback gate.
        const target = await this.inspect(signal);
        signal.throwIfAborted();
        if (
          !target.canStart ||
          target.running ||
          !host ||
          target.host !== host ||
          this.selectedHost() !== host
        )
          throw fail('Your computer is no longer confirmed asleep. Open Computer to continue.');
        this.last = target;
      }, computer.epoch)
      .then(() => {
        this.phase = 'ready';
        return this.view();
      })
      .catch(() => {
        this.phase = signal.aborted ? 'cancelled' : 'error';
        this.error = signal.aborted
          ? ''
          : 'Relay could not resume. Open Computer to check its state, then try again.';
      })
      .finally(() => {
        this.pending = null;
        this.checkedAt = 0;
      });
    // Like startup, this acknowledges the request. Only a later controller
    // observation confirms handback; clients can still cancel or reconnect.
    return this.view();
  }
  start({ resume = false } = {}) {
    if (!this.setup.allowed) throw fail('Computer setup is disabled by this server’s owner.', 403);
    if (this.pending) {
      if (this.intent === 'stop') throw fail('Wait for your computer to finish stopping.');
      return this.view();
    }
    this.setup.computer.assertAvailable();
    if (this.setup.pending || this.setup.installation?.pending)
      throw fail('Computer setup is already running.');
    this.controller = new AbortController();
    this.intent = resume ? 'resume' : 'open';
    const epoch = resume ? this.setup.computer.epoch : undefined;
    this.error = '';
    this.setup.computer.store.secret(stopKey, null);
    this.phase = 'checking';
    this.pending = this.wake(this.controller.signal, epoch)
      .catch((error) => {
        this.phase = this.controller.signal.aborted ? 'cancelled' : 'error';
        this.error = this.controller.signal.aborted
          ? ''
          : error.ownerMessage ||
            (this.intent === 'resume'
              ? 'Relay could not resume. Open Computer to check its state, then try again.'
              : 'The runtime could not start. Open Colima on the Relay server, then try again.');
      })
      .finally(() => {
        this.pending = null;
        this.checkedAt = 0;
      });
    return this.view();
  }
  stop({ beforeSleep = async () => {} } = {}) {
    const computer = this.setup.computer;
    const installation = this.setup.installation;
    // Existing shared engines retain their container-only Stop behavior.
    if (!installation?.selected) return computer.stop();
    if (this.pending) {
      if (this.intent === 'stop') return computer.status();
      throw fail('Wait for startup to finish or cancel it before stopping the computer.');
    }
    computer.assertAvailable();
    if (this.setup.pending || installation.pending || this.setup.maintenance?.pending)
      throw fail('Wait for computer setup or maintenance to finish.');
    if (!computer.enabled || !installation.policyAllows)
      throw fail('This private computer cannot be stopped through Relay right now.');
    // Save the recovery marker before admitting shutdown. A failed durable
    // write must not leave an in-memory stop lock without a running operation.
    computer.store.secret(stopKey, 'pending');
    computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    this.intent = 'stop';
    this.phase = 'stopping';
    this.error = '';
    this.controller = new AbortController();
    computer.engineStopping = true;
    computer.epoch++;
    const signal = this.controller.signal;
    this.pending = this.sleep(installation, beforeSleep, signal)
      .then(() => {
        this.phase = 'asleep';
        computer.store.secret(stopKey, null);
      })
      .catch(() => {
        this.phase = 'error';
        this.error =
          'Your private computer could not finish stopping and may still be running. Your files are kept. Try again.';
      })
      .finally(() => {
        computer.engineStopping = false;
        this.pending = null;
        this.checkedAt = 0;
      });
    return computer.status();
  }
  async sleep(installation, beforeSleep, signal) {
    const guard = async () => {
      signal.throwIfAborted();
      const selected = () =>
        installation === this.setup.installation &&
        installation.selected &&
        installation.policyAllows;
      if (
        !selected() ||
        !(await installation.owned()) ||
        !(await installation.release.installed()) ||
        !selected()
      )
        throw fail('Private runtime ownership could not be verified.');
    };
    const inspect = async () => {
      await guard();
      const result = await this.setup.runner(installation.colima, ['list', '--json'], {
        signal,
        env: installation.env,
      });
      if (result.exitCode || result.timedOut) throw fail('Private runtime status is unavailable.');
      const row = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s))
        .find((item) => item.name === installation.profile);
      if (row?.runtime !== 'docker' || !['Running', 'Stopped'].includes(row.status))
        throw fail('Private runtime status could not be verified.');
      return row.status;
    };
    if ((await inspect()) === 'Stopped') return;
    await this.setup.computer.stop();
    await beforeSleep();
    await guard();
    this.phase = 'sleeping';
    const stopped = await this.setup.runner(
      installation.colima,
      ['stop', '--profile', installation.profile],
      { signal, timeout: 90000, env: installation.env },
    );
    // Never force a successfully installed computer or delete its disks. Even
    // a successful command is not evidence until the owned profile is Stopped.
    if (stopped.exitCode || stopped.timedOut || (await inspect()) !== 'Stopped')
      throw fail('Private runtime shutdown was not confirmed.');
  }
  async wake(signal, resumeEpoch) {
    const guard = () => {
      signal.throwIfAborted();
      if (resumeEpoch !== undefined) {
        try {
          this.setup.computer.assertControl('owner', resumeEpoch);
        } catch (error) {
          error.ownerMessage = 'Computer control changed. This resume request was stopped.';
          throw error;
        }
      }
    };
    guard();
    const target = await this.inspect(signal);
    guard();
    if (!target.running && !target.canStart)
      throw Object.assign(fail('No existing Colima profile is available.'), {
        ownerMessage:
          'No stopped Colima profile matches this computer. Open its runtime on the Relay server, then try again.',
      });
    this.last = target;
    if (!target.running) {
      this.phase = 'waking';
      const result = await this.setup.runner(
        target.managed ? this.setup.installation.colima : this.colima,
        [
          'start',
          '--profile',
          target.profile,
          '--activate=false',
          '--save-config=false',
          '--ssh-config=false',
        ],
        { signal, timeout: 180000, env: target.managed ? this.setup.installation.env : undefined },
      );
      guard();
      if (result.exitCode) throw fail('Colima did not start.');
      const host = await this.setup.engine(signal);
      if (host !== target.host) throw fail('The selected runtime changed.');
    }
    guard();
    this.setup.computer.assertAvailable();
    if (this.setup.computer.enabled) {
      // Opening is serialized by PrivateComputer. Once opening starts, use its
      // normal Stop control; cancellation must not tear down a shared VM.
      this.phase = 'opening';
      if (!this.setup.computer.dockerHost) this.setup.computer.dockerHost = target.host;
      const opened = await this.setup.computer.start('owner');
      guard();
      if (resumeEpoch !== undefined && opened?.state !== 'running')
        throw fail('The computer did not become ready.');
    } else {
      this.phase = 'preparing';
      this.setup.start();
      await this.setup.pending;
      signal.throwIfAborted();
      if (!this.setup.computer.enabled)
        throw Object.assign(fail('Setup did not finish.'), {
          ownerMessage: this.setup.status().error || 'Setup did not finish. Try again.',
        });
    }
    if (resumeEpoch !== undefined) {
      guard();
      this.phase = 'releasing';
      const result = await this.setup.computer.release('owner', resumeEpoch);
      if (result.controller !== 'agent')
        throw Object.assign(fail('Computer control changed.'), {
          ownerMessage: 'Computer control changed. This resume request was stopped.',
        });
    }
    this.phase = 'ready';
  }
  async cancel() {
    if (this.pending && this.intent === 'stop') return this.view();
    if (this.phase === 'releasing' || this.phase === 'cancelling') return this.view();
    if (this.phase === 'opening') {
      if (this.intent === 'resume') {
        this.controller?.abort(new Error('Resume cancelled.'));
        this.phase = 'cancelling';
      }
      return this.view();
    }
    this.controller?.abort(new Error('Runtime startup cancelled.'));
    if (this.phase === 'preparing') await this.setup.cancel();
    await this.pending?.catch(() => {});
    return this.view();
  }
  async close() {
    this.probeController?.abort(new Error('Relay is shutting down.'));
    await this.cancel();
    await this.pending;
    await this.probing?.catch(() => {});
  }
}
