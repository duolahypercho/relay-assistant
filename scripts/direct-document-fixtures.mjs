// SPDX-License-Identifier: MIT
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderArtifact } from '../server/artifacts.mjs';
import { officeMime } from '../shared/office-files.mjs';
export async function directDocumentFiles(code = '7462') {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Meeting place: Willow library.', { x: 40, y: 700, size: 18, font });
  const word = await renderArtifact({
    kind: 'document',
    title: 'Supplies',
    source: '# Supplies\n\nBring a green notebook.',
  });
  return [
    {
      name: 'Meeting note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`Meeting code: ${code}.`),
    },
    {
      name: 'Meeting place.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    },
    {
      name: 'Supplies.docx',
      mimeType: officeMime('Supplies.docx'),
      buffer: Buffer.from(word.bytes),
    },
  ];
}
export function documentFixtureReply(body) {
  const sources = body.messages.filter(
    (m) => typeof m.content === 'string' && m.content.includes('<attached_document>'),
  );
  return sources.length
    ? 'Your meeting is at Willow library. Bring a green notebook.'
    : 'Hello! This side chat has no attached documents.';
}
