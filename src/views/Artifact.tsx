import { useEffect, useMemo, useRef, useState } from 'react';
import { PencilSimple, Plus, Trash, Eye } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspace } from '../context';
import { api } from '../api';
import { isNativeMobile, hasNativeResults, mobileResults } from '../native-mobile';
import FileDownload from '../components/FileDownload';
import AskAboutFile from '../components/AskAboutFile';
import { fileBytes } from '../../shared/pdf.mjs';
import { artifactKinds, calculateSheet, columnName, previewHtml } from '../../shared/artifacts.mjs';
import { Field, dateTime } from '../components/ui';
import './artifact.css';
type Kind = keyof typeof artifactKinds;
const starters: Record<Kind, string> = {
  document: '# A fresh idea\n\nStart writing here.\n',
  spreadsheet: JSON.stringify(
    {
      sheets: [
        {
          name: 'Plan',
          rows: [
            ['Item', 'Cost'],
            ['First item', 25],
            ['Total', { formula: 'SUM(B2:B2)' }],
          ],
        },
      ],
    },
    null,
    2,
  ),
  presentation: JSON.stringify(
    { slides: [{ title: 'A fresh idea', bullets: ['What matters most'], notes: '' }] },
    null,
    2,
  ),
  web: '<style>body{font:18px system-ui;padding:32px;color:#21382f;background:#faf8f2}button{font:inherit;padding:12px 20px;border:1px solid;border-radius:12px;background:white}</style><h1>A little moment</h1><p id="count">Take a breath.</p><button onclick="document.getElementById(\'count\').textContent=\'You’ve got this.\'">A little encouragement</button>',
};
const cellText = (v: any) =>
  v === null ? '' : typeof v === 'object' ? `=${v.formula}` : String(v);
function CellEditor({
  value,
  label,
  change,
}: {
  value: any;
  label: string;
  change: (v: any) => void;
}) {
  const display = (v: any) =>
    typeof v === 'string' &&
    (v.startsWith("'") || v.startsWith('=') || /^(?:-?[\d.]|true$|false$)/.test(v))
      ? `'${v}`
      : cellText(v);
  const [raw, setRaw] = useState(() => display(value));
  useEffect(() => {
    setRaw(display(value));
  }, [value]);
  return (
    <input
      aria-label={label}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => change(cellInput(raw))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
const cellInput = (v: string) =>
  v.startsWith("'")
    ? v.slice(1)
    : v.startsWith('=')
      ? { formula: v.slice(1) }
      : v === ''
        ? null
        : /^(?:-?\d+(?:\.\d*)?|-?\.\d+)$/.test(v) && Number.isFinite(Number(v))
          ? Number(v)
          : v === 'true'
            ? true
            : v === 'false'
              ? false
              : v;
function Spreadsheet({
  data,
  edit,
  change,
}: {
  data: any;
  edit: boolean;
  change: (v: any) => void;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const index = Math.min(sheetIndex, data.sheets.length - 1),
    sheet = data.sheets[index];
  const width = Math.max(1, ...sheet.rows.map((r: any[]) => r.length));
  let values = sheet.rows,
    error = '';
  try {
    values = calculateSheet(sheet.rows);
  } catch (e) {
    error = (e as Error).message;
  }
  function update(fn: (s: any) => void) {
    const next = structuredClone(data);
    fn(next.sheets[index]);
    change(next);
  }
  return (
    <div className="artifact-sheet">
      {edit || data.sheets.length > 1 ? (
        <div className="artifact-sheet-tabs" role="group" aria-label="Sheets">
          {data.sheets.map((s: any, i: number) => (
            <button
              key={i}
              className={index === i ? 'primary-button' : 'secondary-button'}
              aria-pressed={index === i}
              onClick={() => setSheetIndex(i)}
            >
              {s.name}
            </button>
          ))}
          {edit && data.sheets.length < 10 && (
            <button
              className="text-button"
              onClick={() => {
                const names = data.sheets.map((s: any) => s.name.toLowerCase());
                let n = data.sheets.length + 1;
                while (names.includes(`sheet ${n}`)) n++;
                change({ sheets: [...data.sheets, { name: `Sheet ${n}`, rows: [['Column 1']] }] });
                setSheetIndex(data.sheets.length);
              }}
            >
              <Plus size={16} />
              Add sheet
            </button>
          )}
        </div>
      ) : (
        <p className="artifact-sheet-name">{sheet.name}</p>
      )}
      {edit && (
        <Field label="Sheet name">
          <input
            value={sheet.name}
            maxLength={31}
            onChange={(e) =>
              update((s) => {
                s.name = e.target.value;
              })
            }
          />
        </Field>
      )}
      {error && (
        <p className="artifact-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="artifact-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${sheet.name} table`}
      >
        <table>
          <caption className="sr-only">{sheet.name}</caption>
          <thead>
            <tr>
              <th scope="col">Row</th>
              {Array.from({ length: width }, (_, c) => (
                <th scope="col" key={c}>
                  {columnName(c)}
                </th>
              ))}
              {edit && <th scope="col">Remove</th>}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row: any[], r: number) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>
                    {edit ? (
                      <CellEditor
                        label={`${columnName(c)}${r + 1}`}
                        value={row[c] ?? null}
                        change={(value) =>
                          update((s) => {
                            while (s.rows[r].length <= c) s.rows[r].push(null);
                            s.rows[r][c] = value;
                          })
                        }
                      />
                    ) : (
                      <span
                        title={row[c] && typeof row[c] === 'object' ? cellText(row[c]) : undefined}
                      >
                        {cellText(values[r]?.[c] ?? null)}
                      </span>
                    )}
                  </td>
                ))}
                {edit && (
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Remove row ${r + 1}`}
                      disabled={sheet.rows.length <= 1}
                      onClick={() =>
                        update((s) => {
                          s.rows.splice(r, 1);
                        })
                      }
                    >
                      <Trash size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <>
          <div className="artifact-actions">
            <button
              className="secondary-button"
              disabled={sheet.rows.length >= 200}
              onClick={() =>
                update((s) => {
                  s.rows.push(Array(width).fill(null));
                })
              }
            >
              Add row
            </button>
            <button
              className="secondary-button"
              disabled={width >= 50}
              onClick={() =>
                update((s) => {
                  s.rows = s.rows.map((r: any[]) => [
                    ...r,
                    ...Array(width - r.length + 1).fill(null),
                  ]);
                })
              }
            >
              Add column
            </button>
          </div>
          <p className="form-note">
            Start formulas with =. Use SUM, AVERAGE, MIN, MAX, COUNT, ROUND, or arithmetic with
            cells on this sheet. Start text with an apostrophe to keep a number or = as text.
          </p>
        </>
      )}
    </div>
  );
}
function Presentation({
  data,
  edit,
  change,
}: {
  data: any;
  edit: boolean;
  change: (v: any) => void;
}) {
  const [index, setIndex] = useState(0);
  const active = Math.min(index, data.slides.length - 1),
    slide = data.slides[active];
  function update(key: string, value: any) {
    const next = structuredClone(data);
    next.slides[active][key] = value;
    change(next);
  }
  return (
    <div className="artifact-deck">
      {(edit || data.slides.length > 1) && (
        <div className="artifact-actions">
          <label>
            Slide{' '}
            <select
              aria-label="Slide"
              value={active}
              onChange={(e) => setIndex(Number(e.target.value))}
            >
              {data.slides.map((s: any, i: number) => (
                <option value={i} key={i}>
                  {i + 1}. {s.title || 'Untitled'}
                </option>
              ))}
            </select>
          </label>
          {edit && (
            <>
              <button
                className="secondary-button"
                disabled={data.slides.length >= 30}
                onClick={() => {
                  change({
                    slides: [...data.slides, { title: 'New slide', bullets: [], notes: '' }],
                  });
                  setIndex(data.slides.length);
                }}
              >
                Add slide
              </button>
              <button
                className="text-button"
                disabled={data.slides.length <= 1}
                onClick={() => {
                  change({ slides: data.slides.filter((_: any, i: number) => i !== active) });
                  setIndex(Math.max(0, active - 1));
                }}
              >
                Remove slide
              </button>
            </>
          )}
        </div>
      )}
      {edit ? (
        <div className="artifact-slide-edit">
          <Field label="Slide title">
            <input
              maxLength={90}
              value={slide.title}
              onChange={(e) => update('title', e.target.value)}
            />
          </Field>
          <Field label="Bullet points (one per line)">
            <textarea
              rows={7}
              value={slide.bullets.join('\n')}
              onChange={(e) => update('bullets', e.target.value ? e.target.value.split('\n') : [])}
            />
          </Field>
          <Field label="Speaker notes">
            <textarea
              rows={5}
              maxLength={4000}
              value={slide.notes}
              onChange={(e) => update('notes', e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <>
          <div className="artifact-slide" role="region" aria-label={`Slide ${active + 1}`}>
            <small>
              RELAY · {active + 1} / {data.slides.length}
            </small>
            <h2>{slide.title}</h2>
            <ul>
              {slide.bullets.map((b: string, i: number) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
          {slide.notes && (
            <details className="artifact-notes">
              <summary>Speaker notes</summary>
              <p>{slide.notes}</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
type ArtifactProps = { id: string; versionNumber?: number };
export default function ArtifactView(props: ArtifactProps) {
  const { s } = useWorkspace();
  const artifact = s.artifacts?.find((item) => item.id === props.id);
  if (
    props.id !== 'new' &&
    (!artifact ||
      (props.versionNumber &&
        !artifact.versions.some((v: { number: number }) => v.number === props.versionNumber)))
  )
    return <p>This result or version is no longer available.</p>;
  // A navigation can arrive before its workspace update. Mount the editor only
  // once its saved source exists, so delayed data cannot become an empty draft.
  return <ArtifactContent {...props} />;
}
function ArtifactContent({ id, versionNumber }: ArtifactProps) {
  const { s, go, openArtifact, act } = useWorkspace();
  const artifact = s.artifacts?.find((a) => a.id === id);
  const baseVersion = useRef(versionNumber || artifact?.versions.at(-1)?.number);
  const version = artifact?.versions.find((v: any) => v.number === baseVersion.current);
  const fresh = id === 'new';
  const draftKey = `relay-result-draft:${id}:${version?.number || 0}`;
  const initial = useMemo(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (
        draft &&
        Object.hasOwn(artifactKinds, draft.kind) &&
        typeof draft.title === 'string' &&
        typeof draft.source === 'string'
      )
        return { ...draft, edit: true };
    } catch {}
    return {
      kind: artifact?.kind || 'document',
      title: version?.title || 'Untitled result',
      source: version?.source || starters.document,
      edit: fresh,
    };
  }, []);
  const [kind, setKind] = useState<Kind>(initial.kind),
    [title, setTitle] = useState(initial.title),
    [source, setSource] = useState(initial.source);
  const [edit, setEdit] = useState(initial.edit),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewRunning, setPreviewRunning] = useState(true),
    [previewKey, setPreviewKey] = useState(0);
  const saveOperation = useRef<{ payload: string; id: string } | null>(initial.operation || null);
  const dirty =
    title !== (version?.title || 'Untitled result') ||
    source !== (version?.source || starters.document) ||
    kind !== (artifact?.kind || 'document');
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ kind, title, source, operation: saveOperation.current }),
        );
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [kind, title, source, dirty, draftKey]);
  const frameHtml = useMemo(() => (kind === 'web' ? previewHtml(source) : ''), [kind, source]);
  let data: any = null;
  try {
    if (kind === 'spreadsheet' || kind === 'presentation') data = JSON.parse(source);
  } catch {}
  if (!fresh && !version) return <p>This result or version is no longer available.</p>;
  const file = s.files.find((f) => f.id === version?.fileId);
  async function save() {
    setBusy(true);
    setError('');
    setStatus('');
    const payload = {
      kind,
      title,
      source,
      ...(!fresh
        ? {
            id,
            expectedVersion: version.number,
          }
        : {}),
    };
    const serialized = JSON.stringify(payload);
    if (saveOperation.current?.payload !== serialized)
      saveOperation.current = { payload: serialized, id: crypto.randomUUID() };
    try {
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ kind, title, source, operation: saveOperation.current }),
        );
      } catch {}
      const { result } = await api.request('/artifacts', {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ ...payload, operationId: saveOperation.current!.id }),
      });
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      await api.refresh();
      setStatus('Version saved.');
      setEdit(false);
      openArtifact(result.id, result.version);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="artifact-view" aria-label="Result viewer">
      <header className="artifact-header">
        <div className="artifact-heading">
          <div>
            <p>
              {artifactKinds[kind].label}
              {fresh || dirty
                ? ' · Draft'
                : version
                  ? `${artifact!.versions.length > 1 ? ` · Version ${version.number}` : ''} · ${dateTime(version.createdAt)}`
                  : ''}
            </p>
            <h2>{title}</h2>
          </div>
          {!edit && (
            <button
              className="icon-button artifact-edit"
              aria-label="Edit result"
              title="Edit result"
              disabled={busy}
              onClick={() => setEdit(true)}
            >
              <PencilSimple size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="artifact-actions artifact-primary-actions">
          {file && !dirty && !edit && (
            <FileDownload
              className="primary-button"
              href={`/api/files/${file.id}`}
              name={file.name}
              mime={file.mime}
              bytes={() => fileBytes(file)}
            >
              Download {artifactKinds[kind].extension.toUpperCase()}
            </FileDownload>
          )}
          {file && !dirty && !edit && <AskAboutFile id={file.id} />}
          {edit && (
            <button className="secondary-button" disabled={busy} onClick={() => setEdit(false)}>
              <Eye size={17} /> Preview
            </button>
          )}
          {!fresh && artifact!.versions.length > 1 && (
            <label className="artifact-version-label">
              Version
              <select
                aria-label="Result version"
                disabled={dirty || busy}
                value={version.number}
                onChange={(e) => openArtifact(id, Number(e.target.value))}
              >
                {artifact!.versions.map((v: any) => (
                  <option key={v.number} value={v.number}>
                    {v.number}
                    {v.number === artifact!.versions.at(-1).number ? ' · Latest' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>
      {version && version.number !== artifact!.versions.at(-1).number && (
        <p className="artifact-info">
          You’re viewing an earlier version.{' '}
          <button
            className="text-button"
            disabled={dirty}
            onClick={() => openArtifact(id, artifact!.versions.at(-1).number)}
          >
            Open latest version
          </button>
        </p>
      )}
      {error && (
        <p className="artifact-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      <fieldset className="artifact-content-fields" disabled={busy}>
        {edit && (
          <div className="artifact-fields">
            {fresh && (
              <Field label="Result type">
                <select
                  value={kind}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as Kind;
                    setKind(next);
                    setSource(starters[next]);
                  }}
                >
                  {Object.entries(artifactKinds).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Result title">
              <input
                maxLength={120}
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          </div>
        )}
        {kind === 'document' ? (
          edit ? (
            <Field label="Document text (Markdown)">
              <textarea
                className="artifact-source"
                value={source}
                maxLength={200000}
                onChange={(e) => setSource(e.target.value)}
              />
            </Field>
          ) : (
            <div className="artifact-document markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt, src }) => <span>Image reference: {alt || src}</span>,
                  a: (p) => <a {...p} target="_blank" rel="noreferrer" />,
                }}
              >
                {source}
              </ReactMarkdown>
            </div>
          )
        ) : kind === 'spreadsheet' && data ? (
          <Spreadsheet
            data={data}
            edit={edit}
            change={(next) => setSource(JSON.stringify(next, null, 2))}
          />
        ) : kind === 'presentation' && data ? (
          <Presentation
            data={data}
            edit={edit}
            change={(next) => setSource(JSON.stringify(next, null, 2))}
          />
        ) : kind === 'web' ? (
          edit ? (
            <Field label="Page source (HTML, CSS, JavaScript)">
              <textarea
                className="artifact-source"
                value={source}
                maxLength={200000}
                spellCheck={false}
                onChange={(e) => setSource(e.target.value)}
              />
            </Field>
          ) : (
            <div className="artifact-web">
              <div className="artifact-actions">
                <span className="form-note">
                  {isNativeMobile
                    ? 'Open the preview to use this page.'
                    : 'Offline preview · Scripts run inside this frame.'}
                </span>
                {isNativeMobile && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setError('');
                      if (!hasNativeResults()) {
                        setError('Update the Relay phone app to open interactive previews.');
                        return;
                      }
                      void mobileResults
                        .preview({ title, source })
                        .catch((cause) =>
                          setError(
                            cause instanceof Error ? cause.message : 'The preview could not open.',
                          ),
                        );
                    }}
                  >
                    Open interactive preview
                  </button>
                )}
                {!isNativeMobile && (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() => setPreviewRunning(!previewRunning)}
                    >
                      {previewRunning ? 'Stop preview' : 'Start preview'}
                    </button>
                    {previewRunning && (
                      <button className="text-button" onClick={() => setPreviewKey((k) => k + 1)}>
                        Restart
                      </button>
                    )}
                  </>
                )}
              </div>
              {previewRunning ? (
                <iframe
                  key={previewKey}
                  title={`${title} ${isNativeMobile ? 'static' : 'interactive'} preview`}
                  inert={isNativeMobile || undefined}
                  sandbox={isNativeMobile ? '' : 'allow-scripts'}
                  referrerPolicy="no-referrer"
                  allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'"
                  srcDoc={frameHtml}
                />
              ) : (
                <p className="artifact-stopped">Preview stopped. Your saved result is unchanged.</p>
              )}
            </div>
          )
        ) : (
          <p role="alert">This content could not be opened.</p>
        )}
      </fieldset>
      {(edit || dirty || fresh) && (
        <footer className="artifact-save">
          <span className="form-note">
            {dirty ? 'Draft kept on this device. ' : ''}
            {fresh
              ? 'Save to add this result to Files.'
              : `Saving creates a new version. Version ${version.number} stays available.`}
          </span>
          <div className="artifact-actions">
            {dirty && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setKind(artifact?.kind || 'document');
                  setTitle(version?.title || 'Untitled result');
                  setSource(version?.source || starters.document);
                  setError('');
                }}
              >
                Discard edits
              </button>
            )}
            <button
              className="primary-button"
              disabled={
                busy ||
                (!fresh && !dirty) ||
                (!fresh && version.number !== artifact!.versions.at(-1).number)
              }
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : fresh ? 'Save result' : 'Save new version'}
            </button>
          </div>
        </footer>
      )}
      {!fresh && (
        <details className="artifact-notes">
          <summary>Manage result</summary>
          {confirmRemove ? (
            <div className="artifact-actions">
              <span>Remove this result and all its versions?</span>
              <button
                className="danger-button"
                onClick={async () => {
                  if (await act('artifact.delete', { id })) {
                    try {
                      sessionStorage.removeItem(draftKey);
                    } catch {}
                    go('files');
                  }
                }}
              >
                Remove result
              </button>
              <button className="secondary-button" onClick={() => setConfirmRemove(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button className="text-button danger-text" onClick={() => setConfirmRemove(true)}>
              Remove result
            </button>
          )}
        </details>
      )}
    </article>
  );
}
