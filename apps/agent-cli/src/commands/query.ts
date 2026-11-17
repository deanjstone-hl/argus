import { spawnSync } from 'child_process';
import { Command } from 'commander';

export function queryAction(prompt: string): void {
  const result = spawnSync('claude', ['--print', prompt], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

export function makeQueryCommand(): Command {
  return new Command('query')
    .description('one-shot prompt to claude (plain output, no session needed)')
    .argument('<prompt...>', 'prompt text (quoting optional)')
    .action((words: string[]) => queryAction(words.join(' ')));
}
