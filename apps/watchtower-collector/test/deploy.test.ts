// deploy.sh (argus#53): it must install or refresh the systemd unit from the repo on every
// deploy, so a change to systemd/watchtower-collector.service reaches the host. Each test runs
// a copy of the real script and unit inside a throwaway HOME and repo, with bws, pnpm and
// systemctl stubbed, so nothing touches ~/.argus, the live unit or the network.
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Makes a scratch dir a checkout at origin/deploy, which deploy.sh requires (argus-config#600).
const MAKE_DEPLOY_CHECKOUT = path.resolve(PACKAGE_DIR, '../../scripts/test-support/make-deploy-checkout.sh')
const UNIT = 'watchtower-collector.service'

// `bws secret list -o json` answers an empty list: every secret is then missing, which the
// script tolerates for all but the private values, and those come from the env below.
const BWS_STUB = `#!/usr/bin/env bash
echo "bws $*" >> "$STUB_LOG"
echo '[]'
`
const PNPM_STUB = `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
`
// The unit counts as installed once a file of that name is in the user unit dir. `show`
// reports NeedDaemonReload=yes when FAKE_NEED_RELOAD is set, like systemd does for a unit
// whose file changed under a symlink.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
case "$2" in
  list-unit-files)
    if [[ -e "$HOME/.config/systemd/user/$3" ]]; then echo "$3 enabled enabled"; else exit 1; fi
    ;;
  show)
    if [[ -n "\${FAKE_NEED_RELOAD:-}" ]]; then echo yes; else echo no; fi
    ;;
esac
`

let home: string
let appDir: string
let stubLog: string
let unitDir: string

async function writeStub(name: string, body: string) {
  const stub = path.join(home, 'bin', name)
  await writeFile(stub, body)
  await chmod(stub, 0o755)
}

async function runDeploy(extraEnv: Record<string, string> = {}) {
  return execFileAsync('bash', [path.join(appDir, 'deploy.sh')], {
    env: {
      HOME: home,
      PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      STUB_LOG: stubLog,
      BWS_ACCESS_TOKEN: 'test-bws-access-token',
      // The private values and the CI list deploy.sh would otherwise fetch or look up.
      SYNCTHING_URL: 'https://syncthing.invalid:8384',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_ZONE_ID: 'zone',
      D1_DATABASES: 'argus-watchtower:db',
      AI_USAGE_WSL2_URL: 'http://usage.invalid:8765/usage',
      HOST_REPORT_WSL2_URL: '',
      CI_REPOS: 'argus',
      ...extraEnv,
    },
  })
}

async function stubLines(): Promise<string[]> {
  return (await readFile(stubLog, 'utf8')).split('\n').filter(Boolean)
}

const repoUnit = () => path.join(appDir, 'systemd', UNIT)
const installedUnit = () => path.join(unitDir, UNIT)

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'collector-deploy-'))
  // The script finds the repo and its unit from its own location, so run a copy laid out
  // like the repo: <repo>/apps/watchtower-collector/{deploy.sh,systemd/}.
  appDir = path.join(home, 'repo', 'apps', 'watchtower-collector')
  stubLog = path.join(home, 'stub.log')
  unitDir = path.join(home, '.config', 'systemd', 'user')
  await execFileAsync('bash', [MAKE_DEPLOY_CHECKOUT, path.join(home, 'repo')])
  await mkdir(path.join(appDir, 'systemd'), { recursive: true })
  await mkdir(path.join(home, 'bin'), { recursive: true })
  await mkdir(unitDir, { recursive: true })
  await copyFile(path.join(PACKAGE_DIR, 'deploy.sh'), path.join(appDir, 'deploy.sh'))
  await mkdir(path.join(home, 'repo', 'scripts', 'lib'), { recursive: true })
  await copyFile(path.resolve(PACKAGE_DIR, '../../scripts/lib/app-env.sh'), path.join(home, 'repo', 'scripts', 'lib', 'app-env.sh'))
  await copyFile(path.join(PACKAGE_DIR, 'systemd', UNIT), repoUnit())
  await writeFile(stubLog, '')
  await writeStub('bws', BWS_STUB)
  await writeStub('pnpm', PNPM_STUB)
  await writeStub('systemctl', SYSTEMCTL_STUB)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('deploy.sh systemd unit', () => {
  it('copies a changed unit from the repo, then reloads systemd before it restarts the service', async () => {
    await writeFile(installedUnit(), '[Service]\n# an older unit\n')

    await runDeploy()

    expect(await readFile(installedUnit(), 'utf8')).toBe(await readFile(repoUnit(), 'utf8'))
    const lines = await stubLines()
    const reload = lines.indexOf('systemctl --user daemon-reload')
    const restart = lines.indexOf(`systemctl --user restart ${UNIT}`)
    expect(reload).toBeGreaterThanOrEqual(0)
    expect(restart).toBeGreaterThan(reload)
  })

  it('leaves an unchanged unit alone: no copy (the mtime holds) and no reload', async () => {
    await copyFile(repoUnit(), installedUnit())
    const past = new Date('2026-01-01T00:00:00Z')
    await utimes(installedUnit(), past, past)

    await runDeploy()

    expect((await stat(installedUnit())).mtimeMs).toBe(past.getTime())
    const lines = await stubLines()
    expect(lines).not.toContain('systemctl --user daemon-reload')
    expect(lines).toContain(`systemctl --user restart ${UNIT}`)
  })

  it('does not write through a symlink into the checkout, and reloads when systemd reports it stale', async () => {
    await rm(installedUnit(), { force: true })
    await symlink(repoUnit(), installedUnit())
    const before = await readFile(repoUnit(), 'utf8')

    await runDeploy({ FAKE_NEED_RELOAD: '1' })

    expect(await readFile(repoUnit(), 'utf8')).toBe(before)
    const lines = await stubLines()
    expect(lines).toContain('systemctl --user daemon-reload')
    expect(lines.indexOf(`systemctl --user restart ${UNIT}`)).toBeGreaterThan(lines.indexOf('systemctl --user daemon-reload'))
  })

  it('installs nothing on a host where the unit is not installed', async () => {
    const { stdout } = await runDeploy()

    await expect(stat(installedUnit())).rejects.toThrow(/ENOENT/)
    const lines = await stubLines()
    expect(lines).not.toContain('systemctl --user daemon-reload')
    expect(lines.some((line) => line.includes('restart'))).toBe(false)
    expect(stdout).toContain('not installed')
  })
})
