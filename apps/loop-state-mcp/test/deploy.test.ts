// deploy.sh (argus-config#669): the homelab deploy. It writes ~/.config/argus/loop-state-mcp.env
// (argus-config#1267; the old apps/loop-state-mcp/.env is deprecated) from Bitwarden Secrets
// Manager (one token per role, never printed), builds, and links, enables and restarts the
// systemd user unit. Each test runs a copy of the real script and unit inside a throwaway
// HOME and repo, with bws, pnpm, systemctl and curl stubbed, so nothing touches ~/.argus,
// systemd or the network.
import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Makes a scratch dir a checkout at origin/deploy, which deploy.sh requires (argus-config#600).
const MAKE_DEPLOY_CHECKOUT = path.resolve(PACKAGE_DIR, '../../scripts/test-support/make-deploy-checkout.sh')
const UNIT = 'loop-state-mcp.service'

const TOKENS = {
  afk: 'afk-token-aaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'direction-token-dddddddddddddddddddd',
  worker: 'worker-token-wwwwwwwwwwwwwwwwwwwwwwww',
}

// `bws secret list -o json` answers with whatever FAKE_BWS_SECRETS holds.
const BWS_STUB = `#!/usr/bin/env bash
echo "bws $*" >> "$STUB_LOG"
printf '%s' "$FAKE_BWS_SECRETS"
`
const PNPM_STUB = `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
`
// `systemctl --user cat` succeeds only once the unit is linked, like the real one.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
if [[ "$2" == "cat" ]]; then
  [[ -e "$HOME/.config/systemd/user/$3" ]]
fi
`
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
[[ -z "\${FAKE_UNHEALTHY:-}" ]]
`

let home: string
let appDir: string
let stubLog: string

const envFile = () => path.join(home, '.config', 'argus', 'loop-state-mcp.env')

function secrets(values: Partial<Record<keyof typeof TOKENS, string>>): string {
  return JSON.stringify(Object.entries(values).map(([role, value]) => ({ key: `loop-state-token-${role}`, value })))
}

async function writeStub(name: string, body: string) {
  const stub = path.join(home, 'bin', name)
  await writeFile(stub, body)
  await chmod(stub, 0o755)
}

async function runDeploy(args: string[] = [], extraEnv: Record<string, string> = {}) {
  return execFileAsync('bash', [path.join(appDir, 'deploy.sh'), ...args], {
    env: {
      HOME: home,
      PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      STUB_LOG: stubLog,
      BWS_ACCESS_TOKEN: 'test-bws-access-token',
      FAKE_BWS_SECRETS: secrets(TOKENS),
      LOOP_STATE_HEALTH_TIMEOUT_SECONDS: '1',
      ...extraEnv,
    },
  })
}

async function stubLines(): Promise<string[]> {
  return (await readFile(stubLog, 'utf8')).split('\n').filter(Boolean)
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'loop-state-deploy-'))
  // The script finds the repo and its unit from its own location, so run a copy laid out
  // like the repo: <repo>/apps/loop-state-mcp/{deploy.sh,systemd/}.
  appDir = path.join(home, 'repo', 'apps', 'loop-state-mcp')
  stubLog = path.join(home, 'stub.log')
  await execFileAsync('bash', [MAKE_DEPLOY_CHECKOUT, path.join(home, 'repo')])
  await mkdir(path.join(appDir, 'systemd'), { recursive: true })
  await mkdir(path.join(home, 'bin'), { recursive: true })
  await copyFile(path.join(PACKAGE_DIR, 'deploy.sh'), path.join(appDir, 'deploy.sh'))
  await mkdir(path.join(home, 'repo', 'scripts', 'lib'), { recursive: true })
  await copyFile(path.resolve(PACKAGE_DIR, '../../scripts/lib/app-env.sh'), path.join(home, 'repo', 'scripts', 'lib', 'app-env.sh'))
  await copyFile(path.join(PACKAGE_DIR, 'systemd', UNIT), path.join(appDir, 'systemd', UNIT))
  await writeFile(stubLog, '')
  await writeStub('bws', BWS_STUB)
  await writeStub('pnpm', PNPM_STUB)
  await writeStub('systemctl', SYSTEMCTL_STUB)
  await writeStub('curl', CURL_STUB)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('deploy.sh .env', () => {
  it('writes every role token from BWS into a 0600 .env, with the db outside the repo', async () => {
    await runDeploy()

    const envPath = envFile()
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(envPath))).mode & 0o777).toBe(0o700)
    await expect(stat(path.join(appDir, '.env'))).rejects.toThrow(/ENOENT/)
    const env = await readFile(envPath, 'utf8')
    expect(env).toContain(`LOOP_STATE_TOKENS=afk=${TOKENS.afk},direction=${TOKENS.direction},worker=${TOKENS.worker}\n`)
    expect(env).toContain(`LOOP_STATE_DB=${home}/.argus/backlog-loop/loop.db\n`)
    expect(env).toContain('LOOP_STATE_HOST=127.0.0.1\n')
    expect(env).toContain('LOOP_STATE_PORT=3791\n')
    expect((await stat(path.join(home, '.argus', 'backlog-loop'))).mode & 0o777).toBe(0o700)
  })

  it('never prints a token', async () => {
    const { stdout, stderr } = await runDeploy(['--install'])

    for (const token of Object.values(TOKENS)) {
      expect(stdout).not.toContain(token)
      expect(stderr).not.toContain(token)
    }
  })

  it('refuses, and writes no .env, when a role has no token in BWS', async () => {
    const result = runDeploy([], { FAKE_BWS_SECRETS: secrets({ afk: TOKENS.afk, worker: TOKENS.worker }) })

    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('loop-state-token-direction') })
    await expect(stat(envFile())).rejects.toThrow(/ENOENT/)
  })

  it('warns, naming the old and the new path, when an old .env is left in the deploy copy', async () => {
    await writeFile(path.join(appDir, '.env'), 'OLD=1\n')

    const { stdout, stderr } = await runDeploy()

    expect(`${stdout}${stderr}`).toMatch(/deprecated/i)
    expect(`${stdout}${stderr}`).toContain(path.join(appDir, '.env'))
    expect(`${stdout}${stderr}`).toContain(envFile())
    expect(await readFile(path.join(appDir, '.env'), 'utf8')).toBe('OLD=1\n')
  })

  it('refuses a token shorter than the server accepts', async () => {
    const result = runDeploy([], { FAKE_BWS_SECRETS: secrets({ ...TOKENS, worker: 'short' }) })

    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('loop-state-token-worker is shorter than 24') })
  })

  it('refuses to run without a BWS access token', async () => {
    const result = runDeploy([], { BWS_ACCESS_TOKEN: '' })

    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('BWS_ACCESS_TOKEN') })
  })
})

describe('deploy.sh service', () => {
  it('builds only this package and leaves systemd alone when the unit is not installed', async () => {
    const { stdout } = await runDeploy()

    const lines = await stubLines()
    expect(lines).toContain('pnpm install --frozen-lockfile --filter @argus/loop-state-mcp...')
    expect(lines).toContain('pnpm --filter @argus/loop-state-mcp run build')
    expect(lines.filter((line) => line.startsWith('systemctl') && !line.includes(' cat '))).toEqual([])
    expect(stdout).toContain('not installed')
  })

  it('--install links the unit from the package, enables it, restarts it and waits for /healthz', async () => {
    const { stdout } = await runDeploy(['--install'])

    const link = path.join(home, '.config', 'systemd', 'user', UNIT)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(path.join(appDir, 'systemd', UNIT))
    const lines = await stubLines()
    expect(lines).toContain('systemctl --user daemon-reload')
    expect(lines).toContain(`systemctl --user enable ${UNIT}`)
    expect(lines).toContain(`systemctl --user restart ${UNIT}`)
    expect(lines.some((line) => line.startsWith('curl') && line.includes('http://127.0.0.1:3791/healthz'))).toBe(true)
    expect(stdout).toContain('/healthz answers')
  })

  it('reloads systemd before restarting an installed unit, so a changed unit file takes effect (homelab#424)', async () => {
    const unitDir = path.join(home, '.config', 'systemd', 'user')
    await mkdir(unitDir, { recursive: true })
    await symlink(path.join(appDir, 'systemd', UNIT), path.join(unitDir, UNIT))

    await runDeploy()

    const lines = await stubLines()
    const reload = lines.indexOf('systemctl --user daemon-reload')
    const restart = lines.indexOf(`systemctl --user restart ${UNIT}`)
    expect(reload).toBeGreaterThanOrEqual(0)
    expect(restart).toBeGreaterThan(reload)
  })

  it('fails when the restarted unit never answers /healthz', async () => {
    const result = runDeploy(['--install'], { FAKE_UNHEALTHY: '1' })

    await expect(result).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('journalctl --user -u loop-state-mcp') })
  })
})

describe('systemd unit', () => {
  it('runs the built server with the stable fnm node and the deploy-written .env', async () => {
    const unit = await readFile(path.join(PACKAGE_DIR, 'systemd', UNIT), 'utf8')

    expect(unit).toContain('WorkingDirectory=%h/repos/argus/apps/loop-state-mcp')
    // The new file loads after the old one so it wins; both optional while the old path retires.
    const legacy = unit.indexOf('EnvironmentFile=-%h/repos/argus/apps/loop-state-mcp/.env')
    expect(legacy).toBeGreaterThanOrEqual(0)
    expect(unit.indexOf('EnvironmentFile=-%h/.config/argus/loop-state-mcp.env')).toBeGreaterThan(legacy)
    expect(unit).toContain('ExecStart=%h/.local/share/fnm/aliases/default/bin/node dist/index.js')
    expect(unit).toContain('WantedBy=default.target')
  })

  // oomd killed this unit at 20:31 AEDT on 7 Nov 2026 at 14 MB, stalling every slot and tick
  // (homelab#424). `omit` takes it out of the candidate list; it must sit in [Service].
  it('is never an oomd kill candidate: ManagedOOMPreference=omit in [Service]', async () => {
    const unit = await readFile(path.join(PACKAGE_DIR, 'systemd', UNIT), 'utf8')
    const service = unit.split(/^\[Service\]$/m)[1]?.split(/^\[/m)[0] ?? ''

    expect(service).toMatch(/^ManagedOOMPreference=omit$/m)
  })
})
