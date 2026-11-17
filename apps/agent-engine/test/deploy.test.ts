// deploy.sh (#658): the install must be non-interactive, loud and fatal on
// failure, the runtime pnpm-workspace.yaml is written rather than trusted, a
// smoke test proves better-sqlite3's binding loads, and `server` mode must not
// delete or overwrite the server's *.db files. Each test runs a copy of the real
// script against a throwaway HOME with stubbed pnpm, ssh and (for server mode)
// rsync, so nothing touches ~/.argus or the network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Makes a scratch dir a checkout at origin/deploy, which deploy.sh requires (argus-config#600).
const MAKE_DEPLOY_CHECKOUT = path.resolve(PACKAGE_DIR, '../../scripts/test-support/make-deploy-checkout.sh');

// Records its argv and the environment pnpm would install under, then fakes
// just enough of each subcommand. FAKE_INSTALL_FAIL / FAKE_BINDING_BROKEN
// switch on the two failure modes from #658.
const PNPM_STUB = `#!/usr/bin/env bash
echo "CI=\${CI:-} $*" >> "$STUB_LOG"
case "$1" in
  --version) echo "11.0.0" ;;
  run)
    mkdir -p dist/server && echo "// built" > dist/server/http.js
    ;;
  install)
    if [[ -n "\${FAKE_INSTALL_FAIL:-}" ]]; then
      echo "ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY" >&2
      exit 1
    fi
    mkdir -p node_modules/better-sqlite3
    if [[ -n "\${FAKE_BINDING_BROKEN:-}" ]]; then
      echo "module.exports = class { constructor() { throw new Error('Could not locate the bindings file'); } };" > node_modules/better-sqlite3/index.js
    else
      echo "module.exports = class { close() {} };" > node_modules/better-sqlite3/index.js
    fi
    ;;
esac
`;

// ssh just logs. rsync logs, then delegates to the real one for the local
// dist/ sync and skips the remote (host:path) transfer.
const SSH_STUB = `#!/usr/bin/env bash
echo "ssh $*" >> "$STUB_LOG"
`;
const RSYNC_STUB = `#!/usr/bin/env bash
echo "rsync $*" >> "$STUB_LOG"
for arg in "$@"; do
  [[ "$arg" == *:* ]] && exit 0
done
exec /usr/bin/rsync "$@"
`;

// systemctl logs every call. `cat` (the unit-exists probe) fails when
// FAKE_UNIT_ABSENT is set; `restart` fails when FAKE_RESTART_FAIL is set.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
case "$2" in
  cat) [[ -z "\${FAKE_UNIT_ABSENT:-}" ]] ;;
  restart) [[ -z "\${FAKE_RESTART_FAIL:-}" ]] ;;
esac
`;

// curl logs, then fails the first FAKE_HEALTH_FAILS calls (every call when
// FAKE_HEALTH_DOWN is set) so the health poll can be seen retrying or giving up.
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
[[ -n "\${FAKE_HEALTH_DOWN:-}" ]] && exit 22
count_file="$STUB_LOG.curl-count"
count=$(cat "$count_file" 2>/dev/null || echo 0)
echo $((count + 1)) > "$count_file"
(( count >= \${FAKE_HEALTH_FAILS:-0} )) || exit 22
echo '{"ok":true}'
`;

let home: string;
let srcDir: string;
let destDir: string;
let stubLog: string;

async function writeStub(name: string, body: string) {
  const stub = path.join(home, 'bin', name);
  await writeFile(stub, body);
  await chmod(stub, 0o755);
}

async function runDeploy(target: string, extraEnv: Record<string, string> = {}) {
  return execFileAsync('bash', [path.join(srcDir, 'deploy.sh'), target], {
    env: {
      HOME: home,
      PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      STUB_LOG: stubLog,
      ARGUS_HEALTH_ATTEMPTS: '3',
      ARGUS_HEALTH_INTERVAL: '0',
      ...extraEnv,
    },
  });
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'engine-deploy-'));
  // SRC_DIR is derived from the script's own location, so run a copy: the stub
  // `pnpm run build` then writes dist/ into the scratch dir, not the repo.
  srcDir = path.join(home, 'repo', 'apps', 'agent-engine');
  await execFileAsync('bash', [MAKE_DEPLOY_CHECKOUT, path.join(home, 'repo')]);
  destDir = path.join(home, '.argus/agent-engine');
  stubLog = path.join(home, 'stub.log');
  await mkdir(path.join(home, 'bin'), { recursive: true });
  await mkdir(srcDir, { recursive: true });
  await copyFile(path.join(PACKAGE_DIR, 'deploy.sh'), path.join(srcDir, 'deploy.sh'));
  await writeFile(path.join(srcDir, 'package.json'), '{"name":"@argus/agent-engine","type":"module"}\n');
  await writeFile(stubLog, '');
  await writeStub('pnpm', PNPM_STUB);
  await writeStub('ssh', SSH_STUB);
  await writeStub('rsync', RSYNC_STUB);
  await writeStub('systemctl', SYSTEMCTL_STUB);
  await writeStub('curl', CURL_STUB);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('deploy.sh deploy-branch guard (argus-config#600)', () => {
  it('refuses a checkout that is not what origin/deploy holds, before it builds or syncs anything', async () => {
    await execFileAsync('git', ['-C', path.join(home, 'repo'), 'commit', '--allow-empty', '-m', 'unpromoted'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });

    await expect(runDeploy('local')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Refusing to deploy'),
    });
    expect(await readFile(stubLog, 'utf8')).toBe('');
  });
});

describe('deploy.sh local', () => {
  it('installs non-interactively and visibly', async () => {
    const { stdout } = await runDeploy('local');

    const install = (await readFile(stubLog, 'utf8')).split('\n').find((line) => line.includes(' install'));
    expect(install).toBeDefined();
    expect(install).toContain('CI=true');
    expect(install).toContain('--prod');
    expect(install).toContain('--no-frozen-lockfile');
    expect(install).toContain('--config.confirmModulesPurge=false');
    expect(install).not.toContain('--silent');
    expect(stdout).toContain('dependencies installed');
    expect(stdout).toContain('better-sqlite3 loads');
  });

  it('overwrites a malformed runtime allowBuilds', async () => {
    await mkdir(destDir, { recursive: true });
    await writeFile(
      path.join(destDir, 'pnpm-workspace.yaml'),
      "allowBuilds:\n  '0': better-sqlite3\n  better-sqlite3: false\n",
    );

    await runDeploy('local');

    expect(await readFile(path.join(destDir, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      'allowBuilds:\n  better-sqlite3: true\n  esbuild: true\n  onnxruntime-node: false\n  protobufjs: false\n',
    );
  });

  it('drops a stale runtime lockfile before installing', async () => {
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, 'pnpm-lock.yaml'), 'lockfileVersion: stale\n');

    await runDeploy('local');

    await expect(readFile(path.join(destDir, 'pnpm-lock.yaml'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('fails the deploy, with the install error visible, when the install fails', async () => {
    const result = runDeploy('local', { FAKE_INSTALL_FAIL: '1' });

    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY'),
    });
  });

  it('fails the deploy when better-sqlite3 will not load', async () => {
    const result = runDeploy('local', { FAKE_BINDING_BROKEN: '1' });

    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('better-sqlite3 failed to load'),
    });
  });
});

// #802: local mode used to rebuild dist/ and stop, so the running unit kept
// serving the old code. It now restarts the unit and waits for /health.
describe('deploy.sh local restart', () => {
  const logLines = async () => (await readFile(stubLog, 'utf8')).split('\n');

  it('restarts the installed unit after the runtime copy, then polls /health', async () => {
    const { stdout } = await runDeploy('local');

    const log = await logLines();
    expect(log).toContain('systemctl --user cat agent-engine');
    expect(log).toContain('systemctl --user restart agent-engine');
    expect(log.findIndex((line) => line.includes(' install'))).toBeLessThan(
      log.indexOf('systemctl --user restart agent-engine'),
    );
    expect(log.some((line) => line.startsWith('curl') && line.includes('http://localhost:3747/health'))).toBe(true);
    expect(stdout).toContain('Deploy complete — agent-engine restarted and healthy');
    expect(stdout).not.toContain('Start: node');
  });

  it('retries /health until the restarted engine answers', async () => {
    const { stdout } = await runDeploy('local', { FAKE_HEALTH_FAILS: '2' });

    expect((await logLines()).filter((line) => line.startsWith('curl'))).toHaveLength(3);
    expect(stdout).toContain('restarted and healthy');
  });

  it('fails loudly when /health never answers', async () => {
    const result = runDeploy('local', { FAKE_HEALTH_DOWN: '1' });

    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('did not answer /health'),
    });
    expect((await logLines()).filter((line) => line.startsWith('curl'))).toHaveLength(3);
  });

  it('fails the deploy when the restart itself fails', async () => {
    const result = runDeploy('local', { FAKE_RESTART_FAIL: '1' });

    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('restart failed'),
    });
    expect((await logLines()).some((line) => line.startsWith('curl'))).toBe(false);
  });

  it('exits 0 with the install hint and no restart when the unit is not installed', async () => {
    const { stdout } = await runDeploy('local', { FAKE_UNIT_ABSENT: '1' });

    const log = await logLines();
    expect(log).toContain('systemctl --user cat agent-engine');
    expect(log.some((line) => line.includes('restart'))).toBe(false);
    expect(log.some((line) => line.startsWith('curl'))).toBe(false);
    expect(stdout).toContain('agent-engine unit not installed');
    expect(stdout).toContain('systemd/install-agent-engine.sh');
    expect(stdout).toContain('Start: node');
    expect(stdout).toContain('Deploy complete — runtime synced, service NOT restarted');
  });
});

describe('deploy.sh server', () => {
  it('does not restart the local unit while building for a server deploy', async () => {
    await runDeploy('server');

    const log = (await readFile(stubLog, 'utf8')).split('\n');
    expect(log.some((line) => line.startsWith('systemctl'))).toBe(false);
    expect(log).toContain('ssh srvr@homelab systemctl --user restart agent-engine');
  });

  it('keeps *.db out of the --delete sync to the server', async () => {
    await runDeploy('server');

    const log = (await readFile(stubLog, 'utf8')).split('\n');
    const remoteSync = log.find((line) => line.startsWith('rsync') && line.includes('--delete') && /:/.test(line.replace('rsync ', '')));
    expect(remoteSync).toBeDefined();
    expect(remoteSync).toContain("--exclude=*.db");
    expect(remoteSync).toContain("--exclude=*.db-wal");
    expect(remoteSync).toContain("--exclude=*.db-shm");
    expect(remoteSync).toContain("--exclude=.env");
    expect(remoteSync).toContain("--exclude=pnpm-workspace.yaml");
  });
});
