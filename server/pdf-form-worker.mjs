// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import { fillPdfFields } from './pdf-form-parser.mjs';
try {
  parentPort.postMessage({ result: await fillPdfFields(workerData.bytes, workerData.changes) });
} catch (error) {
  parentPort.postMessage({ error: error.message || 'This PDF could not be filled.' });
}
