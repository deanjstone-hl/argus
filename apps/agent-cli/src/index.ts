#!/usr/bin/env node
import { Command } from 'commander';
import { makeDoctorCommand } from './commands/doctor.js';
import { makeQueryCommand, queryAction } from './commands/query.js';
import { makeReadCommand } from './commands/read.js';
import { makeRunCommand } from './commands/run.js';
import { makeSearchCommand } from './commands/search.js';
import { makeServerCommand } from './commands/server.js';
import { makeWriteCommand } from './commands/write.js';

const program = new Command();

program
  .name('agent')
  .description(
    [
      'agent-engine dispatcher and Claude Code utilities',
      '',
      'Agent-engine (requires: agent server start):',
      '  agent run <prompt>            Dispatch a prompt to the agent-engine',
      '  agent run --session <uuid> …  Multi-turn: run in that conversation',
      '  agent run --continue <prompt> Resume the last --session conversation',
      '  agent search <query>          Semantic search across the CORTEX vault',
      '  agent read <file>             Print a vault file to stdout',
      '  agent write <file>            Write to a vault file (--content or stdin)',
      '  agent server status           Check if the engine HTTP server is running',
      '  agent server start            Start the engine HTTP server (background)',
      '  agent server stop             Stop the engine HTTP server',
      '',
      'Utilities:',
      '  agent -q "<prompt>"           One-shot claude prompt (plain output, scriptable)',
      '  agent query <prompt words...> Same as -q but variadic (no quoting needed)',
      '  agent doctor                  Check health of the full argus stack',
    ].join('\n')
  )
  .version('1.0.0')
  .option('-q, --query <prompt>', 'one-shot prompt to claude (plain output, no session)')
  .option('-u, --usage', 'show help and exit')
  .action((options: { query?: string; usage?: boolean }) => {
    if (options.query) return queryAction(options.query);
    program.help();
  });

program.addCommand(makeRunCommand());
program.addCommand(makeSearchCommand());
program.addCommand(makeReadCommand());
program.addCommand(makeWriteCommand());
program.addCommand(makeServerCommand());
program.addCommand(makeQueryCommand());
program.addCommand(makeDoctorCommand());

program.parseAsync().catch((err: Error) => {
  console.error('agent:', err.message);
  process.exit(1);
});
