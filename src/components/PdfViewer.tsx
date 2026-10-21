import { useState, useEffect, useRef } from 'react';
import {
  CaretLeft,
  CaretRight,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
} from '@phosphor-icons/react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fileBytes } from '../../shared/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfViewer({ file }: { file: any }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let task: pdfjs.PDFDocumentLoadingTask | undefined;
    setLoading(true);
    void fileBytes(file)
      .then((bytes) => {
        if (!alive) return;
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        return task.promise;
      })
      .then((d) => {
        if (alive && d) setDoc(d);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [file.id]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let render: pdfjs.RenderTask | undefined,
      active = true;
    setLoading(true);
    void doc
      .getPage(page)
      .then((p) => {
        if (!active || !canvas.current) return;
        const base = p.getViewport({ scale: 1 });
        const available = Math.min(760, (wrapper.current?.clientWidth || 760) - 32);
        const view = p.getViewport({ scale: ((available / base.width) * zoom) / 100 });
        const pixelRatio = window.devicePixelRatio || 1;
        const target = canvas.current;
        target.width = Math.floor(view.width * pixelRatio);
        target.height = Math.floor(view.height * pixelRatio);
        target.style.width = `${view.width}px`;
        target.style.height = `${view.height}px`;
        render = p.render({
          canvas: target,
          viewport: view,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
        });
        return render.promise;
      })
      .then(() => {
        if (active) setLoading(false);
      })
      .catch((e) => {
        if (active && e.name !== 'RenderingCancelledException') setError(e.message);
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [doc, page, zoom]);
  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div>
          <button
            className="icon-button"
            aria-label="Previous PDF page"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <CaretLeft size={20} />
          </button>
          <span>
            Page {page} of {doc?.numPages || '…'}
          </span>
          <button
            className="icon-button"
            aria-label="Next PDF page"
            disabled={!doc || page >= doc.numPages}
            onClick={() => setPage(page + 1)}
          >
            <CaretRight size={20} />
          </button>
        </div>
        <div>
          <button
            className="icon-button"
            aria-label="Zoom out"
            disabled={zoom <= 50}
            onClick={() => setZoom(zoom - 25)}
          >
            <MagnifyingGlassMinus size={20} />
          </button>
          <span>{zoom}%</span>
          <button
            className="icon-button"
            aria-label="Zoom in"
            disabled={zoom >= 200}
            onClick={() => setZoom(zoom + 25)}
          >
            <MagnifyingGlassPlus size={20} />
          </button>
        </div>
      </div>
      <div
        className="pdf-canvas-wrap"
        ref={wrapper}
        tabIndex={0}
        role="region"
        aria-label="PDF page preview"
      >
        {error ? (
          <p role="alert">
            This document could not be rendered: {error}. You can still download the file.
          </p>
        ) : (
          <>
            <canvas ref={canvas} aria-label={`${file.name}, page ${page}`} />
            {loading && <span className="pdf-loading">Rendering document…</span>}
          </>
        )}
      </div>
    </div>
  );
}
