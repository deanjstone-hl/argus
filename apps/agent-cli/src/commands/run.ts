import { randomUUID } from 'crypto';
import { Command } from 'commander';
import ora from 'ora';
import { engineChat } from '../lib/engine.js';
import { isSessionId, readLastSession, saveLastSession } from '../lib/session.js';
import { engineFailure, errorOut } from '../lib/ui.js';

interface RunOptions {
  session?: string;
  continue?: boolean;
}

/** The session this turn runs in, or undefined for a one-shot turn. */
function resolveSession(options: RunOptions): string | undefined {
  if (options.session !== undefined && options.continue) {
    errorOut('use either --session or --continue, not both');
  }
  if (options.session !== undefined) {
    if (!isSessionId(options.session)) errorOut(`--session must be a UUID (got "${options.session}")`);
    return options.session;
  }
  if (!options.continue) return undefined;

  let stored: string | undefined;
  try {
    stored = readLastSession();
  } catch (err) {
    errorOut((err as Error).message);
  }
  if (stored) return stored;
  const started = randomUUID();
  console.error(`agent: no previous session, started ${started}`);
  return started;
}

export function makeRunCommand(): Command {
  return new Command('run')
    .description('dispatch a prompt to the agent-engine')
    .argument('<prompt...>', 'prompt text')
    .option('-s, --session <uuid>', 'run the turn in this conversation (a UUID); --continue then resumes it')
    .option('-c, --continue', 'resume the last --session conversation (starts one if there is none)')
    .action(async (words: string[], options: RunOptions) => {
      const prompt = words.join(' ');
      const sessionId = resolveSession(options);
      const spinner = ora('dispatching to agent-engine').start();
      try {
        const data = await engineChat(prompt, sessionId);
        spinner.stop();
        if (sessionId !== undefined) saveLastSession(sessionId);
        process.stdout.write(String(data.text ?? '') + '\n');
      } catch (err) {
        engineFailure(err, spinner);
      }
    });
}
