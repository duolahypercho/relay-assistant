// SPDX-License-Identifier: MIT
import { packager } from '@electron/packager';
import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Electron's pinned npm package includes the publisher's runtime checksums. Use
// those to verify cached/downloaded bytes without fetching the checksum file again.
const electronVersion = require('electron/package.json').version;
const checksums = require('electron/checksums.json');
const paths = await packager({
  dir: '.',
  electronVersion,
  download: { checksums },
  name: 'Relay',
  appBundleId: 'org.relay.assistant',
  appCategoryType: 'public.app-category.productivity',
  out: 'release/desktop',
  overwrite: true,
  asar: true,
  prune: true,
  extendInfo: {
    CFBundleURLTypes: [
      {
        CFBundleURLName: 'org.relay.assistant.template',
        CFBundleTypeRole: 'Viewer',
        CFBundleURLSchemes: ['relay-assistant'],
      },
    ],
    NSMicrophoneUsageDescription:
      'Relay uses your microphone for dictation and voice chats. Dictation adds editable text; voice chats send spoken turns automatically to your chosen services. Cancel or End call stops recording.',
  },
  ignore: [
    /^\/data(?:\/|$)/,
    /^\/\.env(?:\.|$)/,
    /^\/(?:\.git|\.openai|\.sites-runtime)(?:\/|$)/,
    /^\/(?:release|test-results|playwright-report|evidence|tests)(?:\/|$)/,
    /^\/native\/mobile(?:\/|$)/,
    /\.relaybackup$/i,
    /\.log$/,
    /\.(?:p8|p12|pem|key)$/,
    /(?:^|\/)(?:google-services\.json|GoogleService-Info\.plist|firebase-service-account[^/]*\.json)$/,
  ],
});
for (const path of paths) {
  // Packager retains its private temporary directory mode. An installed Linux
  // bundle must also be traversable by the ordinary user who launches it.
  if (process.platform === 'linux') await chmod(path, 0o755);
  console.log(path);
}
