// SPDX-License-Identifier: MIT
// Original documents, including a page with pixels but no PDF text layer.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
export async function pdfReaderDocument({ long = false } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('Riverbank visit');
  const first = pdf.addPage([600, 800]);
  first.drawText('Riverbank visit', { x: 48, y: 720, size: 28, font });
  first.drawText('Meet at 9:00 am. Return at 3:30 pm.', { x: 48, y: 660, size: 18, font });
  first.drawText('A quiet stop at the café is optional.', { x: 48, y: 615, size: 16, font });
  const field = pdf.getForm().createTextField('participant');
  field.setText('Jamie');
  field.addToPage(first, { x: 48, y: 530, width: 250, height: 30, font });
  const second = pdf.addPage([600, 800]);
  second.drawText('Packing list', { x: 48, y: 720, size: 28, font });
  second.drawText('Bring a water bottle and a packed lunch.', { x: 48, y: 650, size: 18, font });
  if (long)
    for (let p = 0; p < 15; p++) {
      const page = pdf.addPage([600, 800]);
      for (let line = 0; line < 50; line++)
        page.drawText(
          `Section ${p + 1}, line ${line + 1}. Keep the riverbank clean and leave time to rest.`,
          { x: 30, y: 765 - line * 14, size: 9, font },
        );
    }
  const canvas = createCanvas(900, 1000),
    c = canvas.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, 900, 1000);
  c.fillStyle = '#23734b';
  c.fillRect(100, 220, 700, 490);
  c.fillStyle = '#ffffff';
  c.font = 'bold 42px sans-serif';
  c.fillText('Bring a green notebook.', 140, 410);
  c.font = '30px sans-serif';
  c.fillText('Original scanned-page fixture', 140, 480);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  const scan = pdf.addPage([600, 800]);
  scan.drawImage(image, { x: 0, y: 50, width: 600, height: 667 });
  pdf.getForm().updateFieldAppearances(font);
  return Buffer.from(await pdf.save());
}
