// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import { parseOffice } from './office-parser.mjs';
try {
  parentPort.postMessage({ result: await parseOffice(workerData.bytes, workerData.kind) });
} catch (error) {
  parentPort.postMessage({ error: error.message || 'This Office file could not be read.' });
}
