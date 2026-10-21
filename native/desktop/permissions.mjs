// SPDX-License-Identifier: MIT
export function isWorkspaceMicrophone(permission, details, workspaceURL, mode = 'request') {
  try {
    if (permission !== 'media' || details.isMainFrame !== true) return false;
    if (
      new URL(details.requestingUrl || details.securityOrigin).origin !==
      new URL(workspaceURL).origin
    )
      return false;
    if (mode === 'check') return details.mediaType === 'audio';
    return details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
  } catch {
    return false;
  }
}
