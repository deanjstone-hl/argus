import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { ENGINE_URL, isEngineRunning } from '../lib/engine.js';
import { checkBitwarden, queryBwStatus } from '../lib/bitwarden-check.js';
import { fail, ok as okColor } from '../lib/ui.js';

const HOME = homedir();
const CORTEX_DIR = join(HOME, 'CORTEX');
const CLAUDE_MD = join(HOME, '.claude/CLAUDE.md');
const SKILLS_DIR = join(HOME, '.claude/skills');

function report(label: string, passed: boolean, detail: string): boolean {
  const mark = passed ? okColor('✓') : fail('✗');
  console.log(`  ${mark}  ${label.padEnd(14)} ${detail}`);
  return passed;
}

function systemdEnabled(unit: string): boolean {
  return spawnSync('systemctl', ['--user', 'is-enabled', '--quiet', unit]).status === 0;
}

function checkSkills(): { ok: boolean; detail: string } {
  if (!existsSync(SKILLS_DIR)) {
    return { ok: false, detail: `not found: ${SKILLS_DIR}` };
  }
  const entries = readdirSync(SKILLS_DIR);
  const broken = entries.filter((name) => !existsSync(join(SKILLS_DIR, name)));
  if (broken.length > 0) {
    return { ok: false, detail: `${broken.length}/${entries.length} broken symlink(s): ${broken.join(', ')}` };
  }
  return { ok: true, detail: `${entries.length} skill(s) linked` };
}

export function makeDoctorCommand(): Command {
  return new Command('doctor')
    .description('check health of the argus stack')
    .action(async () => {
      console.log('agent doctor\n');
      let allOk = true;

      const engineOk = await isEngineRunning();
      allOk =
        report('engine', engineOk, engineOk ? `running at ${ENGINE_URL}` : 'not running — try: agent server start') &&
        allOk;

      const engineAutostartOk = systemdEnabled('agent-engine');
      allOk =
        report(
          'engine-boot',
          engineAutostartOk,
          engineAutostartOk
            ? 'systemd unit enabled — starts on login'
            : 'not enabled — run: bash ~/repos/argus/apps/agent-engine/systemd/install-agent-engine.sh'
        ) && allOk;

      const cortexOk = existsSync(CORTEX_DIR);
      allOk = report('cortex', cortexOk, cortexOk ? `${CORTEX_DIR} reachable` : `not found: ${CORTEX_DIR}`) && allOk;

      const claudeMdOk = existsSync(CLAUDE_MD);
      allOk =
        report('claude.md', claudeMdOk, claudeMdOk ? `${CLAUDE_MD} reachable` : `broken symlink or missing: ${CLAUDE_MD}`) &&
        allOk;

      const skills = checkSkills();
      allOk = report('skills', skills.ok, skills.detail) && allOk;

      const bitwarden = checkBitwarden({ homeDir: HOME, fileExists: existsSync, bwStatus: queryBwStatus });
      allOk = report('bitwarden', bitwarden.ok, bitwarden.detail) && allOk;

      console.log();
      if (allOk) {
        console.log('  All checks passed.');
      } else {
        console.log('  Some checks failed.');
        process.exit(1);
      }
    });
}
