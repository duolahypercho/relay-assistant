import { tr } from '../i18n';
import { FilePreview } from '../views/Files';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { ArrowLeft } from '@phosphor-icons/react';
import { surfaces } from '../../shared/surfaces.mjs';
import { useWorkspace } from '../context';
import { TaskContent, Review } from '../views/Activity';
import { workspaceViews } from './workspace-views';
import WorkspaceDock from './WorkspaceDock';
import { settingsSections } from '../navigation';
const Settings = lazy(() => import('../views/Settings'));
const ArtifactView = lazy(() => import('../views/Artifact'));
export default function WorkspacePage({
  taskId,
  reviewId,
  artifactRef,
  fileId,
}: {
  fileId: string;
  taskId: string;
  reviewId: string;
  artifactRef: { id: string; version?: number };
}) {
  const { s, page, go, settingsSection } = useWorkspace();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest('.workspace-page-scroll')?.scrollTo(0, 0);
  }, [page, settingsSection, taskId, reviewId, artifactRef.id, fileId]);
  const View = page === 'settings' ? Settings : workspaceViews[page];
  const task = s.tasks.find((t) => t.id === taskId);
  const file = s.files.find((f) => f.id === fileId);
  const title =
    (fileId ? file?.name || 'File unavailable' : '') ||
    (artifactRef.id ? (artifactRef.id === 'new' ? 'Create a result' : 'Your result') : '') ||
    task?.title ||
    (reviewId
      ? 'Review an action'
      : (page === 'more'
          ? 'More'
          : page === 'settings'
            ? settingsSections.find((item) => item.id === settingsSection)?.title || 'Settings'
            : (surfaces as any)[page]?.title) || 'Settings');
  const displayTitle = task?.title || fileId ? title : tr(title);
  return (
    <section
      className={`workspace-page workspace-${page}-page`}
      aria-label={fileId ? tr('File preview') : displayTitle}
    >
      <div className="workspace-page-toolbar">
        <button className="text-button" onClick={() => go('chat')}>
          <ArrowLeft size={18} /> {tr('Back to chat')}{' '}
        </button>
        {(fileId || artifactRef.id) && (
          <button className="text-button" onClick={() => go('files')}>
            {tr('All files')}
          </button>
        )}
        {page === 'settings' && settingsSection && (
          <button className="text-button" onClick={() => go('settings')}>
            {tr('All settings')}
          </button>
        )}
      </div>
      <div className="workspace-page-scroll">
        <div className="workspace-page-content">
          <h1 ref={heading} tabIndex={-1} className={artifactRef.id ? 'sr-only' : undefined}>
            {displayTitle}
          </h1>
          {(taskId || reviewId) && (
            <button className="text-button page-back-list" onClick={() => go('activity')}>
              <ArrowLeft size={16} /> {tr('All tasks')}{' '}
            </button>
          )}
          <Suspense fallback={<p className="inline-loading">{tr('Opening this page…')}</p>}>
            {fileId ? (
              <FilePreview id={fileId} />
            ) : artifactRef.id ? (
              <ArtifactView
                key={`${artifactRef.id}:${artifactRef.version || 'latest'}`}
                id={artifactRef.id}
                versionNumber={artifactRef.version}
              />
            ) : task ? (
              <TaskContent id={task.id} />
            ) : reviewId ? (
              <Review id={reviewId} />
            ) : View ? (
              <View />
            ) : null}
          </Suspense>
        </div>
      </div>
      <WorkspaceDock />
    </section>
  );
}
