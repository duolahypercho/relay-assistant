import { useEffect, useState } from 'react';
import { Devices } from '@phosphor-icons/react';
import { isNativeMobile, mobileConnection } from '../native-mobile';
import { useUiLanguage } from '../i18n';
import { connectionText } from '../../shared/native-connection-language.mjs';

export function NativeServerButton() {
  const [error, setError] = useState('');
  const { locale } = useUiLanguage();
  if (!isNativeMobile) return null;
  return (
    <>
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setError('');
          void mobileConnection
            .show({ locale })
            .catch(() =>
              setError(
                connectionText(
                  locale,
                  'The connection screen could not open. Please reopen Relay.',
                ),
              ),
            );
        }}
      >
        {connectionText(locale, 'Connect your devices')}
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export default function NativeConnection() {
  const [url, setURL] = useState('');
  const { locale } = useUiLanguage();
  useEffect(() => {
    if (isNativeMobile)
      void mobileConnection
        .status()
        .then((result) => setURL(result.url))
        .catch(() => {});
  }, []);
  if (!isNativeMobile) return null;
  return (
    <article className="settings-card">
      <div className="settings-title">
        <Devices size={23} />
        <div>
          <h2>{connectionText(locale, 'One assistant, everywhere')}</h2>
          <p>
            {url
              ? connectionText(locale, 'Connected to {url}', { url })
              : connectionText(locale, 'This sample is saved on this device.')}
          </p>
        </div>
      </div>
      <p className="form-note">
        {connectionText(
          locale,
          'Connect to your Relay server to share conversations, memories and files with your desktop. Your server keeps working while this app is closed.',
        )}
      </p>
      <NativeServerButton />
    </article>
  );
}
