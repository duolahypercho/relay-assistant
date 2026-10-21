import { tr } from '../i18n';
import { ChatCircle, Folder, Lightbulb, CheckSquare, SquaresFour } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
export default function WorkspaceDock() {
  const { page, go, selectThread } = useWorkspace();
  return (
    <nav className="chat-dock" aria-label={tr('Workspace shortcuts')}>
      <button
        className="icon-button"
        aria-label={tr('Main chat')}
        title={tr('Main chat')}
        aria-current={page === 'chat' ? 'page' : undefined}
        onClick={() => selectThread('main')}
      >
        <ChatCircle size={21} />
        <span>{tr('Chat')}</span>
      </button>
      <button
        className="icon-button"
        aria-label={tr('Files')}
        title={tr('Files')}
        aria-current={page === 'files' ? 'page' : undefined}
        onClick={() => go('files')}
      >
        <Folder size={21} />
        <span>{tr('Files')}</span>
      </button>
      <button
        className="icon-button"
        aria-label={tr('Ideas')}
        title={tr('Ideas')}
        aria-current={page === 'ideas' ? 'page' : undefined}
        onClick={() => go('ideas')}
      >
        <Lightbulb size={21} />
        <span>{tr('Ideas')}</span>
      </button>
      <button
        className="icon-button"
        aria-label={tr('Tasks')}
        title={tr('Tasks')}
        aria-current={page === 'activity' ? 'page' : undefined}
        onClick={() => go('activity')}
      >
        <CheckSquare size={21} />
        <span>{tr('Tasks')}</span>
      </button>
      <button
        className="icon-button"
        aria-label={tr('More')}
        title={tr('More')}
        onClick={() => go('more')}
        aria-current={page === 'more' ? 'page' : undefined}
      >
        <SquaresFour size={21} />
        <span>{tr('More')}</span>
      </button>
    </nav>
  );
}
