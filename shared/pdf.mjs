// SPDX-License-Identifier: MIT
export async function permissionPdf(values) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  // This bundled fictional source must retain the same bytes across reads/restarts.
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Riverbank Field Lab', {
    x: 48,
    y: 770,
    size: 22,
    font: bold,
    color: rgb(0.09, 0.24, 0.72),
  });
  page.drawText('Visit permission form', { x: 48, y: 735, size: 15, font });
  page.drawText('Sample document / Fictional visit', {
    x: 48,
    y: 705,
    size: 10,
    font,
    color: rgb(0.4, 0.45, 0.53),
  });
  const form = pdf.getForm();
  for (const [name, label, y] of [
    ['participant', 'Participant name', 635],
    ['contact', 'Contact number', 545],
    ['access', 'Access needs (optional)', 455],
  ]) {
    page.drawText(label, { x: 48, y: y + 34, size: 12, font });
    const field = form.createTextField(name);
    field.addToPage(page, {
      x: 48,
      y,
      width: 499,
      height: 28,
      borderWidth: 1,
      borderColor: rgb(0.78, 0.81, 0.87),
      backgroundColor: rgb(0.98, 0.99, 1),
      font,
    });
    if (values?.[name]) field.setText(String(values[name]));
  }
  page.drawText('Meet at 9:00 am. Return at 3:30 pm.', { x: 48, y: 385, size: 11, font });
  page.drawText('This sample form does not create a real commitment.', {
    x: 48,
    y: 350,
    size: 10,
    font,
    color: rgb(0.4, 0.45, 0.53),
  });
  form.updateFieldAppearances(font);
  return pdf.save();
}
export function fromBase64(value) {
  return typeof Buffer !== 'undefined'
    ? Uint8Array.from(Buffer.from(value, 'base64'))
    : Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let r = '';
  for (let i = 0; i < bytes.length; i += 8192)
    r += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(r);
}
export async function fileBytes(f) {
  if (f.template === 'permission' && !f.base64) return permissionPdf();
  if (f.base64) return fromBase64(f.base64);
  if (f.text !== undefined) return new TextEncoder().encode(f.text);
  return new Uint8Array();
}
export async function inspectPdf(bytes) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  return {
    pageCount: doc.getPageCount(),
    fields: doc
      .getForm()
      .getFields()
      .map((f) => ({
        name: f.getName(),
        type: f.constructor.name,
        label: f.getName(),
        required: f.isRequired(),
        readOnly: f.isReadOnly(),
        ...(f.isPassword?.() ? { protected: true } : { value: pdfFieldValue(f) }),
        ...(f.constructor.name === 'PDFTextField'
          ? { multiline: f.isMultiline(), maxLength: f.getMaxLength() }
          : {}),
        ...(['PDFDropdown', 'PDFOptionList', 'PDFRadioGroup'].includes(f.constructor.name)
          ? { options: f.getOptions() }
          : {}),
        ...(f.isMultiselect ? { multiselect: f.isMultiselect() } : {}),
      })),
  };
}
export function pdfFieldValue(field) {
  const kind = field.constructor.name;
  if (kind === 'PDFTextField') return field.getText() || '';
  if (kind === 'PDFCheckBox') return field.isChecked();
  if (['PDFDropdown', 'PDFOptionList', 'PDFRadioGroup'].includes(kind))
    return field.getSelected() ?? '';
  return undefined;
}
export async function fillPdf(file, values) {
  const { PDFDocument } = await import('pdf-lib');
  if (file.template === 'permission' && !file.base64) return permissionPdf(values);
  const doc = await PDFDocument.load(await fileBytes(file));
  const fields = doc.getForm().getFields();
  if (!fields.length)
    throw new Error('This PDF has no editable fields. Scanned forms are not supported.');
  for (const f of fields) {
    const v = values[f.getName()];
    if (v === undefined) continue;
    if (f.constructor.name === 'PDFTextField') f.setText(String(v));
    else if (f.constructor.name === 'PDFCheckBox') {
      if (['true', 'yes', '1', 'on'].includes(String(v).toLowerCase())) f.check();
      else f.uncheck();
    } else if (['PDFDropdown', 'PDFOptionList'].includes(f.constructor.name)) f.select(String(v));
    else throw new Error(`The field ${f.getName()} uses an unsupported field type.`);
  }
  return doc.save();
}
