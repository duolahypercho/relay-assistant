// The mounted chat owns unsaved attachments, including uploads still finishing.
// Request a synchronous merge there instead of overwriting a debounced server draft.
export const fileDraftEvent = 'relay:attach-saved-file';
export type FileDraftRequest = {
  threadId: string;
  fileId: string;
  accepted?: boolean;
  error?: string;
};
export function requestFileDraft(threadId: string, fileId: string) {
  const detail: FileDraftRequest = { threadId, fileId };
  window.dispatchEvent(new CustomEvent(fileDraftEvent, { detail }));
  if (!detail.accepted)
    throw new Error(detail.error || 'Open your chat and try adding this file again.');
}
