import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeReadCommand } from '../src/commands/read.js';
import { makeRunCommand } from '../src/commands/run.js';
import { makeSearchCommand } from '../src/commands/search.js';
import { makeWriteCommand } from '../src/commands/write.js';

const { spinnerFailMock } = vi.hoisted(() => ({ spinnerFailMock: vi.fn() }));
vi.mock('ora', () => ({
  default: () => {
    const spinner = { start: () => spinner, stop: () => spinner, fail: spinnerFailMock };
    return spinner;
  },
}));

type EngineRoute = (url: URL, init?: RequestInit) => Response | Promise<Response>;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, '');

let stderrLines: string[];
let stdoutText: string;

function stubEngine(handlers: { health?: EngineRoute; route?: EngineRoute }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/health') {
        if (!handlers.health) throw new TypeError('fetch failed');
        return handlers.health(url, init);
      }
      if (!handlers.route) throw new Error(`unexpected engine call ${url.pathname}`);
      return handlers.route(url, init);
    })
  );
}

const healthy: EngineRoute = () => new Response('ok');
const json = (body: unknown, status = 200) => () => Response.json(body, { status });

async function runCli(command: Command, args: string[]): Promise<number | undefined> {
  try {
    await command.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  }
}

const commands: Array<{ name: string; make: () => Command; args: string[]; errorChannel: 'stderr' | 'spinner' }> = [
  { name: 'run', make: makeRunCommand, args: ['hello', 'there'], errorChannel: 'spinner' },
  { name: 'search', make: makeSearchCommand, args: ['needle'], errorChannel: 'spinner' },
  { name: 'read', make: makeReadCommand, args: ['MEMORY/note.md'], errorChannel: 'stderr' },
  { name: 'write', make: makeWriteCommand, args: ['MEMORY/note.md', '--content', 'body'], errorChannel: 'stderr' },
];

beforeEach(() => {
  stderrLines = [];
  stdoutText = '';
  spinnerFailMock.mockReset();
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(code === null || code === undefined ? undefined : Number(code));
  });
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderrLines.push(stripAnsi(parts.join(' ')));
  });
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    stdoutText += parts.join(' ') + '\n';
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutText += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(commands)('agent $name against the engine', ({ make, args, errorChannel }) => {
  const reportedError = () => (errorChannel === 'spinner' ? spinnerFailMock.mock.calls.map((c) => String(c[0])) : stderrLines);
  const expectedLine = (message: string) => (errorChannel === 'spinner' ? message : `agent: ${message}`);

  it('exits 1 with the start hint when the engine is not running', async () => {
    stubEngine({});
    const code = await runCli(make(), args);
    expect(code).toBe(1);
    expect(stderrLines).toEqual(['agent: engine not running. Start it with: agent server start']);
  });

  it('treats a non-ok /health as not running', async () => {
    stubEngine({ health: () => new Response('down', { status: 503 }) });
    const code = await runCli(make(), args);
    expect(code).toBe(1);
    expect(stderrLines).toEqual(['agent: engine not running. Start it with: agent server start']);
  });

  it('exits 1 reporting the HTTP status when the engine returns non-ok', async () => {
    stubEngine({ health: healthy, route: json({ error: 'kaboom' }, 500) });
    const code = await runCli(make(), args);
    expect(code).toBe(1);
    expect(reportedError()).toEqual([expectedLine('engine returned 500')]);
  });

  it('exits 1 reporting data.error when the engine answers 200 with an error body', async () => {
    stubEngine({ health: healthy, route: json({ error: 'vault offline' }) });
    const code = await runCli(make(), args);
    expect(code).toBe(1);
    expect(reportedError()).toEqual([expectedLine('vault offline')]);
  });

  it('exits 1 reporting the fetch failure when the engine drops the connection', async () => {
    stubEngine({
      health: healthy,
      route: () => {
        throw new TypeError('fetch failed');
      },
    });
    const code = await runCli(make(), args);
    expect(code).toBe(1);
    expect(reportedError()).toEqual([expectedLine('fetch failed')]);
  });
});

describe('engine success paths', () => {
  it('run posts the joined prompt to /chat and prints the reply', async () => {
    let request: { path: string; method?: string; body?: unknown } | undefined;
    stubEngine({
      health: healthy,
      route: (url, init) => {
        request = { path: url.pathname, method: init?.method, body: JSON.parse(String(init?.body)) };
        return Response.json({ text: 'hi back' });
      },
    });
    expect(await runCli(makeRunCommand(), ['hello', 'there'])).toBeUndefined();
    expect(request).toEqual({ path: '/chat', method: 'POST', body: { message: 'hello there' } });
    expect(stdoutText).toBe('hi back\n');
  });

  it('search sends q and k as query params and prints each hit', async () => {
    let searchParams: URLSearchParams | undefined;
    stubEngine({
      health: healthy,
      route: (url) => {
        searchParams = url.searchParams;
        return Response.json({ results: [{ fileName: 'a.md', chunk: 'first chunk', score: 0.91234 }] });
      },
    });
    expect(await runCli(makeSearchCommand(), ['two', 'words', '-k', '3'])).toBeUndefined();
    expect(searchParams?.get('q')).toBe('two words');
    expect(searchParams?.get('k')).toBe('3');
    expect(stdoutText).toContain('0.912');
    expect(stdoutText).toContain('a.md');
    expect(stdoutText).toContain('1. first chunk');
  });

  it('search prints "No results." when the engine returns none', async () => {
    stubEngine({ health: healthy, route: json({ results: [] }) });
    expect(await runCli(makeSearchCommand(), ['nothing'])).toBeUndefined();
    expect(stdoutText).toBe('No results.\n');
  });

  it('read prints the file content with a trailing newline', async () => {
    let body: unknown;
    stubEngine({
      health: healthy,
      route: (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ content: 'line one' });
      },
    });
    expect(await runCli(makeReadCommand(), ['MEMORY/note.md'])).toBeUndefined();
    expect(body).toEqual({ fileName: 'MEMORY/note.md' });
    expect(stdoutText).toBe('line one\n');
  });

  it('write posts fileName and content and confirms', async () => {
    let body: unknown;
    stubEngine({
      health: healthy,
      route: (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      },
    });
    expect(await runCli(makeWriteCommand(), ['MEMORY/note.md', '--content', 'body'])).toBeUndefined();
    expect(body).toEqual({ fileName: 'MEMORY/note.md', content: 'body' });
    expect(stdoutText).toBe('agent: wrote MEMORY/note.md\n');
  });
});

describe('agent run sessions', () => {
  const SESSION = '00000000-0000-4000-9000-000000000002';
  const OTHER = '00000000-0000-4000-a000-000000000003';
  let home: string;
  let originalHome: string | undefined;
  let requests: unknown[];
  const lastSessionFile = () => join(home, '.argus', 'last-session');

  const stubChat = () => {
    requests = [];
    stubEngine({
      health: healthy,
      route: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { message: string; sessionId?: string };
        requests.push(body);
        return Response.json(body.sessionId ? { text: 'turn reply', sessionId: body.sessionId } : { text: 'one-shot reply' });
      },
    });
  };

  beforeEach(() => {
    originalHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'agent-cli-home-'));
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('--session threads the id through /chat, prints the reply and remembers the id', async () => {
    stubChat();
    expect(await runCli(makeRunCommand(), ['--session', SESSION, 'remember', 'this'])).toBeUndefined();
    expect(requests).toEqual([{ message: 'remember this', sessionId: SESSION }]);
    expect(stdoutText).toBe('turn reply\n');
    expect(readFileSync(lastSessionFile(), 'utf8').trim()).toBe(SESSION);
  });

  it('--continue reuses the last stored id', async () => {
    mkdirSync(join(home, '.argus'), { recursive: true });
    writeFileSync(lastSessionFile(), `${SESSION}\n`);
    stubChat();
    expect(await runCli(makeRunCommand(), ['--continue', 'what', 'did', 'I', 'say?'])).toBeUndefined();
    expect(requests).toEqual([{ message: 'what did I say?', sessionId: SESSION }]);
    expect(stdoutText).toBe('turn reply\n');
  });

  it('two turns: --session then --continue land on the same session', async () => {
    stubChat();
    await runCli(makeRunCommand(), ['--session', SESSION, 'turn', 'one']);
    await runCli(makeRunCommand(), ['--continue', 'turn', 'two']);
    expect(requests).toEqual([
      { message: 'turn one', sessionId: SESSION },
      { message: 'turn two', sessionId: SESSION },
    ]);
  });

  it('a later --session replaces the stored id', async () => {
    stubChat();
    await runCli(makeRunCommand(), ['--session', SESSION, 'a']);
    await runCli(makeRunCommand(), ['--session', OTHER, 'b']);
    expect(readFileSync(lastSessionFile(), 'utf8').trim()).toBe(OTHER);
  });

  it('--continue with no stored session starts a new one, says so on stderr, and stores it', async () => {
    stubChat();
    expect(await runCli(makeRunCommand(), ['--continue', 'hello'])).toBeUndefined();
    const sent = requests[0] as { message: string; sessionId: string };
    expect(sent.message).toBe('hello');
    expect(sent.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(stderrLines).toEqual([`agent: no previous session, started ${sent.sessionId}`]);
    expect(readFileSync(lastSessionFile(), 'utf8').trim()).toBe(sent.sessionId);
  });

  it('rejects a non-UUID --session before contacting the engine', async () => {
    stubChat();
    expect(await runCli(makeRunCommand(), ['--session', 'not-a-uuid', 'hi'])).toBe(1);
    expect(stderrLines).toEqual(['agent: --session must be a UUID (got "not-a-uuid")']);
    expect(requests).toEqual([]);
    expect(existsSync(lastSessionFile())).toBe(false);
  });

  it('rejects --session together with --continue', async () => {
    stubChat();
    expect(await runCli(makeRunCommand(), ['--session', SESSION, '--continue', 'hi'])).toBe(1);
    expect(stderrLines).toEqual(['agent: use either --session or --continue, not both']);
    expect(requests).toEqual([]);
  });

  it('rejects a corrupt stored session id instead of sending it', async () => {
    mkdirSync(join(home, '.argus'), { recursive: true });
    writeFileSync(lastSessionFile(), 'garbage\n');
    stubChat();
    expect(await runCli(makeRunCommand(), ['--continue', 'hi'])).toBe(1);
    expect(stderrLines).toEqual([`agent: ${lastSessionFile()} does not hold a session UUID; start one with --session <uuid>`]);
    expect(requests).toEqual([]);
  });

  it('does not store the id when the turn fails', async () => {
    stubEngine({ health: healthy, route: json({ error: 'kaboom' }, 500) });
    expect(await runCli(makeRunCommand(), ['--session', SESSION, 'hi'])).toBe(1);
    expect(existsSync(lastSessionFile())).toBe(false);
  });

  it('plain run stays one-shot: no sessionId sent and nothing stored', async () => {
    stubChat();
    expect(await runCli(makeRunCommand(), ['just', 'once'])).toBeUndefined();
    expect(requests).toEqual([{ message: 'just once' }]);
    expect(stdoutText).toBe('one-shot reply\n');
    expect(existsSync(lastSessionFile())).toBe(false);
  });
});
