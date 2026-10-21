import { isNativeMobile, mobileConnection } from './native-mobile';
import './native-reconnect.css';
import { resolveUiLocale } from '../shared/ui-language.mjs';
import { connectionText } from '../shared/native-connection-language.mjs';

// The bundled recovery origin cannot read a disconnected server's preferences.
// Resolve this pre-workspace screen from the device without reading server data.
const locale = resolveUiLocale('system', [...(navigator.languages || [navigator.language])]);
const text = (key: string) => connectionText(locale, key);
document.documentElement.lang = locale;
document.title = text('Reconnect to Relay');
for (const element of document.querySelectorAll<HTMLElement>('[data-connection-copy]')) {
  element.textContent = text(element.dataset.connectionCopy!);
}

let server = '';
const error = document.getElementById('error')!;
if (isNativeMobile) {
  void mobileConnection
    .status()
    .then(({ url }) => {
      server = url;
      document.getElementById('address')!.textContent = url;
    })
    .catch(() => {
      error.textContent = text('Close and reopen Relay to restore the connection.');
    });
}
document.getElementById('retry')!.addEventListener('click', () => {
  if (server) location.assign(server);
  else location.assign('/');
});
document.getElementById('connection')!.addEventListener('click', () => {
  if (isNativeMobile)
    void mobileConnection.show({ locale }).catch(() => {
      error.textContent = text('Close and reopen Relay to change your server.');
    });
  else error.textContent = text('Open the Relay mobile app to choose your server.');
});
