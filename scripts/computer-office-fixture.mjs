// SPDX-License-Identifier: MIT
// Original documents and an isolated desktop for actual office-app acceptance.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
import assert from 'node:assert/strict';

export async function officeComputer(store, directory) {
  const computer = new PrivateComputer(store, { deployment: directory });
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: process.env.DOCKER_HOST },
    runner: async (binary, args, options) => {
      const result = await setupProcess(binary, args, options);
      if (args.includes('build') && result.exitCode)
        console.error('Office test image build failed:', result.stderr, result.stdout);
      return result;
    },
  });
  try {
    setup.start();
    await setup.pending;
    assert.equal(setup.status().phase, 'ready', setup.status().error);
    await computer.start('owner');
    await computer.takeControl();
    const owner = (p) => computer.perform({ ...p, operationId: randomUUID() }, { actor: 'owner' });
    const write = (path, bytes) =>
      owner({
        kind: 'files',
        action: 'write',
        path,
        base64: Buffer.from(bytes).toString('base64'),
      });
    const doc = new Document({
      sections: [{ children: [new Paragraph('Relay office acceptance document.')] }],
    });
    await write('Welcome.docx', await Packer.toBuffer(doc));
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('Budget');
    sheet.addRows([
      ['Item', 'Cost'],
      ['Lunch', 12],
      ['Train', 8],
      ['Total', { formula: 'SUM(B2:B3)', result: 20 }],
    ]);
    await write('Budget.xlsx', await book.xlsx.writeBuffer());
    const slides = new pptxgen();
    slides.addSlide().addText('Our next idea', { x: 1, y: 1, w: 8, h: 1, fontSize: 30 });
    await write('Ideas.pptx', await slides.write({ outputType: 'nodebuffer' }));
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([500, 500]);
    page.drawText('Original Relay PDF preview', {
      x: 30,
      y: 400,
      font: await pdf.embedFont(StandardFonts.Helvetica),
      size: 20,
    });
    await write('Preview.pdf', await pdf.save());
    await write('notes.txt', 'Saved local text.');
    return { computer, setup, owner, write };
  } catch (error) {
    await setup.cancel().catch(() => {});
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]).catch(() => {});
    await computer
      .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
      .catch(() => {});
    throw error;
  }
}
