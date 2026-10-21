import { CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
export type DirectoryApp = {
  id: string;
  name: string;
  description: string;
  keywords: string;
  endpoint: string;
  guide: string;
};
export default function AppDirectory({
  apps,
  query,
  onQuery,
  connected,
  disabled,
  onSelect,
}: {
  apps: DirectoryApp[];
  query: string;
  onQuery: (value: string) => void;
  connected: (app: DirectoryApp) => boolean;
  disabled: boolean;
  onSelect: (app: DirectoryApp) => void;
}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = apps.filter((app) =>
    words.every((word) =>
      `${app.name} ${app.description} ${app.keywords}`.toLocaleLowerCase().includes(word),
    ),
  );
  return (
    <section className="app-directory" aria-labelledby="app-directory-heading">
      <h2 id="app-directory-heading">Find an app</h2>
      <p>Choose an app, sign in, then review what Relay can use.</p>
      <label className="app-directory-search">
        <MagnifyingGlass size={19} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search apps"
          placeholder="Search apps or what you want to do"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <div className="apps-list">
        {visible.map((app) => (
          <button
            className="app-connection app-directory-option"
            key={app.id}
            type="button"
            disabled={disabled}
            aria-label={`${connected(app) ? 'Open' : 'Connect'} ${app.name}`}
            onClick={() => onSelect(app)}
          >
            <span className="app-mark app-letter" aria-hidden="true">
              {app.name.slice(0, 1)}
            </span>
            <span className="app-summary">
              <strong>{app.name}</strong>
              <span className="app-description">{app.description}</span>
            </span>
            <span className="app-directory-action" aria-hidden="true">
              <span>{connected(app) ? 'Manage' : 'Connect'}</span>
              <CaretRight size={18} />
            </span>
          </button>
        ))}
      </div>
      {!visible.length && (
        <p role="status">No matching apps. You can add one using its connection link below.</p>
      )}
    </section>
  );
}
