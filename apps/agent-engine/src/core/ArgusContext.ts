import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export class ArgusContext {
  private vaultPath: string;
  private memoryCache: Map<string, string>;

  constructor(vaultPath: string = '/mnt/c/Users/deanj/Obsidian/CORTEX') {
    this.vaultPath = resolve(vaultPath);
    this.memoryCache = new Map();
  }

  async getFileContent(fileName: string): Promise<string> {
    const cached = this.memoryCache.get(fileName);
    if (cached !== undefined) {
      return cached;
    }

    const content = await readFile(join(this.vaultPath, fileName), 'utf-8');
    this.memoryCache.set(fileName, content);
    return content;
  }

  async updateFile(fileName: string, content: string): Promise<void> {
    await writeFile(join(this.vaultPath, fileName), content, 'utf-8');
    this.memoryCache.set(fileName, content);
  }
}

export const argusContext = new ArgusContext();
