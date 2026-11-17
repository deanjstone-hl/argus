import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn, __mockSpawn: mockSpawn };
});

import { haikuAdapter } from '../src/models/HaikuAdapter.js';

async function getMockSpawn() {
  const mod = await import('child_process');
  return (mod as any).__mockSpawn as ReturnType<typeof vi.fn>;
}

function streamEvent(text: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

function resultEvent(result: string, opts: { isError?: boolean; subtype?: string } = {}) {
  return {
    type: 'result',
    subtype: opts.subtype ?? 'success',
    is_error: opts.isError ?? false,
    result,
  };
}

/**
 * Emits each NDJSON event as its own `data` chunk (mirroring the real CLI,
 * which writes one line per SSE event rather than one blob) and then closes
 * the process with `exitCode`.
 */
function makeChildProcess(events: unknown[], exitCode: number = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.kill = vi.fn();

  setTimeout(() => {
    for (const event of events) {
      proc.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
    }
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

describe('HaikuAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ask()', () => {
    it('resolves with the authoritative result text assembled from streamed deltas', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([streamEvent('hello '), streamEvent('world'), resultEvent('hello world')]),
      );
      const result = await haikuAdapter.ask('test prompt');
      expect(result).toBe('hello world');
    });

    it('invokes onDelta once per streamed text chunk, in order', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([streamEvent('hel'), streamEvent('lo'), resultEvent('hello')]),
      );
      const deltas: string[] = [];
      await haikuAdapter.ask('test prompt', { onDelta: (text) => deltas.push(text) });
      expect(deltas).toEqual(['hel', 'lo']);
    });

    it('spawns claude with the haiku model and stream-json flags', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await haikuAdapter.ask('my prompt');
      expect(mockSpawn).toHaveBeenCalledWith('claude', [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--settings',
        '{"disableAllHooks":true}',
        '--model',
        'claude-haiku-4-5-20251001',
        'my prompt',
      ]);
    });

    it('handles child process spawn errors', async () => {
      const mockSpawn = await getMockSpawn();
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.kill = vi.fn();
      mockSpawn.mockReturnValueOnce(proc);

      setTimeout(() => {
        proc.emit('error', new Error('spawn failed'));
      }, 0);

      await expect(haikuAdapter.ask('prompt')).rejects.toThrow('spawn failed');
    });

    it('rejects on non-zero exit codes with no structured error', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([], 1));
      await expect(haikuAdapter.ask('prompt')).rejects.toThrow('exit code 1');
    });

    it('rejects with the CLI-reported message from an is_error result event', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([resultEvent('model not found', { isError: true })], 1),
      );
      await expect(haikuAdapter.ask('prompt')).rejects.toThrow('model not found');
    });
  });

  describe('classify()', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns parsed category and confidence', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([resultEvent('{"category":"engineering","confidence":0.9}')]),
      );
      const result = await haikuAdapter.classify('what type?', ['engineering', 'bulk_ingestion']);
      expect(result.category).toBe('engineering');
      expect(result.confidence).toBe(0.9);
    });

    it('returns first category with 0 confidence and logs on invalid JSON', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('not valid json')]));
      const result = await haikuAdapter.classify('what?', ['engineering', 'other']);
      expect(result.category).toBe('engineering');
      expect(result.confidence).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('HaikuAdapter.classify()');
    });

    it('returns first category with 0 confidence and logs when JSON is missing required fields', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('{"foo":"bar"}')]));
      const result = await haikuAdapter.classify('what?', ['engineering', 'other']);
      expect(result.category).toBe('engineering');
      expect(result.confidence).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('HaikuAdapter.classify()');
    });
  });
});
