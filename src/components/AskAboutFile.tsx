import { useState } from 'react';
import { ChatCircle } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { tr } from '../i18n';

export default function AskAboutFile({ id }: { id: string }) {
  const { composeFile } = useWorkspace();
  const [error, setError] = useState('');
  return (
    <div className="ask-about-file">
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setError('');
          try {
            composeFile(id);
          } catch (e) {
            setError(tr((e as Error).message));
          }
        }}
      >
        <ChatCircle size={18} aria-hidden="true" />
        {tr('Ask about this')}
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
