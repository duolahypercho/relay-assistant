import { useEffect, useState } from 'react';
import { Bell } from '@phosphor-icons/react';
import { api } from '../api';
import {
  notificationPlatform,
  savedNotificationDevice,
  enableDeviceNotifications,
  notificationsChanged,
  forgetLocalNotificationDevice,
} from '../device-notifications';
export default function NotificationSettings() {
  const [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const platform = notificationPlatform(),
    identity = savedNotificationDevice();
  const current = data?.devices.find((d: any) => d.id === identity?.id);
  async function refresh() {
    if (api.mode() === 'server')
      try {
        setData(await api.request('/attention'));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Notification settings are unavailable.');
      }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      notificationsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notifications could not be changed.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function update(p: any) {
    await api.request('/attention/update', {
      method: 'POST',
      body: JSON.stringify({ ...identity, ...p }),
    });
  }
  return (
    <article className="settings-card device-notifications" aria-label="Device notifications">
      <div className="settings-title">
        <Bell size={23} />
        <div>
          <h2>When you’re away</h2>
          <p>A result, a question, or something to review. Tap to pick up where you left off.</p>
        </div>
      </div>
      {platform === 'web' ? (
        <p className="form-note">
          Open the Relay desktop or mobile app to receive notifications on your device.
        </p>
      ) : api.mode() !== 'server' ? (
        <p className="form-note">
          Connect to your Relay server to receive updates while the app is closed.
        </p>
      ) : data && !data.providers[platform] ? (
        <p className="form-note">
          Mobile push needs setup on your Relay server. Your updates are still available in the app.
        </p>
      ) : (
        <>
          <div className="toggle-row">
            <div>
              <h3>Notify this device</h3>
              <p>Quiet while you’re using Relay.</p>
            </div>
            <button
              className={`switch ${current?.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={!!current?.enabled}
              aria-label="Notify this device"
              disabled={busy || !data}
              onClick={() =>
                void run(async () => {
                  if (current?.enabled) await update({ enabled: false });
                  else await enableDeviceNotifications(data, current?.preview || false);
                })
              }
            >
              <span />
            </button>
          </div>
          {current?.enabled && (
            <label className="notification-choice">
              <input
                type="checkbox"
                checked={current.preview}
                disabled={busy}
                onChange={(e) => {
                  const preview = e.target.checked;
                  setData((previous: any) => ({
                    ...previous,
                    devices: previous.devices.map((d: any) =>
                      d.id === identity?.id ? { ...d, preview } : d,
                    ),
                  }));
                  void run(() => update({ preview }));
                }}
              />
              <span>
                Show message previews
                <small>
                  Off keeps conversation details off your lock screen. Apple or Google still
                  receives device and delivery information.
                </small>
              </span>
            </label>
          )}
          {current?.lastError && (
            <p className="inline-error" role="status">
              {current.lastError}
            </p>
          )}
        </>
      )}
      {data?.devices.length > 0 && (
        <details className="notification-devices">
          <summary>Your connected devices</summary>
          {data.devices.map((d: any) => (
            <div className="notification-device" key={d.id}>
              <div>
                <strong>
                  {d.name}
                  {d.id === identity?.id ? ' · This device' : ''}
                </strong>
                <small>
                  {d.enabled ? 'Notifications on' : 'Notifications off'}
                  {d.lastSeenAt
                    ? ` · Last seen ${new Date(d.lastSeenAt).toLocaleDateString()}`
                    : ''}
                </small>
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.request('/attention/forget', {
                      method: 'POST',
                      body: JSON.stringify({ id: d.id }),
                    });
                    if (d.id === identity?.id) await forgetLocalNotificationDevice();
                  })
                }
              >
                Remove device
              </button>
            </div>
          ))}
        </details>
      )}
      {busy && <p role="status">Updating notification settings…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
