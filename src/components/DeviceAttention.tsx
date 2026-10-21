import { useEffect, useRef } from 'react';
import { PushNotifications } from '@capacitor/push-notifications';
import { useWorkspace } from '../context';
import { api } from '../api';
import { attentionEvents } from '../../shared/attention.mjs';
import {
  notificationPlatform,
  savedNotificationDevice,
  configureDesktop,
  enableDeviceNotifications,
} from '../device-notifications';
export default function DeviceAttention({ open }: { open: (target: any) => void }) {
  const { s, page, threadId, focusSerial, toast } = useWorkspace();
  const latest = useRef({ s, page, threadId, open, toast });
  latest.current = { s, page, threadId, open, toast };
  const reading = useRef('');
  const version = s.messages.at(-1)?.id || '';
  const visit = useRef({ key: '', marker: '' });
  const visitKey = `${api.mode()}:${s.threads.find((t) => t.id === 'main')?.createdAt}:${page}:${threadId}:${focusSerial}`;
  if (visit.current.key !== visitKey)
    visit.current = {
      key: visitKey,
      marker: s.threads.find((t) => t.id === threadId)?.unreadMarker || '',
    };

  useEffect(() => {
    const read = () => {
      const { s, page, threadId } = latest.current;
      if (page !== 'chat' || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const marker = visit.current.marker;
      const marked = marker && s.threads.find((t) => t.id === threadId)?.unreadMarker === marker;
      if (
        !marked &&
        !attentionEvents(s).some((e: any) => !e.read && e.target.threadId === threadId)
      )
        return;
      const through = s.messages.findLast((m) => m.threadId === threadId)?.id;
      const cursor = `${threadId}:${through || ''}:${marker}`;
      if ((!through && !marked) || reading.current === cursor) return;
      reading.current = cursor;
      void api
        .act('attention.read', {
          threadId,
          throughMessageId: through,
          ...(marker ? { unreadMarker: marker } : {}),
        })
        .catch(() => {
          reading.current = '';
        });
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [page, threadId, version, visitKey]);
  useEffect(() => {
    let alive = true;
    async function handle(value: any) {
      if (
        !alive ||
        !value ||
        typeof value.workspaceId !== 'string' ||
        typeof value.noticeId !== 'string'
      )
        return;
      try {
        const target = await api.request('/attention/open', {
          method: 'POST',
          body: JSON.stringify(value),
        });
        await api.refresh();
        if (alive) latest.current.open(target);
      } catch (e) {
        if (alive)
          latest.current.toast(e instanceof Error ? e.message : 'This update could not open.');
      }
    }
    const remove = (window as any).relayNative?.notifications?.onOpen(handle);
    const handles: { remove(): Promise<void> }[] = [];
    if (['ios', 'android'].includes(notificationPlatform())) {
      void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        if (action.actionId !== 'tap') return;
        const data = action.notification.data;
        void handle({ workspaceId: data?.relayWorkspace, noticeId: data?.relayNotice });
      })
        .then((h) => (alive ? handles.push(h) : void h.remove()))
        .catch(() => {});
      void PushNotifications.addListener('pushNotificationReceived', () => {
        void api.refresh();
      })
        .then((h) => (alive ? handles.push(h) : void h.remove()))
        .catch(() => {});
    }
    return () => {
      alive = false;
      remove?.();
      for (const h of handles) void h.remove();
    };
  }, []);
  useEffect(() => {
    if (api.mode() !== 'server') return;
    let alive = true,
      refreshed = false,
      identity = savedNotificationDevice();
    const platform = notificationPlatform();
    async function configure() {
      identity = savedNotificationDevice();
      if (['ios', 'android'].includes(platform) && identity && !refreshed) {
        try {
          const status = await api.request('/attention');
          const device =
            status.workspaceId === identity.workspaceId &&
            status.devices.find((d: any) => d.id === identity?.id && d.enabled);
          if (device && (await PushNotifications.checkPermissions()).receive === 'granted') {
            refreshed = true;
            await enableDeviceNotifications(status, device.preview);
          }
        } catch {}
      }
      if (platform === 'desktop') {
        try {
          const status = await api.request('/attention');
          const enabled =
            identity?.workspaceId === status.workspaceId &&
            status.devices.some((d: any) => d.id === identity?.id && d.enabled);
          if (alive) await configureDesktop(enabled ? identity : null);
        } catch {}
      }
    }
    async function presence() {
      if (!identity || !alive || !['ios', 'android'].includes(platform)) return;
      try {
        await api.request('/attention/presence', {
          method: 'POST',
          body: JSON.stringify({
            ...identity,
            focused: document.visibilityState === 'visible' && document.hasFocus(),
          }),
          keepalive: true,
        });
      } catch {}
    }
    const wake = () => {
      void presence();
      if (document.visibilityState === 'visible') void api.refresh();
    };
    const changed = () => {
      void configure().then(presence);
    };
    changed();
    const timer = setInterval(() => void presence(), 15000);
    window.addEventListener('focus', wake);
    window.addEventListener('blur', wake);
    window.addEventListener('relay:notifications-changed', changed);
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('blur', wake);
      window.removeEventListener('relay:notifications-changed', changed);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [s.threads.find((t) => t.id === 'main')?.createdAt]);
  return null;
}
