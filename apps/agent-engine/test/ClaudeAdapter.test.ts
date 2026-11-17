import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn, __mockSpawn: mockSpawn };
});

import { claudeAdapter, ClaudeSessionNotFoundError } from '../src/models/ClaudeAdapter.js';

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

function assistantApiErrorEvent(errorCode: string, text: string) {
  return {
    type: 'assistant',
    error: errorCode,
    is_api_error_message: true,
    message: { content: [{ type: 'text', text }] },
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

const SESSION_ID = '00000000-0000-4000-8000-000000000006';

describe('ClaudeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ask()', () => {
    it('resolves with the authoritative result text assembled from streamed deltas', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([streamEvent('hello '), streamEvent('world'), resultEvent('hello world')]),
      );
      const result = await claudeAdapter.ask('test prompt');
      expect(result).toBe('hello world');
    });

    it('invokes onDelta once per streamed text chunk, in order', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([streamEvent('hello '), streamEvent('world'), resultEvent('hello world')]),
      );
      const deltas: string[] = [];
      await claudeAdapter.ask('test prompt', { onDelta: (text) => deltas.push(text) });
      expect(deltas).toEqual(['hello ', 'world']);
    });

    it('falls back to concatenated deltas when no result event arrives', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([streamEvent('partial only')]));
      const result = await claudeAdapter.ask('test prompt');
      expect(result).toBe('partial only');
    });

    it('ignores non-JSON / hook-noise lines interleaved in the stream', async () => {
      const mockSpawn = await getMockSpawn();
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.kill = vi.fn();
      mockSpawn.mockReturnValueOnce(proc);

      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('not json at all\n'));
        proc.stdout.emit('data', Buffer.from(`${JSON.stringify(resultEvent('ok'))}\n`));
        proc.emit('close', 0);
      }, 0);

      const result = await claudeAdapter.ask('prompt');
      expect(result).toBe('ok');
    });

    it('spawns claude with the stream-json flags', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('my prompt');
      expect(mockSpawn).toHaveBeenCalledWith('claude', [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--settings',
        '{"disableAllHooks":true}',
        'my prompt',
      ]);
    });

    it('starts a new session with --session-id, keeping the prompt last', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('first turn', { sessionId: SESSION_ID });
      expect(mockSpawn).toHaveBeenCalledWith('claude', [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--settings',
        '{"disableAllHooks":true}',
        '--session-id',
        SESSION_ID,
        'first turn',
      ]);
    });

    it('resumes an existing session with --resume, keeping the prompt last', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('second turn', { resume: SESSION_ID });
      expect(mockSpawn).toHaveBeenCalledWith('claude', [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--settings',
        '{"disableAllHooks":true}',
        '--resume',
        SESSION_ID,
        'second turn',
      ]);
    });

    it('passes --append-system-prompt through when given', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('prompt', { appendSystemPrompt: 'Be terse.' });
      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args.slice(-3)).toEqual(['--append-system-prompt', 'Be terse.', 'prompt']);
    });

    it('textOnly strips every built-in tool and every MCP server, prompt still last', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('prompt', { textOnly: true });
      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain('--tools=');
      expect(args).toContain('--strict-mcp-config');
      expect(args.at(-1)).toBe('prompt');
    });

    it('leaves tools and MCP servers alone by default', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await claudeAdapter.ask('prompt');
      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--tools=');
      expect(args).not.toContain('--strict-mcp-config');
    });

    it('rejects with ClaudeSessionNotFoundError when --resume names an unknown session', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([
          {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: [`No conversation found with session ID: ${SESSION_ID}`],
          },
        ]),
      );
      const failure = claudeAdapter.ask('prompt', { resume: SESSION_ID });
      await expect(failure).rejects.toBeInstanceOf(ClaudeSessionNotFoundError);
      await expect(failure).rejects.toThrow(`No conversation found with session ID: ${SESSION_ID}`);
    });

    it('reports the result event errors array when there is no result text', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess([
          { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['something broke'] },
        ]),
      );
      const failure = claudeAdapter.ask('prompt');
      await expect(failure).rejects.toThrow('something broke');
      await expect(failure).rejects.not.toBeInstanceOf(ClaudeSessionNotFoundError);
    });

    it('reassembles NDJSON lines split across multiple data chunks', async () => {
      const mockSpawn = await getMockSpawn();
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.kill = vi.fn();
      mockSpawn.mockReturnValueOnce(proc);

      const line = `${JSON.stringify(resultEvent('split works'))}\n`;
      const mid = Math.floor(line.length / 2);

      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from(line.slice(0, mid)));
        proc.stdout.emit('data', Buffer.from(line.slice(mid)));
        proc.emit('close', 0);
      }, 0);

      const result = await claudeAdapter.ask('prompt');
      expect(result).toBe('split works');
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

      await expect(claudeAdapter.ask('prompt')).rejects.toThrow('spawn failed');
    });

    it('rejects on non-zero exit with no structured error', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([], 1));
      await expect(claudeAdapter.ask('prompt')).rejects.toThrow('exit code 1');
    });

    it('rejects with the CLI-reported message from an is_error result event', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess(
          [resultEvent('model not found', { isError: true, subtype: 'error_during_execution' })],
          1,
        ),
      );
      await expect(claudeAdapter.ask('prompt')).rejects.toThrow('model not found');
    });

    it('rejects with the CLI-reported error code from an assistant API-error event', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(
        makeChildProcess(
          [
            assistantApiErrorEvent('model_not_found', "There's an issue with the selected model."),
            resultEvent("There's an issue with the selected model.", { isError: true }),
          ],
          1,
        ),
      );
      await expect(claudeAdapter.ask('prompt')).rejects.toThrow('model_not_found');
    });
  });
  describe('askInSession()', () => {
    it('resumes the session when the CLI already has it', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('remembered')]));
      const result = await claudeAdapter.askInSession('turn 2', SESSION_ID);
      expect(result).toBe('remembered');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]![1]).toContain('--resume');
    });

    it('starts the session under the same id when the CLI has no such conversation', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn
        .mockReturnValueOnce(
          makeChildProcess([
            {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: [`No conversation found with session ID: ${SESSION_ID}`],
            },
          ]),
        )
        .mockReturnValueOnce(makeChildProcess([resultEvent('fresh')]));
      const result = await claudeAdapter.askInSession('turn 1', SESSION_ID);
      expect(result).toBe('fresh');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const startArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(startArgs.slice(-3)).toEqual(['--session-id', SESSION_ID, 'turn 1']);
    });

    it('does not retry on any other failure', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('rate limited', { isError: true })], 1));
      await expect(claudeAdapter.askInSession('turn', SESSION_ID)).rejects.toThrow('rate limited');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('inherited user hooks (#608)', () => {
    const spawnedArgs = (mockSpawn: ReturnType<typeof vi.fn>, call = 0) => mockSpawn.mock.calls[call]![1] as string[];
    const expectHooksOff = (args: string[]) => {
      const at = args.indexOf('--settings');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(args[at + 1]).toBe('{"disableAllHooks":true}');
      expect(args.at(-1)).toBe('p');
    };

    it.each([
      ['one-shot', (): Promise<string> => claudeAdapter.ask('p')],
      ['new session', (): Promise<string> => claudeAdapter.ask('p', { sessionId: SESSION_ID })],
      ['resumed session', (): Promise<string> => claudeAdapter.ask('p', { resume: SESSION_ID })],
      ['append-system-prompt', (): Promise<string> => claudeAdapter.ask('p', { appendSystemPrompt: 'terse' })],
    ])('passes inline --settings disableAllHooks on the %s path', async (_name, run) => {
      const mockSpawn = await getMockSpawn();
      mockSpawn.mockReturnValueOnce(makeChildProcess([resultEvent('ok')]));
      await run();
      expectHooksOff(spawnedArgs(mockSpawn));
    });

    it('disables hooks on both turns of askInSession (resume, then start fallback)', async () => {
      const mockSpawn = await getMockSpawn();
      mockSpawn
        .mockReturnValueOnce(
          makeChildProcess([
            {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: [`No conversation found with session ID: ${SESSION_ID}`],
            },
          ]),
        )
        .mockReturnValueOnce(makeChildProcess([resultEvent('fresh')]));
      await claudeAdapter.askInSession('p', SESSION_ID);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expectHooksOff(spawnedArgs(mockSpawn, 0));
      expectHooksOff(spawnedArgs(mockSpawn, 1));
    });
  });
});
