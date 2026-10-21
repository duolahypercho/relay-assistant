import { useRef, useState, type ReactNode } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import { isNativeMobile, hasNativeResults, mobileResults } from '../native-mobile';
import { toBase64 } from '../../shared/pdf.mjs';

// Browser downloads keep the normal link behavior. Phones use the system's
// destination picker; no download is reported complete until native saving ends.
export default function FileDownload({
  href,
  name,
  mime,
  bytes,
  children = 'Download',
  className = 'secondary-button',
  label,
}: {
  href?: string;
  name: string;
  mime: string;
  bytes?: () => Promise<Uint8Array>;
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (!hasNativeResults()) throw new Error('Update the Relay phone app to save files.');
      let data: Uint8Array;
      if (bytes) data = await bytes();
      else {
        if (!href) throw new Error('This file is unavailable.');
        const response = await fetch(href, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new Error('This file could not be downloaded. Check your connection.');
        if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024)
          throw new Error('Save files of 8 MB or less on this device.');
        const body = await response.blob();
        if (body.size > 8 * 1024 * 1024)
          throw new Error('Save files of 8 MB or less on this device.');
        data = new Uint8Array(await body.arrayBuffer());
      }
      if (data.byteLength > 8 * 1024 * 1024)
        throw new Error('Save files of 8 MB or less on this device.');
      const result = await mobileResults.save({ name, mime, base64: toBase64(data) });
      if (result.status === 'saved') setMessage('File saved.');
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'The file could not be saved.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!isNativeMobile)
    return (
      <a className={className} href={href} download={name} aria-label={label}>
        <DownloadSimple size={17} />
        {children}
      </a>
    );
  return (
    <span className="file-download-native">
      <button
        className={className}
        disabled={busy}
        onClick={() => void save()}
        aria-label={label ? label.replace('Download', 'Save') : undefined}
      >
        <DownloadSimple size={17} />
        {className === 'icon-button' ? null : busy ? 'Saving…' : 'Save file'}
      </button>
      {message && (
        <span className="form-note" role={failed ? 'alert' : 'status'}>
          {message}
        </span>
      )}
    </span>
  );
}
