import Table from 'cli-table3';
import { Command } from 'commander';
import ora from 'ora';
import { engineRequest, type SearchResult } from '../lib/engine.js';
import { engineFailure } from '../lib/ui.js';

export function makeSearchCommand(): Command {
  return new Command('search')
    .description('semantic search across the CORTEX vault')
    .argument('<query...>', 'search query')
    .option('-k, --results <n>', 'number of results to return', '5')
    .action(async (words: string[], opts: { results: string }) => {
      const query = words.join(' ');
      const k = parseInt(opts.results, 10);

      const spinner = ora('searching CORTEX vault').start();
      try {
        const { results = [] } = await engineRequest<{ results?: SearchResult[] }>('/vector/search', {
          query: { q: query, k: String(k) },
        });
        spinner.stop();

        if (results.length === 0) {
          console.log('No results.');
          return;
        }

        const table = new Table({ head: ['#', 'score', 'file'], style: { head: ['cyan'] } });
        results.forEach((r, i) => table.push([i + 1, r.score.toFixed(3), r.fileName]));
        console.log(table.toString());
        console.log();
        for (const [i, r] of results.entries()) {
          console.log(`${i + 1}. ${r.chunk.slice(0, 200)}`);
          console.log();
        }
      } catch (err) {
        engineFailure(err, spinner);
      }
    });
}
