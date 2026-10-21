import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { backupFileBridge, saveNativeBackup } from '../backup-transfer';
import { BACKUP_FILENAME, BACKUP_MAGIC, MAX_BACKUP_BYTES } from '../../shared/computer-backup.mjs';
import { toBase64 } from '../../shared/pdf.mjs';
type Ticket = { id: string; phase: string; size: number; error: string };
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 500);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
export default function ComputerBackupForm({
  kind,
  pointId,
  onClose,
  onImported,
}: {
  kind: 'export' | 'import';
  pointId?: string;
  onClose(): void;
  onImported(id: string): void;
}) {
  const [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState('');
  const [file, setFile] = useState<File | null>(null),
    [ready, setReady] = useState<Ticket | null>(null);
  const [completed, setCompleted] = useState(false);
  const readyTicket = useRef<Ticket | null>(null),
    browserDownload = useRef(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null),
    download = useRef(''),
    mounted = useRef(true),
    lock = useRef(false);
  async function release() {
    const id = download.current;
    download.current = '';
    if (id)
      await api
        .request(`/computer/backups/downloads/${id}/cancel`, { method: 'POST', body: '{}' })
        .catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      if (!browserDownload.current) void release();
    };
  }, []);
  async function save(ticket: Ticket, signal: AbortSignal) {
    const bridge = backupFileBridge();
    if (bridge) {
      const result = await saveNativeBackup(ticket, bridge, signal, (bytes) =>
        setMessage(`Saving to your device… ${Math.floor((bytes / ticket.size) * 100)}%`),
      );
      if (result.status === 'saved') {
        await release();
        setReady(null);
        readyTicket.current = null;
        setCompleted(true);
        setMessage('Backup saved. Keep its password somewhere safe.');
      } else setMessage('Save cancelled. Your backup is ready if you want to try again.');
    } else {
      await api.request(`/computer/backups/downloads/${ticket.id}`);
      browserDownload.current = true;
      const link = document.createElement('a');
      link.href = `/api/computer/backups/downloads/${ticket.id}/file?download=1`;
      link.download = BACKUP_FILENAME;
      document.body.append(link);
      link.click();
      link.remove();
      setMessage('Backup download started. Keep the file and its password somewhere safe.');
    }
  }
  async function submit() {
    if (lock.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    const passwordBytes = new TextEncoder().encode(password);
    if (!ready && (passwordBytes.length < 12 || passwordBytes.length > 1024)) {
      setError(
        kind === 'import'
          ? 'Enter the password used for this backup.'
          : passwordBytes.length > 1024
            ? 'Use a shorter backup password.'
            : 'Use a longer password (at least 12 characters).',
      );
      return;
    }
    if (!ready && kind === 'export' && password !== repeat) {
      setError('The passwords do not match.');
      return;
    }
    if (kind === 'import' && !file) {
      setError('Choose your Relay backup file.');
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      if (kind === 'import') {
        if (
          file!.size < 60 ||
          file!.size > MAX_BACKUP_BYTES ||
          new TextDecoder().decode(await file!.slice(0, 16).arrayBuffer()) !== BACKUP_MAGIC
        )
          throw Error('Choose a complete Relay computer backup file.');
        setMessage('Importing your backup…');
        const response = await api.fetch('/computer/backups/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Relay-Backup-Password': toBase64(passwordBytes)
              .replaceAll('+', '-')
              .replaceAll('/', '_')
              .replace(/=+$/, ''),
          },
          body: file!,
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'The backup could not be imported.');
        if (!result.point?.id)
          throw Error(
            'Relay did not confirm the backup. Check your restore points before trying again.',
          );
        setPassword('');
        onImported(result.point.id);
        return;
      }
      let ticket = ready;
      if (!ticket) {
        setMessage(
          pointId ? 'Preparing your backup…' : 'Saving your files and preparing a backup…',
        );
        // Retain the returned ticket even if Cancel is pressed during this short request.
        const initial = await api.request('/computer/backups/downloads', {
          method: 'POST',
          body: JSON.stringify({ pointId, password }),
        });
        download.current = initial.id;
        controller.signal.throwIfAborted();
        ticket = initial;
        while (ticket!.phase === 'preparing') {
          await pause(controller.signal);
          ticket = await api.request(`/computer/backups/downloads/${initial.id}`, {
            signal: controller.signal,
          });
        }
        if (ticket!.phase !== 'ready')
          throw Error(ticket!.error || 'The backup could not be prepared.');
        setReady(ticket);
        readyTicket.current = ticket;
        setPassword('');
        setRepeat('');
      }
      await save(ticket!, controller.signal);
    } catch (e: any) {
      if (controller.signal.aborted) {
        await release();
        if (mounted.current) {
          setReady(null);
          readyTicket.current = null;
          browserDownload.current = false;
          setMessage('Backup cancelled. Your saved files are kept.');
        }
      } else if (mounted.current) {
        if (e.status === 404) {
          setReady(null);
          readyTicket.current = null;
          browserDownload.current = false;
        }
        if (!readyTicket.current) await release();
        setError(e.message || 'The backup transfer was interrupted. Try again.');
        setMessage('');
        if (!ready && !download.current) setReady(null);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form
      className="computer-backup-form"
      aria-label={kind === 'export' ? 'Save computer backup' : 'Import computer backup'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{kind === 'export' ? 'Save a computer backup' : 'Import a computer backup'}</h3>
      <p>
        {kind === 'export'
          ? 'Keep a copy of saved files and the browser profile on your device. Unsaved work is not included. Relay stays paused until you give control back.'
          : 'Choose a backup and enter its password. You’ll review the restore before changing your computer.'}
      </p>
      {kind === 'import' && (
        <label>
          Backup file
          <input
            type="file"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setError('');
            }}
          />
        </label>
      )}
      {!ready && !completed && (
        <>
          <label>
            {kind === 'export' ? 'New backup password' : 'Backup password'}
            <input
              type="password"
              value={password}
              disabled={busy}
              maxLength={1024}
              autoComplete={kind === 'export' ? 'new-password' : 'off'}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
            />
          </label>
          {kind === 'export' && (
            <>
              <label>
                Repeat password
                <input
                  type="password"
                  value={repeat}
                  disabled={busy}
                  maxLength={1024}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setRepeat(e.target.value);
                    setError('');
                  }}
                />
              </label>
              <small>
                Use at least 12 characters. Keep the password separately; Relay can’t recover it.
              </small>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="computer-care-actions">
        {!completed && (
          <button className="primary-button" disabled={busy} type="submit">
            {busy
              ? 'Working…'
              : kind === 'import'
                ? 'Import & review'
                : ready
                  ? 'Save file'
                  : 'Save backup'}
          </button>
        )}
        {busy ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              operation.current?.abort();
              setMessage('Cancelling…');
            }}
          >
            Cancel transfer
          </button>
        ) : (
          <button className="text-button" type="button" onClick={onClose}>
            Back to restore points
          </button>
        )}
      </div>
    </form>
  );
}
