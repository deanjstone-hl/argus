import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { join } from 'path';

export const BW_STATUS_TIMEOUT_MS = 5000;

const USABLE_STATUSES = new Set(['locked', 'unlocked']);
const KNOWN_STATUSES = new Set([...USABLE_STATUSES, 'unauthenticated']);

export type BwStatusResult =
  | { kind: 'status'; status: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string };

export interface BitwardenCheckDeps {
  homeDir: string;
  fileExists: (path: string) => boolean;
  bwStatus: () => BwStatusResult;
}

type SpawnBw = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
) => Pick<ReturnType<typeof spawnSync>, 'status' | 'stdout' | 'error'>;

/**
 * Runs `bw status` and reads only the `status` field. The rest of the JSON (account
 * email, server URL) is never kept, and unparseable output is never echoed back.
 */
export function queryBwStatus(spawn: SpawnBw = spawnSync as unknown as SpawnBw): BwStatusResult {
  const child = spawn('bw', ['status', '--nointeraction'], {
    encoding: 'utf8',
    timeout: BW_STATUS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const code = (child.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return { kind: 'missing' };
  if (code === 'ETIMEDOUT') return { kind: 'timeout' };
  if (child.error) return { kind: 'error', reason: `bw status failed (${code ?? 'spawn error'})` };
  if (child.status !== 0) return { kind: 'error', reason: `bw status exited ${child.status}` };

  let status: unknown;
  try {
    status = (JSON.parse(String(child.stdout)) as { status?: unknown }).status;
  } catch {
    return { kind: 'error', reason: 'bw status returned unparseable output' };
  }
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) {
    return { kind: 'error', reason: 'bw status returned an unknown status' };
  }
  return { kind: 'status', status };
}

function describeBwFailure(result: BwStatusResult): string {
  switch (result.kind) {
    case 'missing':
      return 'bw not found on PATH';
    case 'timeout':
      return `bw status timed out after ${BW_STATUS_TIMEOUT_MS / 1000}s`;
    case 'error':
      return result.reason;
    case 'status':
      return `bw is ${result.status} — run: bw login`;
  }
}

/**
 * Passes when headless unlock is possible (`~/.bw_master` plus a logged-in `bw`) or an
 * interactive `bw-unlock` session was saved to `~/.bw_session`. Only file existence and
 * the `bw status` state are checked — neither secret is ever read.
 */
export function checkBitwarden(deps: BitwardenCheckDeps): { ok: boolean; detail: string } {
  const masterFile = join(deps.homeDir, '.bw_master');
  const sessionFile = join(deps.homeDir, '.bw_session');

  let masterProblem: string | undefined;
  if (deps.fileExists(masterFile)) {
    const result = deps.bwStatus();
    if (result.kind === 'status' && USABLE_STATUSES.has(result.status)) {
      return { ok: true, detail: `~/.bw_master present, vault ${result.status}` };
    }
    masterProblem = describeBwFailure(result);
  }

  if (deps.fileExists(sessionFile)) {
    return { ok: true, detail: '~/.bw_session present' };
  }

  if (masterProblem) {
    return { ok: false, detail: `~/.bw_master present but ${masterProblem}` };
  }
  return { ok: false, detail: 'neither ~/.bw_master nor ~/.bw_session found' };
}
