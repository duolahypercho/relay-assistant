import { useState } from 'react';
import { UsersThree } from '@phosphor-icons/react';
import { assistantProfile } from '../../shared/assistant-scope.mjs';
import { useWorkspace } from '../context';
import { Modal, Field } from './ui';
import { AssistantAvatar } from './Assistant';
import type { Entity } from '../types';
import './groups.css';
export default function GroupEditor({ thread, onClose }: { thread?: Entity; onClose: () => void }) {
  const { s, act, selectThread, go } = useWorkspace();
  const [ids, setIds] = useState<string[]>(thread?.participantIds || []);
  const [title, setTitle] = useState(thread?.title || '');
  const [busy, setBusy] = useState(false);
  const choices = [assistantProfile(s), ...(s.assistants || [])];
  return (
    <Modal title={thread ? 'Group details' : 'New group chat'} onClose={onClose}>
      <form
        className="group-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const result = await act(thread ? 'group.update' : 'group.create', {
            id: thread?.id,
            participantIds: ids,
            ...(title.trim() ? { title: title.trim() } : {}),
          });
          setBusy(false);
          if (result) {
            selectThread(result.id);
            onClose();
          }
        }}
      >
        <p>Two to six assistants, one conversation.</p>
        <Field label="Group name (optional)">
          <input
            value={title}
            maxLength={100}
            placeholder="A little team"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <fieldset className="group-choices">
          <legend>Participants · {ids.length} of 6</legend>
          {choices.map((a) => (
            <label key={a.id} className="group-choice">
              <AssistantAvatar assistantId={a.id} animated={false} />
              <span>
                <strong>{a.name}</strong>
                <small>{a.description || 'Your personal assistant'}</small>
              </span>
              <input
                type="checkbox"
                aria-label={a.name}
                checked={ids.includes(a.id)}
                disabled={busy || (!ids.includes(a.id) && ids.length >= 6)}
                onChange={() =>
                  setIds(ids.includes(a.id) ? ids.filter((id) => id !== a.id) : [...ids, a.id])
                }
              />
            </label>
          ))}
        </fieldset>
        {choices.length < 2 && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onClose();
              go('assistants');
            }}
          >
            Add another assistant
          </button>
        )}
        <button type="submit" className="primary-button" disabled={busy || ids.length < 2}>
          <UsersThree size={19} />
          {thread ? 'Save group' : 'Start group chat'}
        </button>
      </form>
    </Modal>
  );
}
