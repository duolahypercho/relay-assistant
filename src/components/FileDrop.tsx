import { useEffect, useRef, useState, type DragEvent } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import './file-drop.css';

const carriesFiles = (data: DataTransfer | null) =>
  !!data && Array.from(data.types).includes('Files');

// Unhandled local-file drops must never navigate away from an unfinished draft.
export function usePreventFileNavigation() {
  useEffect(() => {
    const prevent = (event: globalThis.DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
}

export function useFileDrop(
  onFiles: (files: File[]) => Promise<void>,
  onError: (message: string) => void,
  available = true,
) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') reset();
    };
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  return {
    dragging,
    dropProps: {
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = available ? 'copy' : 'none';
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!carriesFiles(event.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        reset();
        if (!available) return;
        const items = Array.from(event.dataTransfer.items || []);
        if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
          onError('Choose individual files. Folders cannot be added yet.');
          return;
        }
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void onFiles(files).catch((e: Error) => onError(e.message));
      },
    },
  };
}

export default function FileDrop({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="file-drop-overlay" role="status">
      <UploadSimple size={32} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  );
}

export function validateFileBatch(files: File[], maximum = 8, size = 8 * 1024 * 1024) {
  if (files.length > maximum)
    throw new Error(
      maximum > 0
        ? `You can add ${maximum} more ${maximum === 1 ? 'file' : 'files'} at a time.`
        : 'Remove an attachment before adding another.',
    );
  const large = files.find((file) => file.size > size);
  if (large) throw new Error(`${large.name} is too large. Use files smaller than 8 MB.`);
}

export function availableFilename(original: string, names: Set<string>) {
  const sanitized = original.replace(/[\x00-\x1f/\\]/g, '_').trim();
  let clean = '';
  const encoder = new TextEncoder();
  for (const letter of sanitized) {
    if (encoder.encode(clean + letter).length > 180) break;
    clean += letter;
  }
  const name = !clean || /^\.+$/.test(clean) ? 'Untitled file' : clean;
  const split = name.lastIndexOf('.');
  const stem = split > 0 ? name.slice(0, split) : name;
  const extension = split > 0 ? name.slice(split) : '';
  let next = name;
  for (let n = 2; names.has(next); n++) next = `${stem} (${n})${extension}`;
  names.add(next);
  return next;
}
