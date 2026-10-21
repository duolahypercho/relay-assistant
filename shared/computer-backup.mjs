// SPDX-License-Identifier: MIT
export const BACKUP_MAGIC = 'RELAY-COMPUTER-1';
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
export const MAX_BACKUP_PLAIN = 8 * 1024 ** 3 + 65 * 1024 ** 2;
export const MAX_BACKUP_BYTES =
  MAX_BACKUP_PLAIN + Math.ceil(MAX_BACKUP_PLAIN / BACKUP_CHUNK_BYTES) * 20 + 60;
export const BACKUP_FILENAME = 'Relay-computer.relaybackup';
