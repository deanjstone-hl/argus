import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { engine } from '../src/core/ArgusEngine.js';
import { registry } from '../src/core/ArgusRegistry.js';
import type { DAGPlan, DAGTask } from '../src/types.js';

const { ask } = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock('../src/models/ClaudeAdapter.js', () => ({ claudeAdapter: { ask } }));
vi.mock('../src/utils/notifyBrrr.js', () => ({ notifyBrrr: vi.fn() }));
vi.mock('../src/models/HaikuAdapter.js', () => ({
  haikuAdapter: { classify: vi.fn(async () => { throw new Error('classify must not be called'); }) },
}));

function task(id: string, args: Record<string, unknown>, dependencies: string[] = [], toolName = 'model'): DAGTask {
  return { id, toolName, arguments: { taskType: 'engineering', ...args }, dependencies, status: 'pending' };
}

function plan(...tasks: DAGTask[]): DAGPlan {
  return { thought: 'test', tasks };
}

beforeEach(() => {
  ask.mockReset();
  ask.mockImplementation(async (prompt: string) => {
    if (prompt.includes('BOOM')) throw new Error('model adapter failed');
    return `answer:${prompt}`;
  });
});

describe('engine.runPlan per-task results', () => {
  it('reports every task as completed with its output', async () => {
    const result = await engine.runPlan(plan(task('a', { prompt: 'one' }), task('b', { prompt: 'two' })));
    expect(result.tasks).toEqual({
      a: { status: 'completed', output: 'answer:one' },
      b: { status: 'completed', output: 'answer:two' },
    });
    expect(result.text.split('\n\n').sort()).toEqual(['answer:one', 'answer:two']);
  });

  it('a thrown task error is attributed to that task and does not hide its siblings', async () => {
    const result = await engine.runPlan(plan(
      task('ok', { prompt: 'fine' }),
      task('bad', { prompt: 'BOOM' }),
    ));
    expect(result.tasks['ok']).toEqual({ status: 'completed', output: 'answer:fine' });
    expect(result.tasks['bad']).toEqual({ status: 'failed', error: 'model adapter failed' });
    expect(result.text).toBe('answer:fine');
  });

  it('marks dependents of a failed task as skipped, naming the failed dependency', async () => {
    const result = await engine.runPlan(plan(
      task('bad', { prompt: 'BOOM' }),
      task('child', { prompt: '$task_bad' }, ['bad']),
      task('grandchild', { prompt: 'x' }, ['child']),
      task('other', { prompt: 'independent' }),
    ));
    expect(result.tasks['bad']?.status).toBe('failed');
    expect(result.tasks['child']).toEqual({ status: 'skipped', error: 'Dependency did not complete: bad' });
    expect(result.tasks['grandchild']).toEqual({ status: 'skipped', error: 'Dependency did not complete: child' });
    expect(result.tasks['other']).toEqual({ status: 'completed', output: 'answer:independent' });
    expect(ask).not.toHaveBeenCalledWith('$task_bad');
  });

  it('still feeds a completed dependency output into $task_ references', async () => {
    const result = await engine.runPlan(plan(
      task('a', { prompt: 'seed' }),
      task('b', { prompt: '$task_a' }, ['a']),
    ));
    expect(result.tasks['b']).toEqual({ status: 'completed', output: 'answer:answer:seed' });
  });

  it('reports a tool argument validation failure as failed, not as output', async () => {
    registry.register({
      name: 'needs_count',
      description: 'test tool requiring a numeric count',
      schema: z.object({ count: z.number() }),
      execute: async () => 'should not run',
    });
    const result = await engine.runPlan(plan({
      id: 'v', toolName: 'needs_count', arguments: { count: 'nope' }, dependencies: [], status: 'pending',
    }));
    expect(result.tasks['v']?.status).toBe('failed');
    expect(result.tasks['v']?.error).toBeTruthy();
    expect(result.tasks['v']?.output).toBeUndefined();
    expect(result.text).toBe('');
  });

  it('still rejects the whole plan on a cycle, naming the task', async () => {
    await expect(engine.runPlan(plan(task('a', {}, ['b']), task('b', {}, ['a'])))).rejects.toThrow(/Cycle detected in DAG/);
  });

  it('still rejects the whole plan on a missing dependency, naming it', async () => {
    await expect(engine.runPlan(plan(task('a', {}, ['ghost'])))).rejects.toThrow('Dependency task not found: ghost');
  });

  it('returns an empty result for an empty plan', async () => {
    expect(await engine.runPlan(plan())).toEqual({ text: '', tasks: {} });
  });
});

describe('feedback_loop tasks inside a plan', () => {
  beforeEach(() => {
    registry.register({
      name: 'contains_done',
      description: 'passes when the output mentions DONE',
      schema: z.object({ input: z.string() }),
      execute: async ({ input }) => JSON.stringify({ ok: input.includes('DONE'), feedback: 'say DONE' }),
    });
  });

  // The myargus editor's shape: no taskType, no status, empty arguments.
  function feedbackTask(id: string, initialPrompt: string, maxRounds: number, validator = 'contains_done', dependencies: string[] = []) {
    return {
      id,
      toolName: 'feedback_loop',
      arguments: {},
      dependencies,
      validator: { toolName: validator },
      maxRounds,
      initialPrompt,
    } as unknown as DAGTask;
  }

  it('runs the loop with initialPrompt and the validator, not "{}" as a prompt', async () => {
    ask.mockReset();
    ask.mockResolvedValueOnce('draft').mockResolvedValueOnce('final DONE');
    const result = await engine.runPlan(plan(feedbackTask('fb', 'write it', 3)));
    expect(result.tasks['fb']).toEqual({ status: 'completed', output: 'final DONE' });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]?.[0]).toContain('write it');
    expect(ask.mock.calls[1]?.[0]).toContain('say DONE');
    expect(ask).not.toHaveBeenCalledWith('{}');
  });

  it('fails the task, keeping the last output, when maxRounds runs out', async () => {
    ask.mockReset();
    ask.mockResolvedValue('never');
    const result = await engine.runPlan(plan(feedbackTask('fb', 'write it', 2)));
    expect(result.tasks['fb']).toEqual({
      status: 'failed',
      output: 'never',
      error: 'Feedback loop did not pass its validator in 2 rounds',
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('fails the task when the validator tool does not exist', async () => {
    const result = await engine.runPlan(plan(feedbackTask('fb', 'write it', 2, 'no_such_validator')));
    expect(result.tasks['fb']).toEqual({ status: 'failed', error: 'Validator tool not found: no_such_validator' });
  });

  it('fails the task when maxRounds is not a positive integer', async () => {
    const result = await engine.runPlan(plan(feedbackTask('fb', 'write it', 0)));
    expect(result.tasks['fb']?.status).toBe('failed');
    expect(result.tasks['fb']?.error).toMatch(/maxRounds/);
  });

  it('resolves a $task_ reference in initialPrompt from a completed dependency', async () => {
    ask.mockReset();
    ask.mockResolvedValueOnce('seed text').mockResolvedValueOnce('DONE');
    const result = await engine.runPlan(plan(
      task('a', { prompt: 'seed' }),
      feedbackTask('fb', '$task_a', 2, 'contains_done', ['a']),
    ));
    expect(result.tasks['fb']).toEqual({ status: 'completed', output: 'DONE' });
    expect(ask.mock.calls[1]?.[0]).toContain('seed text');
  });
});
