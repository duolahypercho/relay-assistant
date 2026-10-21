// SPDX-License-Identifier: MIT
import { Script, compileFunction } from 'node:vm';
import { Parser } from 'htmlparser2';

const classicTypes = new Set([
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'application/x-javascript',
  'text/x-javascript',
  'application/x-ecmascript',
  'text/x-ecmascript',
  'text/jscript',
  'text/livescript',
  ...Array.from({ length: 6 }, (_, i) => `text/javascript1.${i}`),
]);
const handlers =
  /^on(?:click|dblclick|input|change|submit|reset|keydown|keyup|keypress|focus|blur|load|error|pointerdown|pointerup|pointermove|pointerenter|pointerleave|mousedown|mouseup|mousemove|mouseenter|mouseleave|touchstart|touchend|touchmove|dragstart|dragover|drop|scroll|wheel|resize|toggle|animationend|transitionend)$/;

// Compilation only. Never run the generated code, import modules, open a page,
// or grant a VM context. The browser's sandbox remains the execution boundary.
export function artifactHtmlCheck(source) {
  if (typeof source !== 'string' || source.length > 200000)
    throw new Error('Interactive source must be HTML up to 200,000 characters.');
  const result = { classicScripts: 0, eventHandlers: 0, uncheckedModuleScripts: 0 };
  let script = null;
  const check = (code, label, handler = false) => {
    if (result.classicScripts + result.eventHandlers >= 256)
      throw new Error('Use at most 256 inline scripts and event handlers.');
    try {
      if (handler) compileFunction(code, ['event']);
      else new Script(code);
    } catch (error) {
      throw new Error(
        `JavaScript syntax error in ${label}: ${String(error.message).slice(0, 180)}. Correct the source and retry.`,
      );
    }
    if (handler) result.eventHandlers++;
    else result.classicScripts++;
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        for (const [attribute, value] of Object.entries(attributes))
          if (handlers.test(attribute)) check(value, `${name} ${attribute} handler`, true);
        if (name !== 'script') return;
        const type = (
          Object.hasOwn(attributes, 'type')
            ? attributes.type
            : attributes.language
              ? `text/${attributes.language}`
              : ''
        )
          .trim()
          .toLowerCase();
        if (type === 'module') result.uncheckedModuleScripts++;
        if (
          !Object.hasOwn(attributes, 'src') &&
          !Object.hasOwn(attributes, 'nomodule') &&
          (!type || classicTypes.has(type))
        )
          script = '';
      },
      ontext(text) {
        if (script !== null) script += text;
      },
      onclosetag(name) {
        if (name !== 'script' || script === null) return;
        check(script, `inline script ${result.classicScripts + 1}`);
        script = null;
      },
    },
    { decodeEntities: true },
  );
  parser.end(source);
  return {
    ...result,
    scope:
      'Syntax only, without execution. Module scripts, CSS, DOM behavior, data accuracy and browser compatibility are not validated.',
  };
}
