import type {
  DAGPlan,
  DAGTask,
  TaskType,
  AllocatedModel,
  Message,
  FeedbackLoopTask,
  FeedbackLoopResult,
  PlanRunResult,
} from '../types.js';
import { claudeAdapter } from '../models/ClaudeAdapter.js';
import { geminiAdapter } from '../models/GeminiAdapter.js';
import { haikuAdapter } from '../models/HaikuAdapter.js';
import { registry } from './ArgusRegistry.js';
import { planner, TaskFailure, type ReferenceResolver, type TaskExecutor } from './ArgusPlanner.js';

const BEST_OF_N_SAMPLES = 3;

class ArgusEngine {
  routeTask(taskType: TaskType): AllocatedModel {
    switch (taskType) {
      case 'engineering':
        return 'CLAUDE';
      case 'bulk_ingestion':
        return 'GEMINI';
      case 'local_utility':
        return 'CLAUDE'; // Ollama has embeddings only; route chat to Claude
      case 'feedback_loop':
        return 'CLAUDE';
      case 'best_of_n':
        return 'CLAUDE';
      case 'live_note_refresh':
        return 'CLAUDE';
    }
  }

  // One prompt to the model `routeTask` picks, with no Haiku planner in front:
  // for a fixed, known operation such as a live-note refresh (#122). The prompt
  // carries text the owner did not write (the knowledge graph), so Claude runs
  // text-only, with no built-in tools and no MCP servers.
  async runDirect(taskType: TaskType, prompt: string): Promise<string> {
    const model = this.routeTask(taskType);
    if (model === 'CLAUDE') return claudeAdapter.ask(prompt, { textOnly: true });
    return this.dispatchToModel(model, prompt);
  }

  private async dispatchToModel(
    model: AllocatedModel,
    prompt: string
  ): Promise<string> {
    switch (model) {
      case 'CLAUDE':
        return claudeAdapter.ask(prompt);
      case 'GEMINI':
        return geminiAdapter.ask(prompt);
      default:
        throw new Error(`Unknown model: ${model}`);
    }
  }

  private async executeBestOfN(
    prompt: string,
    taskType: TaskType
  ): Promise<string> {
    const model = this.routeTask(taskType);
    const outputs = await Promise.all(
      Array.from({ length: BEST_OF_N_SAMPLES }, () =>
        this.dispatchToModel(model, prompt)
      )
    );

    // Longest output wins; ties keep the earliest sample.
    return outputs.reduce((best, output) => (output.length > best.length ? output : best), '');
  }

  // A plan task with toolName 'feedback_loop' carries its loop config at the
  // top level (the FeedbackLoopTask shape the myargus editor builds), not in
  // `arguments`. A `$task_<id>` initialPrompt resolves like any argument.
  private async executeFeedbackLoopTask(
    task: DAGTask,
    resolve: ReferenceResolver,
    onDelta?: (text: string) => void
  ): Promise<string> {
    const loop = task as Partial<FeedbackLoopTask> & DAGTask;
    const maxRounds = loop.maxRounds;
    if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error('feedback_loop task needs maxRounds as a positive integer');
    }
    if (typeof loop.initialPrompt !== 'string') {
      throw new Error('feedback_loop task needs initialPrompt as a string');
    }
    if (typeof loop.validator?.toolName !== 'string') {
      throw new Error('feedback_loop task needs validator.toolName as a string');
    }

    const initialPrompt = resolve({ initialPrompt: loop.initialPrompt })['initialPrompt'];
    const result = await this.runWithFeedback({
      ...task,
      taskType: loop.taskType ?? 'engineering',
      validator: loop.validator,
      maxRounds,
      initialPrompt: typeof initialPrompt === 'string' ? initialPrompt : loop.initialPrompt,
    }, onDelta);

    if (!result.succeeded) {
      throw new TaskFailure(`Feedback loop did not pass its validator in ${result.rounds} rounds`, result.output);
    }
    return result.output;
  }

  // `strict` makes a tool-argument validation failure throw, so a run-plan
  // caller sees it as a failed task. Without it the validation message is
  // returned as the task's output, which is what `run` has always done.
  private buildExecutor(
    onDelta?: (text: string) => void,
    strict = false
  ): TaskExecutor {
    return async (task: DAGTask, resolve: ReferenceResolver): Promise<string> => {
      if (task.toolName === 'feedback_loop') {
        return this.executeFeedbackLoopTask(task, resolve, onDelta);
      }

      const tool = registry.getTool(task.toolName);

      if (tool) {
        const validationError = registry.validate(task.toolName, task.arguments);
        if (validationError) {
          if (strict) throw new Error(validationError);
          return validationError;
        }
        const output = await tool.execute(task.arguments as never);
        onDelta?.(output);
        return output;
      }

      // Unknown tool — extract taskType + prompt and dispatch to model
      const rawTaskType = task.arguments['taskType'] as TaskType | undefined;
      const taskType: TaskType = rawTaskType ?? await haikuAdapter.classify(
        `${task.toolName}: ${JSON.stringify(task.arguments)}`,
        ['engineering', 'bulk_ingestion', 'local_utility', 'best_of_n']
      ).then(r => r.category as TaskType);

      const prompt = (task.arguments['prompt'] as string | undefined)
        ?? JSON.stringify(task.arguments);

      let output: string;
      if (taskType === 'best_of_n') {
        output = await this.executeBestOfN(prompt, taskType);
      } else {
        const allocatedModel = this.routeTask(taskType);
        output = await this.dispatchToModel(allocatedModel, prompt);
      }

      onDelta?.(output);
      return output;
    };
  }

  private normalizePlan(dagPlan: DAGPlan): void {
    for (const task of dagPlan.tasks) {
      task.status = 'pending';
      if (!Array.isArray(task.dependencies)) {
        task.dependencies = [];
      }
    }
  }

  async runPlan(
    dagPlan: DAGPlan,
    onDelta?: (text: string) => void
  ): Promise<PlanRunResult> {
    this.normalizePlan(dagPlan);

    if (dagPlan.tasks.length === 0) {
      return { text: '', tasks: {} };
    }

    const { outputs, results } = await planner.executePlanSettled(dagPlan, this.buildExecutor(onDelta, true));
    return { text: Array.from(outputs.values()).join('\n\n'), tasks: results };
  }

  async run(
    userPrompt: string,
    onDelta?: (text: string) => void
  ): Promise<string> {
    const toolDefinitions = registry.getDefinitions();
    const toolsJson = JSON.stringify(toolDefinitions, null, 2);

    const planningPrompt = `You are a planning agent. Given the user request, produce a JSON execution plan.

Available tools:
${toolsJson}

User request: ${userPrompt}

Respond with only valid JSON matching this shape:
{
  "thought": "your reasoning about the plan",
  "tasks": [
    {
      "id": "task_id",
      "toolName": "tool_name",
      "arguments": { ... },
      "dependencies": ["dependency_ids"]
    }
  ]
}`;

    const planResponse = await haikuAdapter.ask(planningPrompt);
    const cleanedResponse = planResponse
      .replace(/^```json\s*\n?/, '')
      .replace(/```\s*$/, '');
    const dagPlan = JSON.parse(cleanedResponse) as DAGPlan;

    this.normalizePlan(dagPlan);

    // No tool tasks — answer directly with Claude rather than returning empty
    if (dagPlan.tasks.length === 0) {
      const answer = await claudeAdapter.ask(userPrompt);
      onDelta?.(answer);
      return answer;
    }

    const outputs = await planner.executePlan(dagPlan, this.buildExecutor(onDelta));
    return Array.from(outputs.values()).join('\n\n');
  }

  async runWithFeedback(
    task: FeedbackLoopTask,
    onDelta?: (text: string) => void
  ): Promise<FeedbackLoopResult> {
    const validator = registry.getTool(task.validator.toolName);
    if (!validator) {
      throw new Error(`Validator tool not found: ${task.validator.toolName}`);
    }

    const threshold = task.validator.successThreshold ?? 1.0;
    const messages: Message[] = [
      { role: 'user', content: task.initialPrompt }
    ];

    for (let round = 0; round < task.maxRounds; round++) {
      const model = this.routeTask(task.taskType);
      const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      const output = await this.dispatchToModel(model, prompt);
      onDelta?.(output);

      const validationResult = await validator.execute({ input: output } as never);
      let parsed: { ok: boolean; score?: number; feedback: string };
      try {
        parsed = JSON.parse(validationResult);
      } catch {
        parsed = { ok: validationResult.trim() === 'ok', feedback: validationResult };
      }

      const score = parsed.score ?? (parsed.ok ? 1.0 : 0.0);
      if (score >= threshold) {
        return { output, rounds: round + 1, finalScore: score, succeeded: true };
      }

      messages.push(
        { role: 'assistant', content: output },
        { role: 'user', content: `Feedback (round ${round + 1}): ${parsed.feedback}\n\nRevise and try again.` }
      );
    }

    const lastOutput = messages.filter(m => m.role === 'assistant').pop()?.content ?? '';
    return { output: lastOutput, rounds: task.maxRounds, succeeded: false };
  }
}

export const engine = new ArgusEngine();
