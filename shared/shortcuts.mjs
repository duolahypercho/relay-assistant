// SPDX-License-Identifier: MIT
// Resolve only intentional application shortcuts; leave IME, AltGr and OS keys alone.
export function shortcutCommand(event, mac = false) {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.getModifierState?.('AltGraph')
  )
    return null;
  const key = event.key.toLowerCase();
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'tab')
    return event.shiftKey ? 'previous-chat' : 'next-chat';
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)
    return key === 'arrowup' ? 'previous-chat' : key === 'arrowdown' ? 'next-chat' : null;
  if (!primary) return null;
  if (event.altKey) return !event.shiftKey && key === 'b' ? 'details' : null;
  if (event.shiftKey)
    return (
      { f: 'search-chats', m: 'apps', w: 'apps', ',': 'details', '<': 'details', i: 'details' }[
        key
      ] || null
    );
  if (/^[1-9]$/.test(key)) return `chat-${key}`;
  return (
    {
      k: 'search',
      n: 'new',
      f: 'find-chat',
      b: 'sidebar',
      i: 'focus-prompt',
      l: 'focus-prompt',
      ',': 'settings',
      '[': 'back',
      ']': 'forward',
      enter: 'send',
    }[key] || null
  );
}

export const shortcutHelp = [
  ['Search everything', '⌘/Ctrl K'],
  ['Find in this chat', '⌘/Ctrl F'],
  ['Find chats & assistants', '⌘/Ctrl Shift F'],
  ['New side chat', '⌘/Ctrl N'],
  ['Show or hide chats', '⌘/Ctrl B'],
  ['Focus your message', '⌘/Ctrl I or L'],
  ['Jump to sidebar chat 1–9', '⌘/Ctrl 1–9'],
  ['Previous / next chat', 'Alt ↑ / ↓'],
  ['Cycle chats', 'Ctrl Tab / Ctrl Shift Tab'],
  ['Back / forward', '⌘/Ctrl [ / ]'],
  ['Connect apps', '⌘/Ctrl Shift M'],
  ['Conversation details', '⌘/Ctrl Shift ,'],
  ['Settings', '⌘/Ctrl ,'],
  ['Send from the chat page', '⌘/Ctrl Enter'],
  ['Send / new line in your message', 'Enter / Shift Enter'],
  ['Dictate into your message', '⌘/Ctrl D'],
];
