// SPDX-License-Identifier: MIT
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTemplateAppLink, templateSourceUrl } from '../../shared/assistant-template-links.mjs';
export class DesktopTemplateLinks {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'pending-template.json');
    this.tail = Promise.resolve();
  }
  receive(link, destination) {
    const url = parseTemplateAppLink(link);
    const item = { id: randomUUID(), url, destination };
    const work = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temp = this.path + '.tmp';
      await writeFile(temp, JSON.stringify(item), { mode: 0o600 });
      await rename(temp, this.path);
      return item;
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async peek(destination) {
    await this.tail;
    try {
      const item = JSON.parse(await readFile(this.path, 'utf8'));
      if (item.destination !== destination || !/^[A-Za-z0-9_-]{16,100}$/.test(item.id)) return null;
      return { id: item.id, url: templateSourceUrl(item.url) };
    } catch {
      return null;
    }
  }
  acknowledge(id, destination) {
    const work = this.tail.then(async () => {
      try {
        const item = JSON.parse(await readFile(this.path, 'utf8'));
        if (item.id === id && item.destination === destination)
          await rm(this.path, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
