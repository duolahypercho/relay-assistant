import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import './office-preview.css';
type Preview = {
  text: string;
  kind: string;
  contentHash: string;
  totalLength: number;
  nextOffset: number | null;
  warnings: string[];
};
export default function OfficePreview({ file, snapshot }: { file: any; snapshot: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const supported = api.mode() === 'server' && !snapshot;
  async function load(next = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const query =
        next && preview ? `?offset=${preview.nextOffset}&contentHash=${preview.contentHash}` : '';
      const result: Preview = await api.request(
        `/files/${encodeURIComponent(file.id)}/office${query}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setPreview((old) => ({
          ...result,
          text: next && old ? old.text + result.text : result.text,
        }));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'This file could not be previewed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (supported) void load();
    return () => request.current?.abort();
  }, [file.id, supported]);
  if (!supported)
    return (
      <p className="form-note">
        Download the original Office file to open it. Text previews are available for saved files on
        your Relay server.
      </p>
    );
  return (
    <section className="office-preview" aria-label="Office file text preview">
      <p className="form-note">
        Text preview · Download the original to see its full layout, images and charts.
      </p>
      {preview && (
        <>
          <pre>{preview.text || 'No readable text was found in this file.'}</pre>
          <details>
            <summary>About this preview</summary>
            {preview.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </details>
          {preview.nextOffset !== null && (
            <p className="form-note">
              Showing {preview.text.length.toLocaleString()} of{' '}
              {preview.totalLength.toLocaleString()} characters.
            </p>
          )}
        </>
      )}
      {loading && <p role="status">{preview ? 'Reading more…' : 'Opening the file…'}</p>}
      {error && <p role="alert">{error}</p>}
      {error ? (
        <button className="secondary-button" disabled={loading} onClick={() => void load(false)}>
          Open preview again
        </button>
      ) : (
        preview?.nextOffset !== null &&
        preview && (
          <button className="secondary-button" disabled={loading} onClick={() => void load(true)}>
            Read more
          </button>
        )
      )}
    </section>
  );
}
