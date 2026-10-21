import MediaPreview from './MediaPreview';
import { mediaKind } from '../../shared/media-files.mjs';
import { useEffect, useId, useState } from 'react';
import { FileText, ImageSquare, X, FilmStrip, MusicNote } from '@phosphor-icons/react';
import { fileBytes } from '../../shared/pdf.mjs';
import { useWorkspace } from '../context';
import type { Entity } from '../types';
import './attachments.css';

export const isPhoto = (file?: Entity) =>
  !!file && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mime);

function Photo({ file }: { file: Entity }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    let object = '';
    setUrl('');
    setFailed(false);
    setLoaded(false);
    void fileBytes(file)
      .then((bytes) => {
        if (!alive) return;
        object = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mime }));
        setUrl(object);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [file.id, file.updatedAt, file.base64]);
  return (
    <span className={`attachment-photo ${loaded ? 'is-loaded' : ''}`}>
      {url && !failed && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {!loaded && !failed && <span className="photo-placeholder" aria-hidden="true" />}
      {failed && (
        <span className="photo-unavailable">
          <ImageSquare size={24} aria-hidden="true" />
          <span>Preview unavailable</span>
        </span>
      )}
    </span>
  );
}

export default function AttachmentList({
  ids,
  draft = false,
  onRemove,
}: {
  ids: string[];
  draft?: boolean;
  onRemove?: (id: string) => void;
}) {
  const { s, openFile } = useWorkspace();
  const groupId = useId();
  const entries = ids.map((id) => ({ id, file: s.files.find((file) => file.id === id) }));
  const photos = entries.filter(({ file }) => isPhoto(file));
  const media = entries.filter(({ file }) => !!mediaKind(file));
  const documents = entries.filter(({ file }) => !isPhoto(file) && (draft || !mediaKind(file)));
  function attachment({ id, file }: (typeof entries)[number]) {
    const photo = isPhoto(file);
    const name = file?.name || 'Attachment unavailable';
    const nameId = `${groupId}-${id}`;
    return (
      <div className={`attachment-item ${photo ? 'is-photo' : 'is-document'}`} key={id}>
        <button
          type="button"
          className="attachment-open"
          aria-label={`Open ${name}`}
          onClick={() => openFile(id)}
          title={name}
        >
          {photo ? (
            <Photo file={file!} />
          ) : mediaKind(file) === 'video' ? (
            <FilmStrip size={18} aria-hidden="true" />
          ) : mediaKind(file) === 'audio' ? (
            <MusicNote size={18} aria-hidden="true" />
          ) : (
            <FileText size={18} aria-hidden="true" />
          )}
          <span className="attachment-name" id={nameId}>
            {name}
          </span>
        </button>
        {onRemove && (
          <button
            type="button"
            className="attachment-remove"
            aria-label="Remove attachment"
            aria-describedby={nameId}
            title={`Remove ${name}`}
            onClick={() => onRemove(id)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
  if (!entries.length) return null;
  return (
    <div
      className={`attachment-list photo-attachments ${draft ? 'draft-attachments' : 'message-attachments'}`}
      role="group"
      aria-label={draft ? 'Draft attachments' : 'Attachments'}
    >
      {photos.length > 0 && (
        <div className={`attachment-photos ${photos.length === 1 ? 'single-photo' : 'photo-grid'}`}>
          {photos.map(attachment)}
        </div>
      )}
      {!draft && media.length > 0 && (
        <div className="attachment-media">
          {media.map(({ id, file }) => (
            <div className="attachment-item" key={id}>
              <button
                className="attachment-open"
                aria-label={`Open ${file!.name}`}
                onClick={() => openFile(id)}
              >
                {mediaKind(file) === 'video' ? <FilmStrip size={18} /> : <MusicNote size={18} />}
                <span className="attachment-name">{file!.name}</span>
              </button>
              <MediaPreview file={file!} />
            </div>
          ))}
        </div>
      )}
      {documents.length > 0 && (
        <div className="attachment-documents">{documents.map(attachment)}</div>
      )}
    </div>
  );
}
