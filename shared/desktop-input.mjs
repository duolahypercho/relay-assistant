// SPDX-License-Identifier: MIT
// Short-lived owner input only. Never persist, replay, or automatically retry it.
export class DesktopInputQueue {
  constructor(send, changed = (_pending = false) => {}, failed = (_message = '') => {}) {
    this.send = send;
    this.changed = changed;
    this.failed = failed;
    this.items = [];
    this.active = false;
    this.generation = 0;
  }
  request(input) {
    return new Promise((resolve, reject) => {
      if (!this.push(input, { resolve, reject })) reject(Error('The computer is catching up.'));
    });
  }
  push(input, completion) {
    if (input.action === 'type' && (!input.text || input.text.length > 4000)) return false;
    const last = this.items.at(-1);
    if (
      input.action === 'type' &&
      !completion &&
      !last?.completion &&
      last?.input.action === 'type' &&
      last.input.text.length + input.text.length <= 4000
    )
      last.input.text += input.text;
    else if (this.items.length < 64) this.items.push({ input: { ...input }, completion });
    else {
      this.failed('The computer is catching up. Wait for it before entering more.');
      return false;
    }
    this.changed(true);
    if (!this.active && !this.timer) this.timer = setTimeout(() => void this.drain(), 35);
    return true;
  }
  clear() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    const error = new Error('Computer input stopped.');
    error.name = 'AbortError';
    for (const item of this.items) item.completion?.reject(error);
    this.current?.completion?.reject(error);
    this.items = [];
    this.changed(this.active);
  }
  async drain() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active) return;
    this.active = true;
    const generation = this.generation;
    try {
      while (this.items.length && generation === this.generation) {
        this.current = this.items.shift();
        const result = await this.send(this.current.input);
        if (!result) throw Error('Input stopped. Check the screen before typing again.');
        if (generation === this.generation) this.current.completion?.resolve(result);
        this.current = null;
      }
    } catch (error) {
      this.current?.completion?.reject(error);
      for (const item of this.items) item.completion?.reject(error);
      this.items = [];
      if (generation === this.generation) this.failed(error.message);
    } finally {
      this.current = null;
      this.active = false;
      this.changed(this.items.length > 0);
      if (this.items.length) void this.drain();
    }
  }
}

export function desktopKey(event) {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.key === 'Tab')
    return null;
  // An explicit paste uses the browser's text input event, not the guest clipboard.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return null;
  const names = {
    Enter: 'Return',
    Backspace: 'BackSpace',
    Escape: 'Escape',
    Delete: 'Delete',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Home: 'Home',
    End: 'End',
    PageUp: 'Prior',
    PageDown: 'Next',
  };
  let key = names[event.key];
  const command = event.ctrlKey || event.metaKey;
  if (!key && (command || event.altKey) && /^[a-zA-Z0-9]$/.test(event.key))
    key = event.key.toLowerCase();
  if (!key) return null;
  return [command && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', key]
    .filter(Boolean)
    .join('+');
}
