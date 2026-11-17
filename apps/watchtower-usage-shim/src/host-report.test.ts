import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectHostReport, createHostReporter, parseMeminfo, parsePressure, type HostDeps } from './host-report.js'

// /proc/meminfo and /proc/pressure/memory from WSL2 on LNV-LGN5, 2026-10-16.
const MEMINFO = readFileSync(new URL('./__fixtures__/meminfo.txt', import.meta.url), 'utf8')
const PRESSURE = readFileSync(new URL('./__fixtures__/pressure-memory.txt', import.meta.url), 'utf8')

const LOCALAPPDATA = '/mnt/c/Users/deanj/AppData/Local'
const GB = 1024 ** 3

// The two WSL dumps in %LOCALAPPDATA%\Temp\wsl-crashes on 2026-10-16
// (2.4 GB each), plus a stray non-dump file the count must skip.
const FILES: Record<string, Record<string, { size: number; mtimeMs: number }>> = {
  [`${LOCALAPPDATA}/Temp/wsl-crashes`]: {
    'wsl-crash-1792140221-146843-_home_deanj_.local_share_fnm_node-versions_v22.22.2_installation_bin_node-6.dmp': { size: 2.4 * GB, mtimeMs: Date.parse('2026-10-16T08:45:00Z') },
    'wsl-crash-1792140532-154600-_home_deanj_.local_share_fnm_node-versions_v22.22.2_installation_bin_node-6.dmp': { size: 2.4 * GB, mtimeMs: Date.parse('2026-10-16T08:53:00Z') },
    'readme.txt': { size: 10, mtimeMs: 0 },
  },
  [`${LOCALAPPDATA}/CrashDumps`]: {
    'chat.exe.14076.dmp': { size: 71 * 1024 ** 2, mtimeMs: Date.parse('2026-03-01T21:14:00Z') },
    'brave.exe.8188.dmp': { size: 910 * 1024, mtimeMs: Date.parse('2026-04-13T01:06:00Z') },
  },
}

function deps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    // C: on 2026-10-16: 511 GB, 59 GB free.
    statfs: async () => ({ bsize: 4096, blocks: 511054966784 / 4096, bavail: 59012804608 / 4096 }),
    readdir: async (path) => {
      const dir = FILES[path]
      if (!dir) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return Object.keys(dir)
    },
    stat: async (path) => {
      const slash = path.lastIndexOf('/')
      const entry = FILES[path.slice(0, slash)]?.[path.slice(slash + 1)]
      if (!entry) throw new Error(`ENOENT: ${path}`)
      return entry
    },
    readFile: async (path) => {
      if (path === '/proc/meminfo') return MEMINFO
      if (path === '/proc/pressure/memory') return PRESSURE
      if (path === HEARTBEAT_PATH) return HEARTBEAT
      throw new Error(`unexpected read ${path}`)
    },
    isCheckout: async (dir) => dir !== '/home/deanj/NOTAVAULT',
    runVaultHook: async (_hook, dir) => (dir.endsWith('CONTEXT') ? `${UNPUBLISHED}\n` : ''),
    systemctl: async (args) => {
      if (args[1] === 'list-unit-files') return 'memory-reconcile.timer enabled enabled\nsystemd-tmpfiles-clean.timer disabled enabled\n'
      const unit = args[2]
      if (unit === 'systemd-tmpfiles-clean.timer') return 'Id=systemd-tmpfiles-clean.timer\nUnit=systemd-tmpfiles-clean.service\nUnitFileState=disabled\n'
      if (unit === 'systemd-tmpfiles-clean.service') return 'Id=systemd-tmpfiles-clean.service\n'
      if (unit === 'memory-reconcile.timer') return 'Id=memory-reconcile.timer\nUnit=memory-reconcile.service\nActiveState=active\n'
      if (unit === 'memory-reconcile.service') return 'Id=memory-reconcile.service\nActiveState=inactive\nResult=success\n'
      return `Id=${unit}\nActiveState=active\nSubState=running\n`
    },
    runT3Stale: async () => `${T3_READING}\n`,
    now: () => Date.parse('2026-10-16T11:30:00Z'),
    ...overrides,
  }
}

// The reconciler's real heartbeat on WSL2, 2026-10-16 13:27 UTC, and the
// hook's real output for a vault with commits stuck since 05:00.
const HEARTBEAT_PATH = '/home/deanj/.argus/memory-reconcile-heartbeat.json'
const HEARTBEAT = '{"lastRunAt":"2026-10-16T13:27:11.964Z","ok":true,"written":0,"deleted":0,"committed":false,"refusals":[{"key":"project-linux-server","reason":"hash-mismatch","detail":"no longer hashes","seenAt":"2026-09-29T00:47:15.970Z"}]}'
const UNPUBLISHED = "Vault sync: CONTEXT has 3 unpublished commit(s), oldest 8h — publishing has stopped. Check the vault sync timer's journal."
const HOOK = '/home/deanj/.argus/hooks/vault-staleness.sh'
// hooks/t3-stale.py --no-state on WSL2, 2026-11-11.
const T3_READING = '{"host": "wsl2", "active": "0.1.8-nightly.20261109.4399", "channel": "nightly", "threshold_days": 3, "newest": "0.1.9", "behind_days": 1, "stale": false}'
const T3_HOOK = '/home/deanj/.argus/hooks/t3-stale.py'

const CONFIG = {
  diskPath: '/mnt/c',
  localAppData: LOCALAPPDATA,
  units: ['agent-engine.service', 'memory-reconcile.timer'],
  heartbeatPath: HEARTBEAT_PATH,
  vaultHookPath: HOOK,
  t3StaleHookPath: T3_HOOK,
  t3Host: 'wsl2',
  vaults: [
    { name: 'CONTEXT', path: '/home/deanj/CONTEXT' },
    { name: 'CORTEX', path: '/home/deanj/CORTEX' },
  ],
}

describe('parseMeminfo', () => {
  it('reads total, available and swap in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 6067836 * 1024,
      availableBytes: 3199476 * 1024,
      swapTotalBytes: 2097152 * 1024,
      swapFreeBytes: 526004 * 1024,
    })
  })
})

describe('parsePressure', () => {
  it('reads the some and full averages', () => {
    expect(parsePressure(PRESSURE)).toEqual({
      some: { avg10: 0.08, avg60: 0.08, avg300: 0.14 },
      full: { avg10: 0.06, avg60: 0.05, avg300: 0.13 },
    })
  })
})

describe('collectHostReport', () => {
  it('reports C:, both dump folders, memory and the units', async () => {
    const report = await collectHostReport(CONFIG, deps())
    expect(report.reportedAt).toBe('2026-10-16T11:30:00.000Z')
    expect(report.disk).toEqual({ path: '/mnt/c', totalBytes: 511054966784, freeBytes: 59012804608 })
    expect(report.crashDumps.wsl).toEqual({
      path: `${LOCALAPPDATA}/Temp/wsl-crashes`,
      count: 2,
      totalBytes: 4.8 * GB,
      newestAt: '2026-10-16T08:53:00.000Z',
    })
    expect(report.crashDumps.windows).toMatchObject({ count: 2, newestAt: '2026-04-13T01:06:00.000Z' })
    expect(report.memory.pressure?.some.avg60).toBe(0.08)
    expect(report.memory.availableBytes).toBe(3199476 * 1024)
    expect(report.units['agent-engine.service']).toEqual({ unit: { Id: 'agent-engine.service', ActiveState: 'active', SubState: 'running' } })
    expect(report.units['memory-reconcile.timer']?.triggers).toMatchObject({ Id: 'memory-reconcile.service', Result: 'success' })
  })

  it('reads units with --user under TZ=UTC-safe arguments', async () => {
    const calls: string[][] = []
    await collectHostReport(CONFIG, deps({ systemctl: async (args) => (calls.push(args), `Id=${args[2]}\n`) }))
    expect(calls[0]?.slice(0, 3)).toEqual(['--user', 'show', 'agent-engine.service'])
    expect(calls[0]?.[3]).toMatch(/^--property=.*LastTriggerUSec/)
    // The collector judges a per-unit timer with no next trigger from it.
    expect(calls[0]?.[3]).toMatch(/,NextElapseUSecMonotonic$/)
  })

  it('counts a missing dump folder as no dumps', async () => {
    const report = await collectHostReport({ ...CONFIG, localAppData: '/mnt/c/Users/nobody/AppData/Local' }, deps())
    expect(report.crashDumps.wsl).toEqual({ path: '/mnt/c/Users/nobody/AppData/Local/Temp/wsl-crashes', count: 0, totalBytes: 0, newestAt: null })
  })

  it('reports C: as null when /mnt/c is not mounted', async () => {
    const report = await collectHostReport(CONFIG, deps({ statfs: async () => { throw new Error('ENOENT') } }))
    expect(report.disk).toBeNull()
  })

  it('reports no pressure on a kernel without PSI', async () => {
    const readFile: HostDeps['readFile'] = async (path) => {
      if (path === '/proc/meminfo') return MEMINFO
      throw new Error('ENOENT')
    }
    expect((await collectHostReport(CONFIG, deps({ readFile }))).memory.pressure).toBeNull()
  })

  it('reports a unit systemctl cannot read as not-found rather than failing the report', async () => {
    const systemctl: HostDeps['systemctl'] = async () => {
      throw new Error('Failed to connect to bus')
    }
    const report = await collectHostReport(CONFIG, deps({ systemctl }))
    expect(report.units['agent-engine.service']?.unit).toMatchObject({ Id: 'agent-engine.service', LoadState: 'error', error: 'Failed to connect to bus' })
  })
})

describe('silent-failure parts of the report', () => {
  it('reports every --user timer, disabled ones included, with the property list the collector judges', async () => {
    const calls: string[][] = []
    const base = deps()
    const report = await collectHostReport(CONFIG, { ...base, systemctl: async (args) => (calls.push(args), base.systemctl(args)) })
    expect(Object.keys(report.timers ?? {})).toEqual(['memory-reconcile.timer', 'systemd-tmpfiles-clean.timer'])
    expect(report.timers?.['systemd-tmpfiles-clean.timer']?.unit.UnitFileState).toBe('disabled')
    expect(report.timers?.['memory-reconcile.timer']?.triggers).toMatchObject({ Id: 'memory-reconcile.service', Result: 'success' })
    expect(calls).toContainEqual(['--user', 'list-unit-files', '--type=timer', '--no-legend', '--plain'])
    const timerShow = calls.find((args) => args[1] === 'show' && args[2] === 'systemd-tmpfiles-clean.timer')
    expect(timerShow?.[3]).toMatch(/NextElapseUSecRealtime,NextElapseUSecMonotonic,UnitFileState,FragmentPath$/)
  })

  // The shapes systemctl really prints on WSL2 once loop-wake@.timer exists:
  // list-unit-files names the template, list-units names its instances, and
  // `show` on the template is refused outright (the collector's copy of this,
  // timer-freshness.test.ts, uses the same fixture).
  const TEMPLATE_UNIT_FILES = 'loop-wake@.timer disabled enabled\nmemory-reconcile.timer enabled enabled\n'
  const INSTANCE_UNITS = 'loop-wake@afk.timer loaded active waiting Loop wake afk\nmemory-reconcile.timer loaded active waiting Memory reconcile\n'

  function templateAwareDeps(show?: (unit: string) => string) {
    const calls: string[][] = []
    const systemctl: HostDeps['systemctl'] = async (args) => {
      calls.push(args)
      if (args[1] === 'list-unit-files') return TEMPLATE_UNIT_FILES
      if (args[1] === 'list-units') return INSTANCE_UNITS
      const unit = args[2] as string
      if (unit.includes('@.')) throw new Error(`Command failed: systemctl --user show ${unit}\nUnit name ${unit} is neither a valid invocation ID nor unit name.`)
      if (show) return show(unit)
      if (unit.endsWith('.timer')) return `Id=${unit}\nLoadState=loaded\nUnit=${unit.replace('.timer', '.service')}\nUnitFileState=enabled\n`
      return `Id=${unit}\nResult=success\n`
    }
    return { deps: deps({ systemctl }), calls }
  }

  it('never runs show on a template, and reports its instances from list-units', async () => {
    const { deps: templateDeps, calls } = templateAwareDeps()
    const report = await collectHostReport(CONFIG, templateDeps)
    expect(Object.keys(report.timers ?? {}).sort()).toEqual(['loop-wake@afk.timer', 'memory-reconcile.timer'])
    expect(calls.filter((args) => args[1] === 'show').every((args) => !(args[2] as string).includes('@.'))).toBe(true)
    expect(calls).toContainEqual(['--user', 'list-units', '--type=timer', '--all', '--no-legend', '--plain'])
    expect(report.timers?.['loop-wake@afk.timer']?.triggers).toMatchObject({ Id: 'loop-wake@afk.service', Result: 'success' })
  })

  it('reports a timer once when list-units and list-unit-files both name it', async () => {
    const { deps: templateDeps, calls } = templateAwareDeps()
    await collectHostReport(CONFIG, templateDeps)
    // CONFIG.units also shows memory-reconcile.timer, with the shorter property list.
    const timerCardShows = calls.filter((args) => args[1] === 'show' && args[2] === 'memory-reconcile.timer' && args[3]?.endsWith('FragmentPath'))
    expect(timerCardShows).toHaveLength(1)
  })

  it('reports the one timer whose show fails as not loaded, not the whole listing', async () => {
    const { deps: templateDeps } = templateAwareDeps((unit) => {
      if (unit === 'loop-wake@afk.timer') throw new Error('Connection timed out')
      return unit.endsWith('.timer') ? `Id=${unit}\nLoadState=loaded\nUnit=${unit.replace('.timer', '.service')}\n` : `Id=${unit}\nResult=success\n`
    })
    const report = await collectHostReport(CONFIG, templateDeps)
    expect(Object.keys(report.timers ?? {}).sort()).toEqual(['loop-wake@afk.timer', 'memory-reconcile.timer'])
    expect(report.timers?.['memory-reconcile.timer']?.unit.LoadState).toBe('loaded')
    expect(report.timers?.['loop-wake@afk.timer']?.unit).toMatchObject({ Id: 'loop-wake@afk.timer', LoadState: 'error' })
    expect(report.timers?.['loop-wake@afk.timer']?.triggers).toBeUndefined()
  })

  it('reports timers as absent when list-units fails, since the instances are then unknown', async () => {
    const base = templateAwareDeps()
    const systemctl: HostDeps['systemctl'] = async (args) => {
      if (args[1] === 'list-units') throw new Error('Failed to connect to bus')
      return base.deps.systemctl(args)
    }
    const report = await collectHostReport(CONFIG, { ...base.deps, systemctl })
    expect(report.timers).toBeUndefined()
  })

  it('reports timers as absent, not empty, when systemctl cannot list them', async () => {
    const report = await collectHostReport(CONFIG, deps({ systemctl: async () => { throw new Error('Failed to connect to bus') } }))
    expect(report.timers).toBeUndefined()
  })

  it('passes the memory-reconcile heartbeat through as parsed JSON', async () => {
    const report = await collectHostReport(CONFIG, deps())
    expect(report.memoryReconcile).toEqual({ path: HEARTBEAT_PATH, heartbeat: JSON.parse(HEARTBEAT), error: null })
  })

  it('reports no heartbeat file as null, and a broken one as an error', async () => {
    const missing = deps({ readFile: async (path) => { if (path === HEARTBEAT_PATH) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return deps().readFile(path) } })
    expect((await collectHostReport(CONFIG, missing)).memoryReconcile).toEqual({ path: HEARTBEAT_PATH, heartbeat: null, error: null })
    const broken = deps({ readFile: async (path) => (path === HEARTBEAT_PATH ? '{"lastRunAt":' : deps().readFile(path)) })
    expect((await collectHostReport(CONFIG, broken)).memoryReconcile?.error).toMatch(/JSON/)
  })

  it('runs vault-staleness.sh once per vault and keeps its lines', async () => {
    const runs: string[] = []
    const base = deps()
    const report = await collectHostReport(CONFIG, { ...base, runVaultHook: async (hook, dir) => (runs.push(`${hook} ${dir}`), base.runVaultHook(hook, dir)) })
    expect(runs).toEqual([`${HOOK} /home/deanj/CONTEXT`, `${HOOK} /home/deanj/CORTEX`])
    expect(report.vaults).toEqual([
      { name: 'CONTEXT', path: '/home/deanj/CONTEXT', checkout: true, lines: [UNPUBLISHED], error: null },
      { name: 'CORTEX', path: '/home/deanj/CORTEX', checkout: true, lines: [], error: null },
    ])
  })

  it('reports a vault that is not a checkout, and a hook that fails', async () => {
    const config = { ...CONFIG, vaults: [{ name: 'NOTAVAULT', path: '/home/deanj/NOTAVAULT' }, { name: 'CORTEX', path: '/home/deanj/CORTEX' }] }
    const report = await collectHostReport(config, deps({ runVaultHook: async () => { throw new Error('bash: hook: No such file or directory') } }))
    expect(report.vaults?.[0]).toMatchObject({ checkout: false, lines: [], error: null })
    expect(report.vaults?.[1]?.error).toMatch(/No such file/)
  })
})

describe('T3 staleness part of the report', () => {
  it('runs t3-stale.py for the configured host and keeps the JSON it prints', async () => {
    const runs: string[] = []
    const report = await collectHostReport(CONFIG, deps({ runT3Stale: async (hook, host) => (runs.push(`${hook} ${host}`), `${T3_READING}\n`) }))
    expect(runs).toEqual([`${T3_HOOK} wsl2`])
    expect(report.t3Stale).toEqual({ reading: JSON.parse(T3_READING), error: null })
  })

  it('reports a hook that cannot run, and output that is not JSON, without failing the report', async () => {
    const missing = await collectHostReport(CONFIG, deps({ runT3Stale: async () => { throw new Error(`python3: can't open file '${T3_HOOK}'`) } }))
    expect(missing.t3Stale?.reading).toBeNull()
    expect(missing.t3Stale?.error).toMatch(/can't open file/)
    expect(missing.memory.totalBytes).toBeGreaterThan(0)
    const garbled = await collectHostReport(CONFIG, deps({ runT3Stale: async () => 'Traceback (most recent call last):' }))
    expect(garbled.t3Stale?.error).toMatch(/not JSON/)
  })
})

describe('createHostReporter', () => {
  it('reruns the vault hook at most every four minutes, and everything else every time', async () => {
    let now = Date.parse('2026-10-16T13:30:00Z')
    let hookRuns = 0
    let meminfoReads = 0
    const base = deps()
    const report = createHostReporter(CONFIG, {
      ...base,
      now: () => now,
      runVaultHook: async (hook, dir) => (hookRuns++, base.runVaultHook(hook, dir)),
      readFile: async (path) => (path === '/proc/meminfo' && meminfoReads++, base.readFile(path)),
    })
    await report()
    now += 3 * 60_000
    await report()
    expect([hookRuns, meminfoReads]).toEqual([2, 2])
    now += 2 * 60_000
    await report()
    expect(hookRuns).toBe(4)
  })

  it('reruns the T3 hook at most every four minutes, as the vault hook', async () => {
    let now = Date.parse('2026-11-11T00:00:00Z')
    let t3Runs = 0
    const report = createHostReporter(CONFIG, { ...deps(), now: () => now, runT3Stale: async () => (t3Runs++, `${T3_READING}\n`) })
    await report()
    now += 3 * 60_000
    expect((await report()).t3Stale?.error).toBeNull()
    expect(t3Runs).toBe(1)
    now += 2 * 60_000
    await report()
    expect(t3Runs).toBe(2)
  })
})
