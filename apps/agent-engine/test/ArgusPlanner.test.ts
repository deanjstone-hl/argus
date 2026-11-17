import { describe, it, expect, vi } from 'vitest';
import { planner } from '../src/core/ArgusPlanner.js';
import type { DAGPlan, DAGTask } from '../src/types.js';

function makeTask(id: string, deps: string[] = []): DAGTask {
  return { id, toolName: 'test', arguments: {}, dependencies: deps, status: 'pending' };
}

describe('ArgusPlanner', () => {
  describe('executePlan', () => {
    it('executes a single task with no deps', async () => {
      const plan: DAGPlan = { thought: 'test', tasks: [makeTask('t1')] };
      const executor = vi.fn().mockResolvedValue('result-t1');
      const results = await planner.executePlan(plan, executor);
      expect(results.get('t1')).toBe('result-t1');
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('executes linear chain in dependency order', async () => {
      const order: string[] = [];
      const plan: DAGPlan = {
        thought: 'chain',
        tasks: [makeTask('t1'), makeTask('t2', ['t1']), makeTask('t3', ['t2'])],
      };
      const executor = vi.fn().mockImplementation(async (task: DAGTask) => {
        order.push(task.id);
        return 'out-' + task.id;
      });
      const results = await planner.executePlan(plan, executor);
      expect(order[0]).toBe('t1');
      expect(order[1]).toBe('t2');
      expect(order[2]).toBe('t3');
      expect(results.get('t3')).toBe('out-t3');
    });

    it('executes parallel fanout — independent tasks run concurrently', async () => {
      const plan: DAGPlan = {
        thought: 'parallel',
        tasks: [makeTask('root'), makeTask('a', ['root']), makeTask('b', ['root'])],
      };
      const executor = vi.fn().mockImplementation(async (task: DAGTask) => 'out-' + task.id);
      const results = await planner.executePlan(plan, executor);
      expect(results.get('a')).toBe('out-a');
      expect(results.get('b')).toBe('out-b');
    });

    it('throws on circular dependency', async () => {
      const plan: DAGPlan = {
        thought: 'cycle',
        tasks: [makeTask('t1', ['t2']), makeTask('t2', ['t1'])],
      };
      const executor = vi.fn().mockResolvedValue('x');
      await expect(planner.executePlan(plan, executor)).rejects.toThrow(/[Cc]ycle/);
    });
  });

  describe('resolveArguments', () => {
    it('replaces $task_<id> with completed output', () => {
      const completed = new Map([['abc', 'resolved-value']]);
      const args = { input: '$task_abc' };
      const result = planner.resolveArguments(args, completed);
      expect(result['input']).toBe('resolved-value');
    });

    it('leaves non-matching strings unchanged', () => {
      const completed = new Map<string, string>();
      const args = { input: 'plain string' };
      const result = planner.resolveArguments(args, completed);
      expect(result['input']).toBe('plain string');
    });

    it('handles nested objects', () => {
      const completed = new Map([['x', 'val']]);
      const args = { nested: { key: '$task_x' } };
      const result = planner.resolveArguments(args, completed);
      expect((result['nested'] as Record<string, unknown>)['key']).toBe('val');
    });
  });
});
