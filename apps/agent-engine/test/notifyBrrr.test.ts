import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyBrrr } from '../src/utils/notifyBrrr.js';

describe('notifyBrrr', () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    process.env.BRRR_WEBHOOK_SECRET = 'br_usr_test';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.BRRR_WEBHOOK_SECRET;
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    errorSpy.mockClear();
  });

  it('does nothing without a secret', async () => {
    delete process.env.BRRR_WEBHOOK_SECRET;
    await notifyBrrr('hello');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tags a completion as done with the done sound', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await notifyBrrr('Task completed: t1', 'passive');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      message: 'Task completed: t1',
      interruption_level: 'passive',
      thread_id: 'agent-engine',
      filter_criteria: 'done',
      sound: 'bubbly_success_ding',
    });
  });

  it('tags a non-passive push as failure with the error sound', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await notifyBrrr('Task failed: t1', 'active');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ filter_criteria: 'failure', sound: 'warm_soft_error' });
  });

  it('logs instead of throwing when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(notifyBrrr('hello')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notifyBrrr: send failed:', expect.any(Error));
  });

  it('logs a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await notifyBrrr('hello');
    expect(errorSpy).toHaveBeenCalledWith('notifyBrrr: brrr responded 401');
  });
});
