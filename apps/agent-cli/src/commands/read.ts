import { Command } from 'commander';
import { engineRequest } from '../lib/engine.js';
import { engineFailure } from '../lib/ui.js';

export function makeReadCommand(): Command {
  return new Command('read')
    .description('print a CORTEX vault file to stdout')
    .argument('<fileName>', 'vault-relative path (e.g. MEMORY/note.md)')
    .action(async (fileName: string) => {
      try {
        const data = await engineRequest<{ content?: string }>('/context/read', {
          method: 'POST',
          body: { fileName },
        });
        const content = String(data.content ?? '');
        process.stdout.write(content);
        if (!content.endsWith('\n')) process.stdout.write('\n');
      } catch (err) {
        engineFailure(err);
      }
    });
}
