import SkillFiles from '../components/SkillFiles';
import { useState } from 'react';
import { Plus, Play, Archive, BookBookmark, UploadSimple } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { Empty, Field, Modal } from '../components/ui';
import SkillEditor from '../components/SkillEditor';
import SkillTransfer from '../components/SkillTransfer';
import type { Entity } from '../types';

export default function Skills() {
  const { s, threadId, act, selectThread } = useWorkspace();
  const [edit, setEdit] = useState<Entity | 'new' | null>(null);
  const [run, setRun] = useState<Entity | null>(null);
  const [archived, setArchived] = useState(false);
  const [transfer, setTransfer] = useState<Entity | 'import' | null>(null);
  const skills = (s.skills || []).filter((x) => !!x.archived === archived);
  if (edit)
    return (
      <SkillEditor
        inline
        initial={edit === 'new' ? undefined : edit}
        onClose={() => setEdit(null)}
      />
    );
  if (transfer)
    return (
      <SkillTransfer
        exporting={transfer === 'import' ? undefined : transfer}
        onClose={() => setTransfer(null)}
      />
    );
  return (
    <div className="skills-view">
      <div className="routine-heading">
        <p className="form-note">A method worth keeping, ready whenever you need it.</p>
        <div className="routine-controls">
          <button className="secondary-button" onClick={() => setTransfer('import')}>
            <UploadSimple size={16} /> Import skill
          </button>
          <button className="primary-button" onClick={() => setEdit('new')}>
            <Plus size={16} />
            New skill
          </button>
        </div>
      </div>
      <button className="text-button routine-archive-toggle" onClick={() => setArchived(!archived)}>
        <Archive size={16} />
        {archived ? 'Show current skills' : 'Archived skills'}
      </button>
      {!skills.length && (
        <Empty
          icon={BookBookmark}
          title={archived ? 'No archived skills' : 'Save your first method'}
        >
          Write the steps, or use Save as skill on a helpful reply.
        </Empty>
      )}
      <div className="skill-list">
        {skills.map((skill) => (
          <article key={skill.id} className="skill-card" aria-label={skill.title}>
            <div className="routine-heading">
              <h3>{skill.title}</h3>
              <small>
                /{skill.slug} · v{skill.version}
              </small>
            </div>
            {skill.description && <p>{skill.description}</p>}
            <details className="skill-method">
              <summary>Saved instructions</summary>
              <p>{skill.instructions}</p>
            </details>
            <SkillFiles files={skill.files || []} />
            <div className="routine-controls">
              {archived ? (
                <button
                  className="secondary-button"
                  onClick={() => void act('skill.restore', { id: skill.id })}
                >
                  Restore skill
                </button>
              ) : (
                <>
                  <button className="secondary-button" onClick={() => setRun(skill)}>
                    <Play size={15} />
                    Run skill
                  </button>
                  <button className="text-button" onClick={() => setEdit(skill)}>
                    Edit skill
                  </button>
                  <button className="text-button" onClick={() => setTransfer(skill)}>
                    Share skill
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void act('skill.archive', { id: skill.id })}
                  >
                    Archive skill
                  </button>
                </>
              )}
              {skill.sourceTeachingId && (
                <a
                  className="text-button"
                  href={`#computer/teaching/${encodeURIComponent(skill.sourceTeachingId)}`}
                >
                  View demonstration
                </a>
              )}
              {skill.sourceMessageId && (
                <button
                  className="text-button"
                  onClick={() => {
                    const message = s.messages.find((m) => m.id === skill.sourceMessageId);
                    if (message) selectThread(message.threadId, message.id);
                  }}
                >
                  View source message
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {run && <SkillRunner skill={run} threadId={threadId} onClose={() => setRun(null)} />}
    </div>
  );
}
function SkillRunner({
  skill,
  threadId,
  onClose,
}: {
  skill: Entity;
  threadId: string;
  onClose: () => void;
}) {
  const { selectThread } = useWorkspace();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={`Run ${skill.title}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.act('skill.run', { id: skill.id, threadId, input });
            onClose();
            selectThread(threadId);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <Field
          label="Anything for this run?"
          hint="Add the topic, source files or details to use this time."
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            maxLength={10000}
            autoFocus
          />
        </Field>
        <p className="form-note">
          Runs in this chat. Your unsent draft stays here.{' '}
          {api.mode() === 'sample' &&
            'Sample mode demonstrates built-in workflows; connect a model for custom instructions.'}
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
            {busy ? 'Starting…' : 'Run in this chat'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
