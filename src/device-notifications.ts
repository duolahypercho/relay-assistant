import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { api } from './api';
export const notificationPlatform = () =>
  Capacitor.isNativePlatform()
    ? Capacitor.getPlatform()
    : (window as any).relayNative?.notifications
      ? 'desktop'
      : 'web';
export type DeviceIdentity = { id: string; key: string; workspaceId: string };
const storage = 'relay-notification-device';
export function savedNotificationDevice(): DeviceIdentity | null {
  try {
    const p = JSON.parse(localStorage.getItem(storage) || 'null');
    return p && /^[a-f0-9]{64}$/.test(p.key) && typeof p.workspaceId === 'string' ? p : null;
  } catch {
    return null;
  }
}
export function notificationIdentity(workspaceId: string): DeviceIdentity {
  const saved = savedNotificationDevice();
  if (saved?.workspaceId === workspaceId) return saved;
  return {
    id: crypto.randomUUID(),
    key: Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(''),
    workspaceId,
  };
}
export function notificationsChanged() {
  window.dispatchEvent(new Event('relay:notifications-changed'));
}
export async function configureDesktop(identity: DeviceIdentity | null) {
  await (window as any).relayNative?.notifications?.configure(identity);
}
export async function enableDeviceNotifications(status: any, preview: boolean) {
  const platform = notificationPlatform(),
    identity = notificationIdentity(status.workspaceId);
  if (platform === 'web')
    throw Error('Open the Relay desktop or mobile app to receive device notifications.');
  let token: string | undefined;
  if (platform !== 'desktop') {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale')
      permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted')
      throw Error(
        'Notifications are off in your device settings. Allow them for Relay, then try again.',
      );
    token = await new Promise<string>(async (resolve, reject) => {
      let done = false;
      const handles: { remove(): Promise<void> }[] = [];
      const finish = (error?: Error, value?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const h of handles) void h.remove();
        error ? reject(error) : resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(
            Error(
              'Your device did not register for push. Check your connection and app signing, then try again.',
            ),
          ),
        20000,
      );
      try {
        handles.push(
          await PushNotifications.addListener('registration', (value) =>
            finish(undefined, value.value),
          ),
        );
        handles.push(
          await PushNotifications.addListener('registrationError', () =>
            finish(
              Error(
                'Your device could not register for push. Check your connection and app setup.',
              ),
            ),
          ),
        );
        if (platform === 'android')
          await PushNotifications.createChannel({
            id: 'relay_updates',
            name: 'Assistant updates',
            description: 'Results, questions and action reviews',
            importance: 4,
            visibility: 0,
          });
        await PushNotifications.register();
      } catch {
        finish(Error('Push notifications are unavailable in this app build.'));
      }
    });
  }
  const name =
    platform === 'ios'
      ? 'My iPhone or iPad'
      : platform === 'android'
        ? 'My Android device'
        : 'My desktop';
  const result = await api.request('/attention/enroll', {
    method: 'POST',
    body: JSON.stringify({ ...identity, platform, token, name, preview }),
  });
  localStorage.setItem(storage, JSON.stringify(identity));
  await configureDesktop(identity);
  notificationsChanged();
  return result;
}
export async function forgetLocalNotificationDevice() {
  localStorage.removeItem(storage);
  await configureDesktop(null);
  notificationsChanged();
}
