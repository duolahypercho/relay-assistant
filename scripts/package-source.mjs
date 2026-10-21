// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { packageSourceRelease } from './source-release.mjs';

if (process.argv.length > 2) throw Error('Run from the Relay repository with no arguments.');
const result = await packageSourceRelease(resolve('.'), resolve('release/source'));
console.log(JSON.stringify(result, null, 2));
