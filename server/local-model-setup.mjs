// SPDX-License-Identifier: MIT
import { randomUUID, createHash } from 'node:crypto';
import { localModelSuggestion } from './local-model-downloads.mjs';

const key = 'local-model-setup';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// One explicit owner action authorizes installation, one named download and activation.
// The existing managers retain their verified artifact, process and transport boundaries.
export class LocalModelSetup {
  constructor(
    store,
    { installation, runtime, downloads, provider, suggestion = localModelSuggestion },
  ) {
    Object.assign(this, { store, installation, runtime, downloads, provider, suggestion });
    this.pending = null;
    this.closed = false;
    this.state = JSON.parse(store.secret(key) || 'null');
    if (this.state?.phase === 'running') {
      this.state = {
        ...this.state,
        phase: 'interrupted',
        error: 'Setup was interrupted. Continue when you’re ready.',
      };
      this.persist();
    }
  }
  selection() {
    // Vault ciphertext changes on every write, including switching away and back.
    return createHash('sha256')
      .update(
        this.store.secret('model-connections') || JSON.stringify(this.provider.environment || {}),
      )
      .digest('hex');
  }
  persist() {
    this.store.secret(key, JSON.stringify(this.state));
  }
  status() {
    const current = this.provider.current;
    let progress = null;
    if (this.state?.phase === 'running') {
      const install = this.installation.status(),
        download = this.downloads.status().download;
      if (this.state.step === 'installing' && install.installation?.id === this.state.installId)
        progress = {
          stage: install.installation.stage,
          completed: install.installation.completed,
          total: install.bytes,
        };
      if (this.state.step === 'downloading' && download?.id === this.state.downloadId)
        progress = { stage: download.stage, completed: download.completed, total: download.total };
    }
    const {
      selection: _selection,
      installId: _installId,
      downloadId: _downloadId,
      ...job
    } = this.state || {};
    return {
      suggestion: this.suggestion,
      selection: this.selection(),
      job: this.state
        ? {
            ...job,
            progress,
            connected:
              this.state.phase === 'complete' &&
              current?.id === this.state.connectionId &&
              current?.model === this.state.model &&
              current?.preset === 'ollama' &&
              current?.baseUrl === 'http://127.0.0.1:11434/v1' &&
              current?.protocol === 'chat',
          }
        : null,
    };
  }
  assertIdle() {
    if (this.pending)
      throw fail('Local AI setup is running. Cancel setup before changing these settings.');
  }
  start(input) {
    if (this.closed) throw fail('Relay is stopping. Reconnect before continuing setup.', 503);
    if (
      !uuid.test(input?.id || '') ||
      input?.model !== this.suggestion.model ||
      typeof input?.startWithRelay !== 'boolean' ||
      typeof input?.install !== 'boolean'
    )
      throw fail('Review the local model and start setup again.', 400);
    if (input.id === this.state?.id) {
      if (
        input.model !== this.state.model ||
        input.startWithRelay !== this.state.startWithRelay ||
        input.install !== this.state.install
      )
        throw fail('This setup request already has different options.');
      return this.status();
    }
    this.assertIdle();
    if (this.installation.pending || this.runtime.pending || this.downloads.pending)
      throw fail('Wait for the current installation, startup or download to finish.');
    if (input.selection !== this.selection())
      throw fail('Your AI connection changed. Review it before starting setup.');
    this.state = {
      id: input.id,
      model: input.model,
      install: input.install,
      startWithRelay: input.startWithRelay,
      selection: input.selection,
      phase: 'running',
      step: 'checking',
      error: '',
      installId: randomUUID(),
      downloadId: randomUUID(),
    };
    this.persist();
    this.controller = new AbortController();
    this.pending = this.run(this.controller.signal).finally(() => {
      this.pending = null;
    });
    return this.status();
  }
  step(value) {
    this.state.step = value;
    this.persist();
  }
  async run(signal) {
    try {
      let runtime = await this.runtime.status(signal);
      signal.throwIfAborted();
      if (!runtime.running && !runtime.installed) {
        if (!this.state.install || !this.installation.status().supported)
          throw fail('Install Ollama on your Relay computer, then continue setup.');
        this.step('installing');
        this.installation.start({ id: this.state.installId });
        await this.installation.pending;
        signal.throwIfAborted();
        if (this.installation.status().installation?.phase !== 'ready')
          throw fail(
            'Ollama installation did not finish. Check your connection and free space, then continue setup.',
          );
        runtime = await this.runtime.status(signal);
      }
      signal.throwIfAborted();
      if (!runtime.running) {
        this.step('starting');
        await this.runtime.start(
          { revision: runtime.revision, startWithRelay: this.state.startWithRelay },
          signal,
        );
      }
      signal.throwIfAborted();
      this.step('checking-model');
      let catalog = await this.provider.discoverLocal(signal);
      signal.throwIfAborted();
      const installed = () =>
        catalog.services
          .find((s) => s.preset === 'ollama')
          ?.models.some((m) => m.id === this.state.model);
      if (!installed()) {
        this.step('downloading');
        this.downloads.start({ id: this.state.downloadId, model: this.state.model });
        await this.downloads.pending;
        signal.throwIfAborted();
        if (this.downloads.status().download?.phase !== 'ready')
          throw fail(
            'The model download did not finish. Check Ollama, your connection and free space, then continue setup.',
          );
        catalog = await this.provider.discoverLocal(signal);
        signal.throwIfAborted();
        if (!installed())
          throw fail('The downloaded model is not available yet. Continue setup to check again.');
      }
      // No await between this comparison and the synchronous vault commit.
      if (this.selection() !== this.state.selection) {
        this.state.phase = 'review';
        this.state.error =
          'Your AI connection changed during setup. Your downloaded model is ready to choose.';
        return;
      }
      const existing = this.provider
        .publicState()
        .connections.find(
          (c) =>
            c.preset === 'ollama' &&
            c.baseUrl === 'http://127.0.0.1:11434/v1' &&
            c.protocol === 'chat' &&
            c.model === this.state.model,
        );
      const result = existing
        ? this.provider.select(existing.id)
        : this.provider.save({
            name: `Ollama · ${this.state.model}`.slice(0, 80),
            preset: 'ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            protocol: 'chat',
            model: this.state.model,
            apiKey: '',
            activate: true,
          });
      this.state.connectionId = result.active;
      this.state.phase = 'complete';
      this.state.step = 'ready';
    } catch (error) {
      this.state.phase = signal.aborted ? (this.closed ? 'interrupted' : 'cancelled') : 'error';
      this.state.error = signal.aborted
        ? ''
        : error.status
          ? error.message
          : 'Local AI setup could not finish. Check your Relay computer and continue setup.';
    } finally {
      this.persist();
    }
  }
  async cancel(input) {
    if (!this.state || input?.id !== this.state.id)
      throw fail('Setup changed. Check its current progress.');
    if (this.pending) {
      this.controller.abort();
      // Only cancel jobs this operation created. Never stop an existing Ollama service.
      await Promise.all([
        this.installation.state?.id === this.state.installId
          ? this.installation.cancel({ id: this.state.installId })
          : null,
        this.downloads.state?.id === this.state.downloadId
          ? this.downloads.cancel({ id: this.state.downloadId })
          : null,
      ]);
      await this.pending;
    }
    return this.status();
  }
  async close() {
    this.closed = true;
    if (this.pending) await this.cancel({ id: this.state.id });
  }
}
