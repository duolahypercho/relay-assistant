import { ArrowRight } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { surfaces } from '../../shared/surfaces.mjs';
import type { Page } from '../types';

// Library shortcuts are compact links. Full workspace pages keep forms and
// navigation out of the transcript, including for older saved messages.
export default function WorkspaceCard({ page }: { page: string; messageId?: string }) {
  const { go } = useWorkspace();
  const surface = (surfaces as Record<string, any>)[page];
  if (!surface) return null;
  return (
    <section className="workspace-card" role="group" aria-label={surface.title}>
      <button
        className="workspace-card-toggle"
        aria-label={`Open ${surface.title.toLowerCase()}`}
        onClick={() => go(page as Page)}
      >
        <span>{surface.title}</span>
        <span>
          Open <ArrowRight size={16} />
        </span>
      </button>
    </section>
  );
}
