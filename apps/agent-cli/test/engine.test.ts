import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_URL, EngineNotRunningError, engineChat, engineRequest } from '../src/lib/engine.js';

type FetchCall = { url: URL; init?: RequestInit };

function stubFetch(health: () => Response, route: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, init });
      return url.pathname === '/health' ? health() : route();
    })
  );
  return calls;
}

const healthy = () => new Response('ok');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engineRequest', () => {
  it('rejects with EngineNotRunningError and the start hint when /health fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const request = engineRequest('/chat', { method: 'POST', body: { message: 'x' } });
    await expect(request).rejects.toBeInstanceOf(EngineNotRunningError);
    await expect(request).rejects.toThrow('engine not running. Start it with: agent server start');
  });

  it('rejects with EngineNotRunningError when /health is not ok, without calling the route', async () => {
    const calls = stubFetch(() => new Response('down', { status: 503 }), () => Response.json({}));
    await expect(engineRequest('/vector/search')).rejects.toBeInstanceOf(EngineNotRunningError);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/health']);
  });

  it('reports the HTTP status before looking at the body', async () => {
    stubFetch(healthy, () => Response.json({ error: 'kaboom' }, { status: 500 }));
    await expect(engineRequest('/context/read')).rejects.toThrow(/^engine returned 500$/);
  });

  it('surfaces data.error from an ok response', async () => {
    stubFetch(healthy, () => Response.json({ error: 'vault offline' }));
    await expect(engineRequest('/context/write')).rejects.toThrow(/^vault offline$/);
  });

  it('returns the parsed body on success', async () => {
    stubFetch(healthy, () => Response.json({ text: 'hi' }));
    await expect(engineRequest<{ text: string }>('/chat')).resolves.toEqual({ text: 'hi' });
  });

  it('sends a JSON body as POST and query params on the URL', async () => {
    const calls = stubFetch(healthy, () => Response.json({}));
    await engineRequest('/context/write', { method: 'POST', body: { fileName: 'a.md', content: 'b' } });
    await engineRequest('/vector/search', { query: { q: 'two words', k: '3' } });

    const [, post, , get] = calls;
    expect(post?.url.href).toBe(`${ENGINE_URL}/context/write`);
    expect(post?.init?.method).toBe('POST');
    expect(new Headers(post?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ fileName: 'a.md', content: 'b' });
    expect(get?.url.pathname).toBe('/vector/search');
    expect(get?.init?.method ?? 'GET').toBe('GET');
    expect(get?.url.searchParams.get('q')).toBe('two words');
    expect(get?.url.searchParams.get('k')).toBe('3');
  });
});

describe('engineChat', () => {
  it('posts only the message for a one-shot turn', async () => {
    const calls = stubFetch(healthy, () => Response.json({ text: 'hi' }));
    await expect(engineChat('hello')).resolves.toEqual({ text: 'hi' });
    expect(calls[1]?.url.pathname).toBe('/chat');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ message: 'hello' });
  });

  it('adds sessionId when given and returns the echoed id', async () => {
    const id = '00000000-0000-4000-9000-000000000002';
    const calls = stubFetch(healthy, () => Response.json({ text: 'again', sessionId: id }));
    await expect(engineChat('hello', id)).resolves.toEqual({ text: 'again', sessionId: id });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ message: 'hello', sessionId: id });
  });
});
