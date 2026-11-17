import { DAGTask, DAGPlan, TaskResult } from '../types.js';
import { notifyBrrr } from '../utils/notifyBrrr.js';

// Resolves `$task_<id>` references against the outputs completed so far.
export type ReferenceResolver = (args: Record<string, unknown>) => Record<string, unknown>;
export type TaskExecutor = (task: DAGTask, resolve: ReferenceResolver) => Promise<string>;

// A task failure that still has output worth returning, such as a feedback
// loop that ran out of rounds.
export class TaskFailure extends Error {
  constructor(message: string, readonly output?: string) {
    super(message);
    this.name = 'TaskFailure';
  }
}

class ArgusPlanner {
  private assertAcyclic(plan: DAGPlan, taskById: Map<string, DAGTask>): void {
    const detectCycles = (taskId: string, path: Set<string>): void => {
      if (path.has(taskId)) {
        throw new Error(`Cycle detected in DAG: ${taskId}`);
      }
      const task = taskById.get(taskId);
      if (!task) return;
      path.add(taskId);
      for (const dep of task.dependencies) {
        detectCycles(dep, new Set(path));
      }
    };

    for (const task of plan.tasks) {
      detectCycles(task.id, new Set());
    }
  }

  async executePlan(
    plan: DAGPlan,
    executor: TaskExecutor
  ): Promise<Map<string, string>> {
    const completed = new Map<string, string>();
    const taskById = new Map<string, DAGTask>(plan.tasks.map(t => [t.id, t]));
    const inProgress = new Map<string, Promise<string>>();

    this.assertAcyclic(plan, taskById);

    const executeTask = (task: DAGTask): Promise<string> => {
      if (completed.has(task.id)) {
        return Promise.resolve(completed.get(task.id)!);
      }

      if (inProgress.has(task.id)) {
        return inProgress.get(task.id)!;
      }

      const promise = (async () => {
        await Promise.all(
          task.dependencies.map(depId => {
            const depTask = taskById.get(depId);
            if (!depTask) throw new Error(`Dependency task not found: ${depId}`);
            return executeTask(depTask);
          })
        );

        task.status = 'running';
        try {
          const resolvedArgs = this.resolveArguments(task.arguments, completed);
          const output = await executor(
            { ...task, arguments: resolvedArgs },
            (args) => this.resolveArguments(args, completed)
          );
          completed.set(task.id, output);
          task.status = 'completed';
          notifyBrrr(`Task completed: ${task.id}`, 'passive');
          return output;
        } catch (err) {
          task.status = 'failed';
          notifyBrrr(`Task failed: ${task.id} — ${(err as Error).message}`, 'active');
          throw err;
        }
      })();

      inProgress.set(task.id, promise);
      return promise;
    };

    await Promise.all(plan.tasks.map(task => executeTask(task)));
    return completed;
  }

  // Runs every task it can and reports each one, instead of rejecting on the
  // first failure. Only plan-level faults (a cycle, a dependency id that names
  // no task) reject, before anything runs. A task whose dependency did not
  // complete is skipped, not run with an unresolved reference.
  async executePlanSettled(
    plan: DAGPlan,
    executor: TaskExecutor
  ): Promise<{ outputs: Map<string, string>; results: Record<string, TaskResult> }> {
    const outputs = new Map<string, string>();
    const results: Record<string, TaskResult> = {};
    const taskById = new Map<string, DAGTask>(plan.tasks.map(t => [t.id, t]));
    const settled = new Map<string, Promise<boolean>>();

    for (const task of plan.tasks) {
      for (const depId of task.dependencies) {
        if (!taskById.has(depId)) throw new Error(`Dependency task not found: ${depId}`);
      }
    }
    this.assertAcyclic(plan, taskById);

    const settle = (task: DAGTask): Promise<boolean> => {
      const existing = settled.get(task.id);
      if (existing) return existing;

      const promise = (async () => {
        const depsOk = await Promise.all(task.dependencies.map(depId => settle(taskById.get(depId)!)));
        const failedDep = task.dependencies.find((_, i) => !depsOk[i]);
        if (failedDep !== undefined) {
          task.status = 'failed';
          results[task.id] = { status: 'skipped', error: `Dependency did not complete: ${failedDep}` };
          return false;
        }

        task.status = 'running';
        try {
          const output = await executor(
            { ...task, arguments: this.resolveArguments(task.arguments, outputs) },
            (args) => this.resolveArguments(args, outputs)
          );
          outputs.set(task.id, output);
          task.status = 'completed';
          results[task.id] = { status: 'completed', output };
          notifyBrrr(`Task completed: ${task.id}`, 'passive');
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          task.status = 'failed';
          results[task.id] = err instanceof TaskFailure && err.output !== undefined
            ? { status: 'failed', output: err.output, error: message }
            : { status: 'failed', error: message };
          notifyBrrr(`Task failed: ${task.id} — ${message}`, 'active');
          return false;
        }
      })();

      settled.set(task.id, promise);
      return promise;
    };

    await Promise.all(plan.tasks.map(task => settle(task)));
    // Plan order, not completion order, so the map reads like the plan.
    const ordered = Object.fromEntries(plan.tasks.map(t => [t.id, results[t.id]!]));
    return { outputs, results: ordered };
  }

  resolveArguments(
    args: Record<string, unknown>,
    completed: Map<string, string>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        const match = value.match(/^\$task_(.+)$/);
        if (match) {
          resolved[key] = completed.get(match[1]) ?? value;
        } else {
          resolved[key] = value;
        }
      } else if (value !== null && typeof value === 'object') {
        resolved[key] = this.resolveArguments(value as Record<string, unknown>, completed);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}

export const planner = new ArgusPlanner();
