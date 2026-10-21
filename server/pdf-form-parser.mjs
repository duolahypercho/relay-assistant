// SPDX-License-Identifier: MIT
import { PDFDocument, PDFDict, PDFName, PDFStream, StandardFonts } from 'pdf-lib';
import { pdfFieldValue } from '../shared/pdf.mjs';

export async function fillPdfFields(bytes, changes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (doc.getPageCount() > 500) throw Error('Use a PDF with at most 500 pages.');
  // pdf-lib's getForm() removes XFA automatically; inspect before that call.
  if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA')))
    throw Error('This PDF uses XFA. Save an AcroForm copy before filling it.');
  const form = doc.getForm();
  if (form.hasXFA()) throw Error('This PDF uses XFA. Save an AcroForm copy before filling it.');
  const fields = form.getFields(),
    byName = new Map();
  if (!fields.length)
    throw Error('This PDF has no editable fields. Scanned forms need a PDF editor.');
  if (fields.length > 200) throw Error('Use a form with at most 200 fields.');
  const widgets = new Set();
  for (const f of fields) {
    if (byName.has(f.getName()))
      throw Error(
        'This PDF has ambiguous duplicate field names. Repair the form before filling it.',
      );
    byName.set(f.getName(), f);
    if (f.constructor.name === 'PDFSignature' && f.acroField.dict.get(PDFName.of('V')))
      throw Error(
        'This PDF is already signed. Use an unsigned source copy to preserve the signature.',
      );
    for (const w of f.acroField.getWidgets()) {
      if (w.dict !== f.acroField.dict && w.dict.has(PDFName.of('V')))
        throw Error(
          'This PDF has conflicting widget and field values. Repair the form before filling it.',
        );
      widgets.add(w.dict);
    }
  }
  const onPage = new Set();
  for (const page of doc.getPages()) {
    const annotations = page.node.Annots();
    for (let i = 0; i < (annotations?.size() || 0); i++) {
      const dict = doc.context.lookup(annotations.get(i));
      if (!(dict instanceof PDFDict) || dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget'))
        continue;
      if (!widgets.has(dict))
        throw Error(
          'This PDF contains a form widget outside its field tree. Repair the form before filling it.',
        );
      onPage.add(dict);
    }
  }
  if (doc.catalog.get(PDFName.of('Perms')))
    throw Error('This PDF has document certification. Use an uncertified source copy.');
  const font = await doc.embedFont(StandardFonts.Helvetica),
    changed = [];
  for (const { name, value } of changes) {
    const field = byName.get(name);
    if (!field)
      throw Error(`The form has no field named ${name}. Read its field names before filling it.`);
    if (field.isReadOnly() || field.isPassword?.())
      throw Error(`The field ${name} is read-only or protected.`);
    const fieldWidgets = field.acroField.getWidgets();
    if (!fieldWidgets.length || fieldWidgets.some((w) => !onPage.has(w.dict)))
      throw Error(
        `The field ${name} has no complete visible widget. Repair the form before filling it.`,
      );
    const kind = field.constructor.name;
    if (kind === 'PDFTextField') {
      if (typeof value !== 'string') throw Error(`Supply text for ${name}.`);
      if (field.getMaxLength() !== undefined && value.length > field.getMaxLength())
        throw Error(`The field ${name} allows at most ${field.getMaxLength()} characters.`);
      if (!field.isMultiline() && /[\r\n]/.test(value))
        throw Error(`The field ${name} accepts one line.`);
      try {
        font.encodeText(value.replace(/[\r\n]/g, ''));
      } catch {
        throw Error(
          `The field ${name} contains characters this PDF font cannot display. Use a PDF editor with a matching font.`,
        );
      }
      field.setText(value);
      field.setFontSize(0);
      field.updateAppearances(font);
    } else if (kind === 'PDFCheckBox') {
      if (typeof value !== 'boolean') throw Error(`Supply true or false for ${name}.`);
      value ? field.check() : field.uncheck();
      field.updateAppearances();
    } else if (['PDFDropdown', 'PDFOptionList', 'PDFRadioGroup'].includes(kind)) {
      if (kind === 'PDFRadioGroup' && typeof value !== 'string')
        throw Error(`Choose one exact option string for ${name}.`);
      const values = Array.isArray(value) ? value : [value],
        options = field.getOptions();
      if (
        !values.length ||
        values.some((v) => typeof v !== 'string' || !options.includes(v)) ||
        new Set(values).size !== values.length
      )
        throw Error(
          `Choose the exact listed option${kind === 'PDFRadioGroup' ? '' : '(s)'} for ${name}.`,
        );
      if (values.length > 1 && !field.isMultiselect?.())
        throw Error(`The field ${name} accepts one option.`);
      field.select(kind === 'PDFRadioGroup' ? values[0] : values);
      kind === 'PDFRadioGroup' ? field.updateAppearances() : field.updateAppearances(font);
    } else throw Error(`The field ${name} is not a supported text, checkbox, list or radio field.`);
    changed.push({ name, type: kind, value });
  }
  const result = await doc.save({ updateFieldAppearances: false });
  // Reopen canonical values and widget appearance dictionaries before publishing.
  const verified = await PDFDocument.load(result);
  const output = verified.getForm();
  for (const { name, type, value } of changed) {
    const field = output.getField(name);
    const actual =
      type === 'PDFTextField'
        ? field.getText() || ''
        : type === 'PDFCheckBox'
          ? field.isChecked()
          : field.getSelected();
    const expected = ['PDFDropdown', 'PDFOptionList'].includes(type)
      ? Array.isArray(value)
        ? value
        : [value]
      : value;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(`The saved value for ${name} did not verify.`);
    for (const widget of field.acroField.getWidgets()) {
      const appearance = widget.getAppearances()?.normal;
      if (!(appearance instanceof PDFStream) && !(appearance instanceof PDFDict))
        throw Error(`The appearance for ${name} did not verify.`);
      const streams =
        appearance instanceof PDFStream
          ? [appearance]
          : appearance.values().map((v) => verified.context.lookup(v));
      if (!streams.some((s) => s instanceof PDFStream && s.getContents().length > 0))
        throw Error(`The appearance for ${name} is empty.`);
    }
  }
  return {
    bytes: result,
    pageCount: doc.getPageCount(),
    changed,
    remainingRequired: fields
      .filter((f) => {
        if (!f.isRequired()) return false;
        const value = pdfFieldValue(f);
        return (
          value === undefined ||
          value === false ||
          (typeof value === 'string' && !value.trim()) ||
          (Array.isArray(value) && !value.length)
        );
      })
      .map((f) => f.getName()),
  };
}
