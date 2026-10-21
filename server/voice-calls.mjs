// SPDX-License-Identifier: MIT
import { command } from '../shared/domain.mjs';
import { isStopMessage } from '../shared/chat-stop.mjs';
import { recordingFormat } from './transcription.mjs';
import { resolveChatApps } from '../shared/app-mentions.mjs';
import { threadAssistantId } from '../shared/assistant-scope.mjs';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const key = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value))
    throw fail('Invalid voice request identifier.', 400);
  return value;
};
const activeRun = (run) => run && ['queued', 'running'].includes(run.status);
export class VoiceCalls {
  constructor(store, services, { clock = Date.now } = {}) {
    this.store = store;
    this.services = services;
    this.clock = clock;
    for (const c of store.read().voiceCalls || [])
      if (c.status === 'active') this.end(c.id, 'Server restarted');
  }
  get(id, state = this.store.read()) {
    const c = (state.voiceCalls || []).find((c) => c.id === id);
    if (!c) throw fail('This voice chat was not found.', 404);
    return c;
  }
  available() {
    const s = this.services;
    if (!s.provider?.configured || !s.transcription?.configured || !s.speech?.configured)
      throw fail(
        'Voice chat needs a chat model, listening and speaking configured in Settings.',
        503,
      );
    if (s.computer?.enabled && s.computer.controller === 'owner')
      throw fail('Give the computer back to Relay before starting voice chat.');
  }
  requireActive(c) {
    if (c.status !== 'active' || c.expiresAt <= this.clock() || c.deadline <= this.clock())
      throw fail('This voice chat has ended. Start another when you are ready.');
    this.available();
  }
  start(id, threadId, context = {}) {
    key(id);
    this.sweep();
    const existing = (this.store.read().voiceCalls || []).find((c) => c.id === id);
    if (existing) return existing;
    this.available();
    return this.store.mutate((s) => {
      s.voiceCalls ||= [];
      if (s.voiceCalls.some((c) => c.status === 'active'))
        throw fail('A voice chat is already open. End it before starting another.');
      const thread = s.threads.find((t) => t.id === threadId && !t.archived);
      if (!thread) throw fail('Choose an active conversation.', 400);
      if (thread.participantIds)
        throw fail('Open an assistant’s own conversation for voice chat.', 400);
      if (s.runs.some((r) => r.threadId === threadId && activeRun(r)))
        throw fail('Wait for the current reply or stop it before starting voice chat.');
      if (!context || typeof context !== 'object' || Array.isArray(context))
        throw fail('Choose files and apps in this chat before calling.', 400);
      const fileIds = context.fileIds ?? [];
      if (
        !Array.isArray(fileIds) ||
        fileIds.length > 8 ||
        fileIds.some((id) => typeof id !== 'string' || !s.files.some((f) => f.id === id))
      )
        throw fail('Choose up to eight available attachments for voice chat.', 400);
      const apps = resolveChatApps(context.apps, this.services.connectors?.chatCatalog() || [], [
        threadAssistantId(s, threadId),
      ]);
      const call = {
        id,
        threadId,
        status: 'active',
        epoch: 0,
        startedAt: this.clock(),
        expiresAt: this.clock() + 20000,
        deadline: this.clock() + 30 * 60000,
        turns: [],
        context: { fileIds: [...new Set(fileIds)], apps },
      };
      s.voiceCalls = [...s.voiceCalls.slice(-99), call];
      return call;
    });
  }
  heartbeat(id) {
    this.sweep();
    return this.store.mutate((s) => {
      const c = this.get(id, s);
      this.requireActive(c);
      c.expiresAt = this.clock() + 20000;
      return c;
    });
  }
  listen(id) {
    return this.store.mutate((s) => {
      const c = this.get(id, s);
      this.requireActive(c);
      c.epoch++;
      for (const turn of c.turns) if (turn.status === 'transcribing') turn.status = 'interrupted';
      c.listening = s.runs.some((r) => r.voiceCallId === id && activeRun(r));
      return c;
    });
  }
  resume(id) {
    return this.store.mutate((s) => {
      const c = this.get(id, s);
      this.requireActive(c);
      if (c.turns.some((t) => t.status === 'transcribing'))
        throw fail('Wait for this spoken turn to finish.');
      c.listening = false;
      return c;
    });
  }
  interrupt(id) {
    const result = this.store.mutate((s) => {
      const c = this.get(id, s);
      this.requireActive(c);
      c.epoch++;
      c.listening = false;
      for (const turn of c.turns) {
        if (turn.status === 'transcribing') turn.status = 'interrupted';
        const run = s.runs.find((r) => r.id === turn.runId);
        if (activeRun(run)) command(s, 'chat.stop', { id: run.id }, true);
      }
      return c;
    });
    for (const turn of result.turns) if (turn.runId) this.services.worker?.abort(turn.runId);
    return result;
  }
  end(id, reason = 'Call ended') {
    const result = this.store.mutate((s) => {
      const c = this.get(id, s);
      if (c.status === 'ended') return c;
      c.status = 'ended';
      c.listening = false;
      c.epoch++;
      c.endedAt = this.clock();
      c.reason = reason;
      for (const t of c.turns) {
        if (t.status === 'transcribing') t.status = 'interrupted';
        const r = s.runs.find((r) => r.id === t.runId);
        if (activeRun(r)) command(s, 'chat.stop', { id: r.id }, true);
      }
      const count = c.turns.filter((t) => t.messageId).length;
      if (count)
        s.messages.push({
          id: `voice-summary-${id}`,
          threadId: c.threadId,
          role: 'assistant',
          text: '',
          createdAt: new Date(c.endedAt).toISOString(),
          cards: [
            {
              kind: 'voice-call',
              id,
              seconds: Math.floor((c.endedAt - c.startedAt) / 1000),
              turns: count,
              reason,
            },
          ],
        });
      return c;
    });
    for (const turn of result.turns) if (turn.runId) this.services.worker?.abort(turn.runId);
    return result;
  }
  sweep() {
    for (const c of this.store.read().voiceCalls || []) {
      if (c.status !== 'active') continue;
      const reason =
        c.deadline <= this.clock()
          ? '30-minute call limit reached'
          : c.expiresAt <= this.clock()
            ? 'Voice connection lost'
            : this.services.computer?.enabled && this.services.computer.controller === 'owner'
              ? 'You took control of the computer'
              : '';
      if (reason) this.end(c.id, reason);
    }
  }
  async turn(id, turnId, bytes, mime, signal) {
    key(turnId);
    this.sweep();
    let c = this.get(id);
    this.requireActive(c);
    const existing = c.turns.find((t) => t.id === turnId);
    if (existing?.runId || existing?.status === 'stopped') return existing;
    recordingFormat(bytes, mime);
    if (c.turns.some((t) => t.status === 'transcribing'))
      throw fail('A voice turn is still being transcribed.');
    if (c.turns.length >= 120) throw fail('This call reached 120 turns. End it and start another.');
    const epoch = c.epoch;
    this.store.mutate((s) => {
      c = this.get(id, s);
      const old = c.turns.find((t) => t.id === turnId);
      if (old) {
        if (old.status !== 'failed') throw fail('This voice turn was interrupted.');
        old.status = 'transcribing';
      } else c.turns.push({ id: turnId, status: 'transcribing' });
    });
    const cancelled = new AbortController();
    const guard = () => {
      const current = this.get(id);
      this.requireActive(current);
      if (current.epoch !== epoch) throw fail('This voice turn was interrupted.');
    };
    const changed = () => {
      try {
        guard();
      } catch {
        cancelled.abort();
      }
    };
    this.store.on('change', changed);
    try {
      const transcript = await this.services.transcription.transcribe(
        bytes,
        mime,
        signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal,
      );
      signal?.throwIfAborted();
      guard();
      const result = this.store.mutate((s) => {
        const c = this.get(id, s),
          turn = c.turns.find((t) => t.id === turnId);
        const thread = s.threads.find((t) => t.id === c.threadId);
        // Speaking must not consume or erase the unfinished typed message.
        // Resolve the call's selections again against current access on every turn.
        const draft = Object.fromEntries(
          ['draft', 'draftFileIds', 'draftApps', 'draftShareIds', 'draftRecipientIds'].map(
            (field) => [field, thread?.[field]],
          ),
        );
        const run = command(
          s,
          'chat.send',
          {
            threadId: c.threadId,
            text: transcript.text,
            ...(isStopMessage(transcript.text) ? {} : c.context),
            delivery: 'now',
          },
          true,
          this.services.connectors?.chatCatalog() || [],
          { voiceCallId: id },
        );
        if (thread) Object.assign(thread, draft);
        c.listening = false;
        const messageId = run.stopControlId
          ? s.messages.find((m) => m.id === run.stopControlId).replyTo
          : run.steeringMessageIds?.at(-1) || run.messageId;
        s.messages.find((m) => m.id === messageId).voiceCallId = id;
        if (run.stopControlId)
          Object.assign(turn, { status: 'stopped', messageId, stopControlId: run.stopControlId });
        else {
          run.voiceCallId = id;
          Object.assign(turn, { status: 'queued', runId: run.id, messageId });
        }
        return turn;
      });
      if (result.stopControlId) this.services.worker?.stopChat(result.stopControlId);
      return result;
    } catch (error) {
      this.store.mutate((s) => {
        const turn = this.get(id, s).turns.find((t) => t.id === turnId);
        if (turn.status === 'transcribing') turn.status = 'failed';
      });
      throw error;
    } finally {
      this.store.off('change', changed);
    }
  }
  async reply(id, messageId, signal, onAudio) {
    this.sweep();
    const c = this.get(id),
      epoch = c.epoch;
    const guard = () => {
      const current = this.get(id);
      this.requireActive(current);
      if (current.epoch !== epoch) throw fail('This voice reply was interrupted.');
      const s = this.store.read(),
        m = s.messages.find((m) => m.id === messageId);
      if (!m || m.threadId !== c.threadId || !c.turns.some((t) => t.messageId === m.replyTo))
        throw fail('Choose a reply from this voice chat.', 404);
      const turn = c.turns.find((t) => t.messageId === m.replyTo);
      if (m.interrupted || s.runs.find((r) => r.id === turn.runId)?.status !== 'completed')
        throw fail('Wait for the completed assistant reply.', 409);
    };
    guard();
    const cancelled = new AbortController();
    const changed = () => {
      try {
        guard();
      } catch {
        cancelled.abort();
      }
    };
    this.store.on('change', changed);
    try {
      return await this.services.speech.forMessage(
        this.store,
        messageId,
        signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal,
        guard,
        onAudio,
      );
    } finally {
      this.store.off('change', changed);
    }
  }
}
export function ensureVoiceCalls(store, services) {
  if (!services.voiceCalls || services.voiceCalls.store !== store)
    services.voiceCalls = new VoiceCalls(store, services);
  return services.voiceCalls;
}
