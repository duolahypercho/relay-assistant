// SPDX-License-Identifier: MIT
// Original fictional form used only for form-completion acceptance.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
export async function pdfFormDocument() {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm(),
    pages = [doc.addPage([595, 842]), doc.addPage([595, 842])];
  for (const [index, page] of pages.entries()) {
    page.drawText('Riverbank Saturday', {
      x: 48,
      y: 775,
      size: 24,
      font,
      color: rgb(0.17, 0.34, 0.27),
    });
    page.drawText('Fictional acceptance form - no real commitment', {
      x: 48,
      y: 746,
      size: 11,
      font,
    });
    page.drawText(`Page ${index + 1} of 2`, { x: 48, y: 35, size: 10, font });
  }
  const text = (name, label, y, required = false, page = pages[0]) => {
    page.drawText(label, { x: 48, y: y + 43, size: 12, font });
    const field = form.createTextField(name);
    field.addToPage(page, { x: 48, y, width: 495, height: 32, font, borderWidth: 1 });
    if (required) field.enableRequired();
    return field;
  };
  text('participant', 'Participant name', 650, true).setMaxLength(80);
  text('contact', 'Contact number', 560, true);
  text('reference', 'Keep this existing reference', 470).setText('SOURCE-KEEP-42');
  pages[0].drawText('Travel choice', { x: 48, y: 425, size: 12, font });
  const travel = form.createRadioGroup('travel');
  travel.addOptionToPage('Train', pages[0], { x: 48, y: 390, width: 18, height: 18 });
  pages[0].drawText('Train', { x: 75, y: 394, size: 12, font });
  travel.addOptionToPage('Bus', pages[0], { x: 180, y: 390, width: 18, height: 18 });
  pages[0].drawText('Bus', { x: 207, y: 394, size: 12, font });
  const lunch = form.createCheckBox('packed_lunch');
  lunch.addToPage(pages[0], { x: 48, y: 325, width: 18, height: 18 });
  pages[0].drawText('I will bring a packed lunch', { x: 75, y: 329, size: 12, font });
  pages[1].drawText('Meet at 9:00 am. Return at 3:30 pm.', { x: 48, y: 690, size: 14, font });
  const notes = text('notes', 'Notes for the visit (optional)', 595, false, pages[1]);
  notes.enableMultiline();
  pages[1].drawText('Snack choice', { x: 48, y: 545, size: 12, font });
  const snack = form.createDropdown('snack');
  snack.addOptions(['Apple', 'Crackers', 'None']);
  snack.addToPage(pages[1], { x: 48, y: 500, width: 225, height: 30, font });
  pages[1].drawText('Things to bring', { x: 48, y: 450, size: 12, font });
  const supplies = form.createOptionList('supplies');
  supplies.addOptions(['Book', 'Water', 'Hat']);
  supplies.enableMultiselect();
  supplies.addToPage(pages[1], { x: 48, y: 345, width: 225, height: 85, font });
  form.updateFieldAppearances(font);
  return Buffer.from(await doc.save());
}
export const pdfFormValues = [
  { name: 'participant', value: 'Jamie Example' },
  { name: 'contact', value: '555-0100' },
  { name: 'travel', value: 'Train' },
  { name: 'packed_lunch', value: true },
  { name: 'notes', value: 'Meet by the river.\nLeave the afternoon open.' },
  { name: 'snack', value: 'Apple' },
  { name: 'supplies', value: ['Book', 'Water'] },
];
