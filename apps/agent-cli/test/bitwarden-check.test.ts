import { describe, expect, it, vi } from 'vitest';
import {
  BW_STATUS_TIMEOUT_MS,
  checkBitwarden,
  queryBwStatus,
  type BwStatusResult,
} from '../src/lib/bitwarden-check.js';

const HOME = '/home/tester';
const MASTER = `${HOME}/.bw_master`;
const SESSION = `${HOME}/.bw_session`;

function run(options: { files?: string[]; bw?: BwStatusResult }) {
  const files = new Set(options.files ?? []);
  const bwStatus = vi.fn(() => options.bw ?? { kind: 'missing' as const });
  const result = checkBitwarden({ homeDir: HOME, fileExists: (path) => files.has(path), bwStatus });
  return { result, bwStatus };
}

describe('checkBitwarden', () => {
  it.each(['locked', 'unlocked'] as const)('passes when ~/.bw_master exists and bw reports %s', (status) => {
    const { result } = run({ files: [MASTER], bw: { kind: 'status', status } });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(status);
  });

  it('passes when ~/.bw_session exists, without needing bw', () => {
    const { result } = run({ files: [SESSION] });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('.bw_session');
  });

  it('fails when neither ~/.bw_master nor ~/.bw_session is available', () => {
    const { result, bwStatus } = run({ bw: { kind: 'status', status: 'unlocked' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('.bw_master');
    expect(result.detail).toContain('.bw_session');
    expect(bwStatus).not.toHaveBeenCalled();
  });

  it('does not treat the legacy /tmp/bw_session as a session', () => {
    const files = new Set(['/tmp/bw_session']);
    const result = checkBitwarden({
      homeDir: HOME,
      fileExists: (path) => files.has(path),
      bwStatus: () => ({ kind: 'missing' }),
    });
    expect(result.ok).toBe(false);
  });

  it('fails when ~/.bw_master exists but bw is missing', () => {
    const { result } = run({ files: [MASTER], bw: { kind: 'missing' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('bw');
    expect(result.detail).toContain('not found');
  });

  it('fails when ~/.bw_master exists but bw is unauthenticated', () => {
    const { result } = run({ files: [MASTER], bw: { kind: 'status', status: 'unauthenticated' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unauthenticated');
  });

  it('fails when bw status times out and there is no session file', () => {
    const { result } = run({ files: [MASTER], bw: { kind: 'timeout' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out');
  });

  it('fails when bw status output is unusable', () => {
    const { result } = run({ files: [MASTER], bw: { kind: 'error', reason: 'unparseable output' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unparseable output');
  });

  it('still passes on ~/.bw_session when bw status fails', () => {
    const { result } = run({ files: [MASTER, SESSION], bw: { kind: 'timeout' } });
    expect(result.ok).toBe(true);
  });
});

describe('queryBwStatus', () => {
  const spawnReturning = (value: Record<string, unknown>) => vi.fn(() => value) as never;

  it('parses only the status field of the JSON', () => {
    const stdout = JSON.stringify({ status: 'locked', userEmail: 'x@example.com', serverUrl: 'https://s' });
    expect(queryBwStatus(spawnReturning({ status: 0, stdout }))).toEqual({ kind: 'status', status: 'locked' });
  });

  it('runs bw status with a timeout, non-interactively', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '{"status":"unlocked"}' }));
    queryBwStatus(spawn as never);
    expect(BW_STATUS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(BW_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(spawn).toHaveBeenCalledWith(
      'bw',
      ['status', '--nointeraction'],
      expect.objectContaining({ timeout: BW_STATUS_TIMEOUT_MS, encoding: 'utf8' })
    );
  });

  it('reports a timeout when the child is killed for exceeding it', () => {
    const error = Object.assign(new Error('spawnSync bw ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(queryBwStatus(spawnReturning({ status: null, error }))).toEqual({ kind: 'timeout' });
  });

  it('reports bw missing on ENOENT', () => {
    const error = Object.assign(new Error('spawnSync bw ENOENT'), { code: 'ENOENT' });
    expect(queryBwStatus(spawnReturning({ status: null, error }))).toEqual({ kind: 'missing' });
  });

  it('reports an error on non-zero exit', () => {
    expect(queryBwStatus(spawnReturning({ status: 1, stdout: '' })).kind).toBe('error');
  });

  it('reports an error on unparseable output without echoing it', () => {
    const result = queryBwStatus(spawnReturning({ status: 0, stdout: 'SECRET-LOOKING-TEXT' }));
    expect(result.kind).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET-LOOKING-TEXT');
  });

  it('reports an error on an unknown status value', () => {
    expect(queryBwStatus(spawnReturning({ status: 0, stdout: '{"status":"weird"}' })).kind).toBe('error');
  });
});
