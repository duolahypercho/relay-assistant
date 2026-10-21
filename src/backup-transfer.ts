import { isNativeMobile, mobileResults } from './native-mobile';
import { api } from './api';
import { toBase64 } from '../shared/pdf.mjs';
import { BACKUP_CHUNK_BYTES, MAX_BACKUP_BYTES } from '../shared/computer-backup.mjs';
export type BackupFileBridge = {
  begin(): Promise<{ id: string }>;
  append(options: { id: string; offset: number; base64: string }): Promise<{ bytes: number }>;
  save(options: { id: string; size: number }): Promise<{ status: 'saved' | 'cancelled' }>;
  cancel(options: { id: string }): Promise<unknown>;
};
export function backupFileBridge(): BackupFileBridge | undefined {
  if (isNativeMobile)
    return {
      begin: () => mobileResults.beginBackup(),
      append: (input) => mobileResults.appendBackup(input),
      save: (input) => mobileResults.saveBackup(input),
      cancel: (input) => mobileResults.cancelBackup(input),
    };
  return (window as any).relayNative?.backups;
}
export async function saveNativeBackup(
  ticket: { id: string; size: number },
  bridge: BackupFileBridge,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  if (!Number.isSafeInteger(ticket.size) || ticket.size < 60 || ticket.size > MAX_BACKUP_BYTES)
    throw Error('Choose a complete Relay backup.');
  const stage = await bridge.begin();
  let saved = false,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await api.fetch(`/computer/backups/downloads/${ticket.id}/file`, { signal });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('content-length')) !== ticket.size
    )
      throw Object.assign(Error('This backup download expired. Prepare it again.'), {
        status: response.status === 404 ? 404 : undefined,
      });
    reader = response.body.getReader();
    let pending = new Uint8Array(BACKUP_CHUNK_BYTES),
      filled = 0,
      total = 0;
    async function send() {
      signal.throwIfAborted();
      const result = await bridge.append({
        id: stage.id,
        offset: total,
        base64: toBase64(pending.subarray(0, filled)),
      });
      total += filled;
      if (result.bytes !== total)
        throw Error('The backup transfer was interrupted. Try saving again.');
      filled = 0;
      progress(total);
    }
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      let offset = 0;
      if (total + filled + next.value.length > ticket.size)
        throw Error('The backup is larger than expected. Prepare it again.');
      while (offset < next.value.length) {
        const take = Math.min(pending.length - filled, next.value.length - offset);
        pending.set(next.value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === pending.length) await send();
      }
    }
    if (filled) await send();
    if (total !== ticket.size)
      throw Error('The backup download was interrupted. Try saving again.');
    signal.throwIfAborted();
    const result = await bridge.save({ id: stage.id, size: total });
    saved = true;
    return result;
  } finally {
    await reader?.cancel().catch(() => {});
    if (!saved) await bridge.cancel({ id: stage.id }).catch(() => {});
  }
}
