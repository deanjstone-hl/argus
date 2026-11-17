import { spawn } from 'child_process';
import { DISABLE_HOOKS_ARGS } from './claudeCliArgs.js';

export interface AskOptions {
  timeout?: number;
  /** Invoked with each text delta as the CLI streams its response. */
  onDelta?: (text: string) => void;
}

const ANSI_PATTERN = /\x1B\[[0-9;]*[mGKHF]/g;

/**
 * Parses one line of the `claude --print --output-format stream-json` NDJSON
 * stream and folds it into the accumulator. Mutates `acc` in place.
 *
 * Event shapes observed from `claude` CLI 2.1.226 (see
 * docs/decisions/adr-009-claude-adapter-stays-cli-based.md for why we stay
 * CLI-based rather than calling the Messages API directly). Mirrors
 * `ClaudeAdapter.ts`'s parsing — kept duplicated rather than shared so each
 * adapter file stays self-contained (see #103 scope).
 */
function applyStreamEvent(
  line: string,
  acc: { deltaText: string; resultText: string | null; errorMessage: string | null },
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
        const detail = typeof event.result === 'string' && event.result ? event.result : `subtype ${event.subtype ?? 'unknown'}`;
        acc.errorMessage = `${adapterName}: ${detail}`;
      }
      break;
    }
    default:
      break;
  }
}

class HaikuAdapter {
  private readonly adapterName = 'HaikuAdapter';

  async ask(prompt: string, options?: AskOptions): Promise<string> {
    const timeout = options?.timeout ?? 120000;
    const onDelta = options?.onDelta;

    return new Promise((resolve, reject) => {
      const acc = { deltaText: '', resultText: null as string | null, errorMessage: null as string | null };
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
        '--model',
        'claude-haiku-4-5-20251001',
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
            reject(new Error(acc.errorMessage));
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

  async classify(
    prompt: string,
    categories: string[],
    options?: AskOptions,
  ): Promise<{ category: string; confidence: number }> {
    const classificationPrompt = `${prompt}\n\nAvailable categories: ${categories.join(', ')}\n\nRespond with valid JSON: { "category": "<category>", "confidence": <number between 0 and 1> }`;

    const response = await this.ask(classificationPrompt, options);

    try {
      const parsed = JSON.parse(response);

      if (typeof parsed.category !== 'string' || typeof parsed.confidence !== 'number') {
        throw new Error('classify() response missing category/confidence fields');
      }

      return {
        category: parsed.category,
        confidence: parsed.confidence,
      };
    } catch (error) {
      console.error(
        `HaikuAdapter.classify(): failed to parse CLI response as { category, confidence } JSON — ${
          error instanceof Error ? error.message : String(error)
        }. Raw response: ${response}`,
      );
      return {
        category: categories[0],
        confidence: 0,
      };
    }
  }
}

export const haikuAdapter = new HaikuAdapter();
