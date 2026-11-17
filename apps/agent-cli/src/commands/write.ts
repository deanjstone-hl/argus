import { Command } from 'commander';
import { engineRequest } from '../lib/engine.js';
import { engineFailure } from '../lib/ui.js';

export function makeWriteCommand(): Command {
  return new Command('write')
    .description('write content to a CORTEX vault file (--content or stdin)')
    .argument('<fileName>', 'vault-relative path (e.g. MEMORY/note.md)')
    .option('-c, --content <text>', 'content to write inline')
    .action(async (fileName: string, opts: { content?: string }) => {
      const content = opts.content !== undefined ? opts.content : await readStdin();

      try {
        await engineRequest('/context/write', { method: 'POST', body: { fileName, content } });
        console.log(`agent: wrote ${fileName}`);
      } catch (err) {
        engineFailure(err);
      }
    });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
