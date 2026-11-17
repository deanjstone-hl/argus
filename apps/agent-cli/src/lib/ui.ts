import chalk from 'chalk';
import type { Ora } from 'ora';
import { EngineNotRunningError } from './engine.js';

export const ok = (s: string) => chalk.green(s);
export const fail = (s: string) => chalk.red(s);

export function errorOut(message: string): never {
  console.error(`${chalk.red('agent:')} ${message}`);
  process.exit(1);
}

/**
 * Exit 1 for a failed engineRequest(). Not-running always prints the
 * `agent:` start hint; any other failure goes to the spinner when there is one.
 */
export function engineFailure(err: unknown, spinner?: Ora): never {
  const message = (err as Error).message;
  if (spinner && !(err instanceof EngineNotRunningError)) {
    spinner.fail(message);
    process.exit(1);
  }
  spinner?.stop();
  errorOut(message);
}
