import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { Command } from 'commander';
import ora from 'ora';
import { ENGINE_LOG, ENGINE_PID, ENGINE_URL, isEngineRunning } from '../lib/engine.js';
import { errorOut } from '../lib/ui.js';

const HOME = homedir();
const ENGINE_SERVER = join(HOME, '.argus/agent-engine/dist/server/http.js');

export function makeServerCommand(): Command {
  const cmd = new Command('server').description('manage the agent-engine HTTP server');

  cmd
    .command('status')
    .description('check if the engine is running')
    .action(async () => {
      if (await isEngineRunning()) {
        console.log(`argus-agent engine: running at ${ENGINE_URL}`);
      } else {
        console.log('argus-agent engine: not running');
        process.exit(1);
      }
    });

  cmd
    .command('start')
    .description('start the engine HTTP server in the background')
    .action(async () => {
      if (await isEngineRunning()) {
        console.log(`argus-agent engine: already running at ${ENGINE_URL}`);
        return;
      }

      if (!existsSync(ENGINE_SERVER)) {
        errorOut(
          `dist not found at ${ENGINE_SERVER}\n       Run: cd ${HOME}/repos/argus/apps/agent-engine && npm run build`
        );
      }

      mkdirSync(dirname(ENGINE_PID), { recursive: true });

      const child = spawn('node', [ENGINE_SERVER], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env },
      });
      child.unref();
      writeFileSync(ENGINE_PID, String(child.pid));

      const spinner = ora('waiting for engine health check').start();
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (await isEngineRunning()) {
          spinner.succeed(`engine started (pid ${child.pid})`);
          return;
        }
      }

      spinner.fail(`started but health check timed out — see ${ENGINE_LOG}`);
    });

  cmd
    .command('stop')
    .description('stop the engine HTTP server')
    .action(() => {
      if (!existsSync(ENGINE_PID)) {
        console.log('argus-agent engine: no pid file found — may not be running');
        return;
      }

      const pid = parseInt(readFileSync(ENGINE_PID, 'utf8').trim(), 10);
      try {
        process.kill(pid, 'SIGTERM');
        unlinkSync(ENGINE_PID);
        console.log(`argus-agent engine: stopped (pid ${pid})`);
      } catch {
        unlinkSync(ENGINE_PID);
        console.log(`argus-agent engine: pid ${pid} was not running, cleaned up stale pid file`);
      }
    });

  return cmd;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
