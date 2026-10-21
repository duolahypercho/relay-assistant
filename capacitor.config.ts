import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';
import { serverURL } from './native/desktop/urls.mjs';
const remote = process.env.RELAY_MOBILE_SERVER_URL;
const config: CapacitorConfig = {
  appId: 'org.relay.assistant',
  appName: 'Relay',
  webDir: 'dist',
  ios: { path: 'native/mobile/ios', contentInset: 'automatic' },
  android: { path: 'native/mobile/android' },
  plugins: {
    Keyboard: { resize: KeyboardResize.Native, resizeOnFullScreen: true },
    PushNotifications: { presentationOptions: [] },
  },
  ...(remote ? { server: { url: serverURL(remote), cleartext: remote.startsWith('http:') } } : {}),
};
export default config;
