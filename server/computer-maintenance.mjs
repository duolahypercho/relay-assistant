// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

// Owner-only maintenance. The model never receives these operations as tools.
export class ComputerMaintenance {
  constructor(computer, setup) {
    this.computer = computer;
    this.setup = setup;
    setup.maintenance = this;
    this.phase = 'idle';
    this.error = '';
    this.review = null;
  }
  managed() {
    const saved = this.computer.db
      .prepare('SELECT image, host FROM computer_setup_config WHERE id=1')
      .get();
    return (
      this.setup.explicit !== 'true' &&
      this.setup.allowed &&
      saved?.image === this.computer.image &&
      saved?.host === this.computer.dockerHost
    );
  }
  status() {
    return {
      available: this.computer.enabled,
      canUpdate: !!this.managed(),
      phase: this.phase,
      busy: !!this.pending,
      error: this.error,
      review: this.review ? { id: this.review.id, kind: this.review.kind } : null,
    };
  }
  prepare(kind) {
    this.computer.assertAvailable();
    if (!['update', 'recover'].includes(kind)) throw fail('Choose update or recovery.', 400);
    if (!this.computer.enabled) throw fail('Set up the computer first.');
    if (this.pending) throw fail('Computer maintenance is already in progress.');
    if (kind === 'update' && !this.managed())
      throw fail(
        'This computer is managed through server settings. Its owner can update its image there.',
      );
    this.error = '';
    this.review = null;
    this.phase = 'preparing';
    this.controller = new AbortController();
    const current = this.computer.image;
    this.pending = (async () => {
      let candidate = { image: current, host: this.computer.dockerHost };
      if (kind === 'update')
        candidate = await this.setup.prepare(this.controller.signal, {
          activate: false,
          host: this.computer.dockerHost,
        });
      this.controller.signal.throwIfAborted();
      if (kind === 'update' && candidate.image === current) {
        this.phase = 'current';
        return;
      }
      this.review = { id: randomUUID(), kind, current, ...candidate };
      this.phase = 'review';
    })()
      .catch((error) => {
        this.phase = this.controller.signal.aborted ? 'idle' : 'error';
        this.error = this.controller.signal.aborted ? '' : error.message;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.status();
  }
  apply(id) {
    if (this.pending) throw fail('Computer maintenance is already in progress.');
    const plan = this.review;
    if (!plan || id !== plan.id) throw fail('Review this computer change again before continuing.');
    if (plan.current !== this.computer.image || plan.host !== this.computer.dockerHost)
      throw fail('The computer changed. Review the update again.');
    if (plan.kind === 'update' && !this.managed())
      throw fail(
        'The server settings changed. Ask its owner to review the computer configuration.',
      );
    this.review = null;
    this.error = '';
    this.phase = 'applying';
    const managed = this.managed();
    this.pending = this.computer
      .rebuild(plan.image, (image) => {
        if (managed)
          this.computer.db
            .prepare('UPDATE computer_setup_config SET image=? WHERE id=1')
            .run(image);
      })
      .then(() => {
        this.phase = 'done';
      })
      .catch((error) => {
        this.phase = 'error';
        this.error = error.message;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.status();
  }
  async cancel() {
    if (this.phase === 'applying') throw fail('Wait for the computer to finish restarting.');
    this.controller?.abort(new Error('Preparation cancelled.'));
    await this.pending;
    this.review = null;
    this.error = '';
    this.phase = 'idle';
    return this.status();
  }
  async close() {
    if (this.phase !== 'applying') this.controller?.abort(new Error('Relay is restarting.'));
    await this.pending;
  }
}
