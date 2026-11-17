import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claudeAsk, geminiAsk, haikuAsk } = vi.hoisted(() => ({
  claudeAsk: vi.fn(),
  geminiAsk: vi.fn(),
  haikuAsk: vi.fn(),
}));

vi.mock('../src/models/ClaudeAdapter.js', () => ({ claudeAdapter: { ask: claudeAsk } }));
vi.mock('../src/models/GeminiAdapter.js', () => ({ geminiAdapter: { ask: geminiAsk } }));
vi.mock('../src/models/HaikuAdapter.js', () => ({ haikuAdapter: { ask: haikuAsk, classify: haikuAsk } }));

import { engine } from '../src/core/ArgusEngine.js';

beforeEach(() => {
  vi.clearAllMocks();
  claudeAsk.mockResolvedValue('refreshed body');
});

describe('live_note_refresh routing', () => {
  it('routes to Claude', () => {
    expect(engine.routeTask('live_note_refresh')).toBe('CLAUDE');
  });

  it('runs one prompt on the routed model with no planner and no tools', async () => {
    const output = await engine.runDirect('live_note_refresh', 'the prompt');
    expect(output).toBe('refreshed body');
    expect(claudeAsk).toHaveBeenCalledWith('the prompt', { textOnly: true });
    expect(haikuAsk).not.toHaveBeenCalled();
    expect(geminiAsk).not.toHaveBeenCalled();
  });
});
