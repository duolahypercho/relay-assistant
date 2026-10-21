// SPDX-License-Identifier: MIT
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { inspectPdf } from '../shared/pdf.mjs';
const assets = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
function asset(folder) {
  return fileURLToPath(new URL(`${folder}/`, assets));
}
async function pageText(page) {
  const stream = page.streamTextContent({ disableNormalization: false });
  const reader = stream.getReader();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
        if (text.length > 200000)
          throw Error('A PDF page contains too much text. Use a smaller copy.');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}
export async function parsePdfDocument({ bytes, page: requestedPage }) {
  const loading = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    maxImageSize: 16000000,
    canvasMaxAreaInBytes: 16000000,
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 500)
      throw Error('This PDF has more than 500 pages. Attach a smaller section.');
    if (requestedPage !== undefined) {
      if (requestedPage > pdf.numPages) throw Error('That page is outside this PDF.');
      const page = await pdf.getPage(requestedPage);
      const text = await pageText(page);
      const natural = page.getViewport({ scale: 1 });
      if (![natural.width, natural.height].every((x) => Number.isFinite(x) && x > 0))
        throw Error('This PDF page has invalid dimensions.');
      const scale = Math.min(2, 1600 / Math.max(natural.width, natural.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        background: 'rgb(255,255,255)',
      }).promise;
      const image = canvas.toBuffer('image/jpeg', 85);
      if (image.length > 2 * 1024 * 1024)
        throw Error('This page is too complex to render. Use a smaller copy.');
      return {
        page: requestedPage,
        pageCount: pdf.numPages,
        text: text.slice(0, 12000),
        textTruncated: text.length > 12000,
        width: canvas.width,
        height: canvas.height,
        image: `data:image/jpeg;base64,${image.toString('base64')}`,
        warnings: [
          'Rendered page at a maximum of 1600 pixels. Very small text may need a higher-resolution source. Images exceeding 16 million pixels are not decoded.',
        ],
      };
    }
    let text = '';
    const pages = [],
      pagesWithoutText = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const body = await pageText(page);
      if (!body) pagesWithoutText.push(number);
      const start = text.length;
      text += `${text ? '\n\n' : ''}## Page ${number}\n${body || '[No extractable text on this page. Use read_pdf_page to inspect its image.]'}`;
      if (text.length > 1000000)
        throw Error('This PDF contains too much text. Attach a smaller section.');
      pages.push({ page: number, start, end: text.length });
      page.cleanup();
    }
    let fields = [],
      fieldCount = 0;
    const warnings = [
      'Text order follows the PDF source and may differ from visual layout. Use read_pdf_page for tables, diagrams, scans or layout. Links, scripts and embedded files are not opened.',
    ];
    try {
      const form = await inspectPdf(bytes);
      fieldCount = form.fields.length;
      const objects = await pdf.getFieldObjects();
      let fieldBytes = 0;
      for (const field of form.fields.slice(0, 100)) {
        const widgets = objects?.get?.(field.name) || [];
        const widget = widgets.find((w) => w.value !== undefined && !w.password);
        const value =
          widget && ['string', 'boolean', 'number'].includes(typeof widget.value)
            ? widget.value
            : widget && Array.isArray(widget.value)
              ? widget.value.map(String)
              : undefined;
        const info = { ...field, ...(!field.protected && value !== undefined ? { value } : {}) };
        fieldBytes += JSON.stringify(info).length;
        if (fieldBytes > 12000) break;
        fields.push(info);
      }
    } catch {
      warnings.push('Form fields could not be inspected; extracted page text is still available.');
    }
    return {
      pageCount: pdf.numPages,
      text,
      pages,
      pagesWithoutText,
      fields,
      fieldCount,
      fieldsTruncated: fieldCount > fields.length,
      warnings,
    };
  } finally {
    await loading.destroy();
  }
}
