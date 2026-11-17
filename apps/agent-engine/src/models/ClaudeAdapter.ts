import { spawn } from 'child_process';
import { DISABLE_HOOKS_ARGS } from './claudeCliArgs.js';

export interface AskOptions {
  timeout?: number;
  /** Invoked with each text delta as the CLI streams its response. */
  onDelta?: (text: string) => void;
  /** Starts a new CLI session under this UUID (`--session-id`). */
  sessionId?: string;
  /** Continues an existing CLI session (`--resume`). */
  resume?: string;
  /** Extra system-prompt text for the turn (`--append-system-prompt`). */
  appendSystemPrompt?: string;
  /**
   * No built-in tools and no MCP servers, for a prompt that carries text the
   * owner did not write. `--tools=` takes the empty value in its `=` form: the
   * option is variadic, and a separate empty argument would swallow the prompt.
   */
  textOnly?: boolean;
}

/** The CLI's result error when `--resume` names a session it has no transcript for. */
const SESSION_NOT_FOUND_PATTERN = /No conversation found with session ID/;

/** `--resume` named a session the CLI does not have. */
export class ClaudeSessionNotFoundError extends Error {
  override name = 'ClaudeSessionNotFoundError';
}

const ANSI_PATTERN = /\x1B\[[0-9;]*[mGKHF]/g;

/**
 * Parses one line of the `claude --print --output-format stream-json` NDJSON
 * stream and folds it into the accumulator. Mutates `acc` in place and
 * returns it for convenience.
 *
 * Event shapes observed from `claude` CLI 2.1.226 (see
 * docs/decisions/adr-009-claude-adapter-stays-cli-based.md for why we stay
 * CLI-based rather than calling the Messages API directly):
 * - `stream_event` wraps a Messages-API-shaped SSE event; the deltas we care
 *   about are `content_block_delta` events with `delta.type === 'text_delta'`.
 * - `assistant` carries a full (non-streamed) message snapshot, and — for
 *   CLI-level API errors (e.g. unknown model) — an `error` code and
 *   `is_api_error_message: true`.
 * - `result` is the terminal event: `result.result` holds the final response
 *   text (authoritative — used in preference to concatenated deltas) and
 *   `is_error`/`subtype`/`api_error_status` describe failures. Failures that
 *   happen before any model call (e.g. `--resume` of an unknown session, seen
 *   on CLI 2.1.296) carry no `result` text, only an `errors` string array.
 */
function applyStreamEvent(
  line: string,
  acc: { deltaText: string; resultText: string | null; errorMessage: string | null; sessionNotFound: boolean },
  adapterName: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Not a JSON line (stray CLI output) — ignore rather than fail the whole stream.
    return;
  }

  switch (event.type) {
    case 'stream_event': {
      const inner = event.event;
      if (
        inner?.type === 'content_block_delta' &&
        inner.delta?.type === 'text_delta' &&
        typeof inner.delta.text === 'string'
      ) {
        acc.deltaText += inner.delta.text;
      }
      break;
    }
    case 'assistant': {
      if (event.error || event.is_api_error_message) {
        const detail =
          typeof event.error === 'string'
            ? event.error
            : event.message?.content?.find((b: any) => b.type === 'text')?.text;
        acc.errorMessage = `${adapterName}: ${detail ?? 'CLI reported an API error'}`;
      }
      break;
    }
    case 'result': {
      if (typeof event.result === 'string') {
        acc.resultText = event.result;
      }
      if (event.is_error && !acc.errorMessage) {
        const errors = Array.isArray(event.errors)
          ? event.errors.filter((e: unknown): e is string => typeof e === 'string')
          : [];
        const detail =
          typeof event.result === 'string' && event.result
            ? event.result
            : errors.length > 0
              ? errors.join('; ')
              : `subtype ${event.subtype ?? 'unknown'}`;
        acc.errorMessage = `${adapterName}: ${detail}`;
        acc.sessionNotFound = errors.some((e: string) => SESSION_NOT_FOUND_PATTERN.test(e));
      }
      break;
    }
    default:
      break;
  }
}

class ClaudeAdapter {
  private readonly adapterName = 'ClaudeAdapter';

  async ask(prompt: string, options?: AskOptions): Promise<string> {
    const timeout = options?.timeout ?? 120000;
    const onDelta = options?.onDelta;

    return new Promise((resolve, reject) => {
      const acc = {
        deltaText: '',
        resultText: null as string | null,
        errorMessage: null as string | null,
        sessionNotFound: false,
      };
      let lineBuffer = '';
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const args = [
        '--print',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        ...DISABLE_HOOKS_ARGS,
        ...(options?.sessionId ? ['--session-id', options.sessionId] : []),
        ...(options?.resume ? ['--resume', options.resume] : []),
        ...(options?.appendSystemPrompt ? ['--append-system-prompt', options.appendSystemPrompt] : []),
        ...(options?.textOnly ? ['--tools=', '--strict-mcp-config'] : []),
        prompt,
      ];

      const child = spawn('claude', args);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        fn();
      };

      const consumeLine = (line: string) => {
        const before = acc.deltaText;
        applyStreamEvent(line, acc, this.adapterName);
        if (onDelta && acc.deltaText.length > before.length) {
          onDelta(acc.deltaText.slice(before.length));
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        lineBuffer += data.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      });

      child.on('error', (error: Error) => {
        settle(() => reject(error));
      });

      child.on('close', (code: number | null) => {
        if (lineBuffer.trim()) {
          consumeLine(lineBuffer);
          lineBuffer = '';
        }

        settle(() => {
          if (acc.errorMessage) {
            reject(acc.sessionNotFound ? new ClaudeSessionNotFoundError(acc.errorMessage) : new Error(acc.errorMessage));
            return;
          }

          if (code !== 0 && code !== null) {
            reject(new Error(`${this.adapterName}: exit code ${code}`));
            return;
          }

          const finalText = acc.resultText ?? acc.deltaText;
          resolve(finalText.replace(ANSI_PATTERN, '').trim());
        });
      });

      timeoutHandle = setTimeout(() => {
        child.kill();
        settle(() => reject(new Error(`${this.adapterName} timeout`)));
      }, timeout);
    });
  }

  /**
   * One turn of a conversation the CLI persists under `sessionId`: resumes it
   * if the CLI has it, otherwise starts it under that id. Sessions are stored
   * per working directory, so this relies on the engine's fixed cwd.
   */
  async askInSession(prompt: string, sessionId: string, options?: Omit<AskOptions, 'sessionId' | 'resume'>): Promise<string> {
    try {
      return await this.ask(prompt, { ...options, resume: sessionId });
    } catch (err) {
      if (!(err instanceof ClaudeSessionNotFoundError)) throw err;
      return this.ask(prompt, { ...options, sessionId });
    }
  }
}

export const claudeAdapter = new ClaudeAdapter();
