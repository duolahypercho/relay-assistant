import SkillFiles from './SkillFiles';
import { useState } from 'react';
import { api } from '../api';
import { Field, Modal } from './ui';
import type { Entity } from '../types';
import { ArrowLeft } from '@phosphor-icons/react';

export default function SkillEditor({
  initial,
  sourceMessage,
  onClose,
  inline = false,
}: {
  initial?: Entity;
  sourceMessage?: Entity;
  onClose: () => void;
  inline?: boolean;
}) {
  const [title, setTitle] = useState(initial?.title || '');
  const [slug, setSlug] = useState(initial?.slug || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [instructions, setInstructions] = useState(
    initial?.instructions || sourceMessage?.text || '',
  );
  const [files, setFiles] = useState(initial?.files || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.act(initial ? 'skill.update' : 'skill.create', {
        id: initial?.id,
        version: initial?.version,
        title,
        slug,
        description,
        instructions,
        sourceMessageId: sourceMessage?.id,
        ...(initial?.files ? { files } : {}),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form = (
    <form onSubmit={(e) => void save(e)}>
      {sourceMessage && (
        <p className="form-note">
          Start with this reply, then turn it into steps you want me to follow again.
        </p>
      )}
      <Field label="Skill name">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={100}
          placeholder="My weekly review"
          autoFocus
        />
      </Field>
      <Field label="Shortcut" hint="Type / followed by this shortcut in any chat.">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
          maxLength={64}
          placeholder="weekly-review"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <Field label="When to use it">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1024}
          placeholder="When I want to plan the week ahead"
        />
      </Field>
      <Field
        label="Instructions"
        hint="Include the inputs, steps, checks, result format, and anything that needs your review."
      >
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          required
          maxLength={12000}
          rows={8}
          placeholder="Read my upcoming calendar. Ask about missing priorities. Return a short plan with sources. Prepare calendar changes for my review."
        />
      </Field>
      <SkillFiles files={files} onChange={setFiles} />
      <p className="form-note">
        Editing changes future chat runs. Routines keep their saved version until you update them.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Save skill'}
        </button>
      </div>
    </form>
  );
  const heading = initial ? 'Edit skill' : 'Save a skill';
  return inline ? (
    <section className="skill-sheet" aria-labelledby="skill-editor-heading">
      <button className="text-button" onClick={onClose} disabled={busy}>
        <ArrowLeft size={16} /> Back to skills
      </button>
      <h2 id="skill-editor-heading">{heading}</h2>
      {form}
    </section>
  ) : (
    <Modal title={heading} onClose={onClose}>
      {form}
    </Modal>
  );
}
