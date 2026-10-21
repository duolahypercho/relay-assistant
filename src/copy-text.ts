// Desktop permission policies deny arbitrary clipboard access. Copying text uses
// a write-only bridge restricted to the main, trusted workspace frame.
export async function copyText(value: string) {
  const native = (window as any).relayNative;
  if (native?.copyText) await native.copyText(value);
  else await navigator.clipboard.writeText(value);
}

// Begin the browser write during the user's gesture; WebKit needs that gesture
// even though the private computer's text arrives asynchronously. No reads.
export async function copyTransferredText(load: () => Promise<string>) {
  const text = load();
  let copied = false;
  const native = (window as any).relayNative;
  if (native?.copyText) {
    const value = await text;
    try {
      await native.copyText(value);
      copied = true;
    } catch {
      /* Offer local selection. */
    }
  } else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    // An immediate permission refusal may leave the item promise unconsumed.
    void blob.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      copied = true;
    } catch {
      /* Preserve retrieved text for an explicit manual copy. */
    }
  } else {
    const value = await text;
    try {
      await copyText(value);
      copied = true;
    } catch {
      /* Offer local selection. */
    }
  }
  return { text: await text, copied };
}
