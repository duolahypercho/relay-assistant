import { writeSkillPackage } from '../../shared/skill-archive.mjs';
import SkillFiles from './SkillFiles';
import { skillBase64, SKILL_ZIP_LIMIT } from '../../shared/skill-package.mjs';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, UploadSimple } from '@phosphor-icons/react';
import { useWorkspace } from '../context';
import { api } from '../api';
import { Field } from './ui';
import FileDownload from './FileDownload';
import {
  readSkillDocument,
  writeSkillDocument,
  SKILL_DOCUMENT_LIMIT,
} from '../../shared/skill-document.mjs';
import { availableSkillSlug } from '../../shared/skill-metadata.mjs';
import type { Entity } from '../types';
export default function SkillTransfer({
  exporting,
  onClose,
}: {
  exporting?: Entity;
  onClose: () => void;
}) {
  const { s, toast } = useWorkspace();
  const [initial] = useState(() => {
    try {
      return { text: exporting ? writeSkillDocument(exporting) : '', error: '' };
    } catch (e) {
      return { text: '', error: (e as Error).message };
    }
  });
  const [text, setText] = useState(initial.text);
  const [showInstructions, setShowInstructions] = useState(!!exporting || api.mode() !== 'server');
  const [files, setFiles] = useState<{ path: string; base64: string }[]>(exporting?.files || []);
  const [downloadBytes, setDownloadBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [downloadName, setDownloadName] = useState('SKILL.md');
  const [review, setReview] = useState<ReturnType<typeof readSkillDocument> | null>(null);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [download, setDownload] = useState('');
  const [reviewedText, setReviewedText] = useState('');
  const [repositoryLink, setRepositoryLink] = useState('');
  const [source, setSource] = useState<{ repository: string; commit: string; url: string } | null>(
    null,
  );
  const repositoryRequest = useRef<AbortController | null>(null);
  const generation = useRef(0),
    pending = useRef(false),
    input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      generation.current++;
      repositoryRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!reviewedText) {
      setDownload('');
      setDownloadBytes(null);
      return;
    }
    const parsed = readSkillDocument(reviewedText);
    const bytes = files.length
      ? writeSkillPackage({ ...parsed, files }, reviewedText)
      : new TextEncoder().encode(reviewedText);
    setDownloadBytes(bytes);
    setDownloadName(files.length ? `${parsed.slug}.zip` : 'SKILL.md');
    const url = URL.createObjectURL(
      new Blob([bytes], { type: files.length ? 'application/zip' : 'text/markdown;charset=utf-8' }),
    );
    setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [reviewedText, files]);
  async function read(file?: File) {
    if (!file) return;
    repositoryRequest.current?.abort();
    setSource(null);
    const ticket = ++generation.current;
    setReading(true);
    setError('');
    setText('');
    setFiles([]);
    setReview(null);
    setReviewedText('');
    try {
      const zipped = /\.zip$/i.test(file.name);
      if (file.size > (zipped ? SKILL_ZIP_LIMIT : SKILL_DOCUMENT_LIMIT))
        throw Error(
          zipped
            ? 'Choose a skill ZIP of up to 2 MB.'
            : 'Choose a skill instructions file smaller than 64 KB.',
        );
      if (!/\.(md|zip)$/i.test(file.name)) throw Error('Choose SKILL.md or a skill ZIP.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const content = zipped
        ? await api.request('/skills/package', {
            method: 'POST',
            body: JSON.stringify({ base64: skillBase64(bytes) }),
          })
        : { document: new TextDecoder('utf-8', { fatal: true }).decode(bytes), files: [] };
      readSkillDocument(content.document);
      if (ticket === generation.current) {
        setText(content.document);
        setShowInstructions(true);
        setFiles(content.files);
      }
    } catch (e) {
      if (ticket === generation.current)
        setError(e instanceof Error ? e.message : 'This skill file could not be read.');
    } finally {
      if (ticket === generation.current) {
        setReading(false);
        if (input.current) input.current.value = '';
      }
    }
  }
  function cancelRepository() {
    generation.current++;
    repositoryRequest.current?.abort();
    repositoryRequest.current = null;
    setReading(false);
  }
  async function loadRepository() {
    repositoryRequest.current?.abort();
    const controller = new AbortController();
    repositoryRequest.current = controller;
    const ticket = ++generation.current;
    setReading(true);
    setError('');
    setSource(null);
    setText('');
    setFiles([]);
    setReview(null);
    setReviewedText('');
    try {
      const content = await api.request('/skills/repository', {
        method: 'POST',
        body: JSON.stringify({ url: repositoryLink }),
        signal: controller.signal,
      });
      const parsed = readSkillDocument(content.document);
      parsed.slug = availableSkillSlug(s.skills || [], parsed.slug);
      if (ticket !== generation.current || controller.signal.aborted) return;
      setText(content.document);
      setFiles(content.files);
      setSource(content.source);
      setReview(parsed);
      setReviewedText(content.document);
    } catch (e) {
      if (ticket === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'This skill could not be downloaded.');
    } finally {
      if (ticket === generation.current) {
        setReading(false);
        repositoryRequest.current = null;
      }
    }
  }
  function prepare() {
    setError('');
    try {
      const parsed = readSkillDocument(text);
      if (!exporting) parsed.slug = availableSkillSlug(s.skills || [], parsed.slug);
      setReview(parsed);
      setReviewedText(text);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function add() {
    if (!review || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await api.act('skill.create', { ...review, ...(files.length ? { files } : {}) });
      toast('Skill added. Run it whenever you’re ready.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="skill-sheet" aria-labelledby="skill-transfer-heading">
      <button className="text-button" onClick={onClose} disabled={busy}>
        <ArrowLeft size={16} /> Back to skills
      </button>
      <h2 id="skill-transfer-heading">{exporting ? 'Share a skill' : 'Import a skill'}</h2>
      {(!review || exporting) && (
        <p className="form-note">
          {exporting
            ? 'Review the instructions and supporting files before downloading. Your saved skill stays unchanged.'
            : 'Paste a public GitHub skill link, choose a skill file or paste its instructions. Nothing runs during import.'}
        </p>
      )}
      {source && (
        <p className="form-note skill-repository-source">
          Source:{' '}
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.repository} · {source.commit.slice(0, 7)}
          </a>
          . A copy of this version; it won’t update automatically.
        </p>
      )}
      {!review ? (
        <>
          {!exporting && (
            <>
              {api.mode() === 'server' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!reading && repositoryLink.trim()) void loadRepository();
                  }}
                >
                  <Field
                    label="GitHub skill link"
                    hint="Use the skill folder or its SKILL.md page in a public repository."
                  >
                    <input
                      type="url"
                      value={repositoryLink}
                      placeholder="https://github.com/…/tree/main/my-skill"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={2000}
                      onChange={(event) => {
                        cancelRepository();
                        setRepositoryLink(event.target.value);
                        setError('');
                      }}
                    />
                  </Field>
                  <div className="routine-controls">
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={reading || !repositoryLink.trim()}
                    >
                      {reading && repositoryRequest.current ? 'Loading skill…' : 'Load skill'}
                    </button>
                    {reading && repositoryRequest.current && (
                      <button type="button" className="secondary-button" onClick={cancelRepository}>
                        Cancel download
                      </button>
                    )}
                  </div>
                </form>
              )}

              <input
                ref={input}
                type="file"
                hidden
                accept=".md,.zip,text/markdown,application/zip"
                aria-label="Choose skill file"
                onChange={(e) => void read(e.target.files?.[0])}
              />
              <button
                className="secondary-button skill-import-file"
                disabled={reading}
                onClick={() => input.current?.click()}
              >
                <UploadSimple size={17} />
                {reading ? 'Reading file…' : 'Choose skill file'}
              </button>
            </>
          )}
          {!showInstructions && !text && (
            <button
              className="text-button skill-import-paste"
              onClick={() => setShowInstructions(true)}
            >
              Paste instructions
            </button>
          )}
          {(showInstructions || !!text) && (
            <Field
              label="Skill file"
              hint={
                exporting
                  ? 'Includes the method, its metadata and any supporting files shown below.'
                  : 'You can also paste the complete file, including its name and description between --- lines.'
              }
            >
              <textarea
                value={text}
                onChange={(e) => {
                  cancelRepository();
                  setText(e.target.value);
                  setError('');
                }}
                rows={12}
                maxLength={64000}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </Field>
          )}
          <SkillFiles files={files} onChange={setFiles} />
          {(showInstructions || !!text) && (
            <button className="primary-button" disabled={!text.trim() || reading} onClick={prepare}>
              Review skill
            </button>
          )}
        </>
      ) : (
        <>
          <p className="form-note">
            {exporting
              ? 'This is the exact file that will be downloaded.'
              : 'Check the steps, then add the skill. A free shortcut is suggested automatically.'}
          </p>
          {exporting ? (
            <pre className="skill-source-preview">{reviewedText}</pre>
          ) : (
            <>
              <Field label="Skill name">
                <input
                  value={review.title}
                  maxLength={100}
                  onChange={(e) => setReview({ ...review, title: e.target.value })}
                />
              </Field>
              <Field label="Shortcut">
                <input
                  value={review.slug}
                  maxLength={64}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setReview({ ...review, slug: e.target.value })}
                />
              </Field>
              <Field label="When to use it">
                <textarea
                  value={review.description}
                  maxLength={1024}
                  rows={2}
                  onChange={(e) => setReview({ ...review, description: e.target.value })}
                />
              </Field>
              <Field label="Instructions">
                <textarea
                  value={review.instructions}
                  maxLength={12000}
                  rows={8}
                  onChange={(e) => setReview({ ...review, instructions: e.target.value })}
                />
              </Field>
              <details className="skill-method">
                <summary>About this file</summary>
                <dl>
                  {Object.entries({
                    License: review.documentMeta.license,
                    Requirements: review.documentMeta.compatibility,
                    'Requested tools': review.documentMeta.requestedTools,
                    ...review.documentMeta.metadata,
                  })
                    .filter(([key, value]) => value && !key.startsWith('relay-'))
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
              </details>
              <p className="form-note">
                Scripts run only when needed for your request, using the private computer. Actions
                keep their existing reviews.
              </p>
            </>
          )}
          <SkillFiles files={files} />
          <div className="routine-controls">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                if (!exporting && review) {
                  try {
                    setText(writeSkillDocument(review));
                  } catch (e) {
                    setError((e as Error).message);
                    return;
                  }
                }
                setReview(null);
                setReviewedText('');
                setError('');
              }}
            >
              Back to file
            </button>
            {exporting ? (
              <FileDownload
                href={download}
                name={downloadName}
                mime={files.length ? 'application/zip' : 'text/markdown'}
                bytes={async () => downloadBytes || new TextEncoder().encode(reviewedText)}
                label="Download reviewed skill"
              >
                Download reviewed file
              </FileDownload>
            ) : (
              <button className="primary-button" disabled={busy} onClick={() => void add()}>
                {busy ? 'Adding…' : 'Add skill'}
              </button>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
