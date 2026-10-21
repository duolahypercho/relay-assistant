// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import { parsePdfDocument } from './pdf-reader-parser.mjs';
try {
  parentPort.postMessage({ result: await parsePdfDocument(workerData) });
} catch (error) {
  parentPort.postMessage({
    error:
      error.name === 'PasswordException'
        ? 'This PDF is password protected. Save an unlocked copy before attaching it.'
        : error.message || 'This PDF could not be read.',
  });
}
