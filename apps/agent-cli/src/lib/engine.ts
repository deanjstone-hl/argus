import { homedir } from 'os';
import { join } from 'path';

const PORT = process.env['ARGUS_PORT'] ?? '3747';
export const ENGINE_URL = `http://localhost:${PORT}`;
export const ENGINE_PID = join(homedir(), '.argus', 'engine.pid');
export const ENGINE_LOG = join(homedir(), '.argus', 'engine.log');

export class EngineNotRunningError extends Error {
  constructor() {
    super('engine not running. Start it with: agent server start');
    this.name = 'EngineNotRunningError';
  }
}

export interface EngineRequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface SearchResult {
  fileName: string;
  chunk: string;
  score: number;
}

export async function isEngineRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One call to the agent-engine. Rejects with EngineNotRunningError when /health
 * does not answer, `engine returned <status>` on a non-ok response, and the
 * body's `error` string when an ok response carries one; otherwise resolves to
 * the parsed JSON body.
 */
export async function engineRequest<T = Record<string, unknown>>(
  path: string,
  { method = 'GET', query, body, timeoutMs = 30_000 }: EngineRequestOptions = {}
): Promise<T> {
  if (!(await isEngineRunning())) throw new EngineNotRunningError();

  const search = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${ENGINE_URL}${path}${search}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`engine returned ${res.status}`);
  const data = (await res.json()) as T & { error?: unknown };
  if (data.error) throw new Error(String(data.error));
  return data;
}

export interface ChatReply {
  text?: string;
  sessionId?: string;
}

/**
 * One `/chat` turn. Without `sessionId` the body is just `{ message }`, the
 * one-shot path; with it, the engine resumes (or starts) that CLI session.
 */
export function engineChat(message: string, sessionId?: string): Promise<ChatReply> {
  return engineRequest<ChatReply>('/chat', {
    method: 'POST',
    body: sessionId === undefined ? { message } : { message, sessionId },
    timeoutMs: 120_000,
  });
}
