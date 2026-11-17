---
status: approved
created: 2026-06-30
source: arxiv:2511.00592 (ComPilot — LLM-Guided Loop Optimization)
---

# Implementation Plan: Closed-Loop Feedback Task Type

Adds a `feedback_loop` task mode to agent-engine where the model iteratively refines its output based on graded feedback from an external validator, rather than making a single attempt.

## Motivation

ComPilot (arxiv 2511.00592) demonstrates that a general-purpose LLM with concrete external feedback outperforms task-specific models on optimisation problems. The key: each retry injects the validator's result directly into the next prompt turn. This pattern applies to any agent-engine task where a deterministic success signal exists (test pass, schema validation, HTTP status, lint score).

Single-run result: 2.66x speedup. Best-of-5 result: 3.54x. The feedback loop is the mechanism; best-of-N is a cheaper complement when tasks are short.

---

## Current Architecture

`ArgusEngine.run()` in `src/core/ArgusEngine.ts`:
1. Haiku produces a `DAGPlan` (JSON task graph)
2. `ArgusPlanner.executePlan()` runs tasks in dependency order
3. Each task either calls a registered tool or dispatches to a model
4. All outputs joined and returned

`TaskType` in `src/types.ts`: `'engineering' | 'bulk_ingestion' | 'local_utility'`

---

## Changes Required

### 1. `src/types.ts` — new types

```typescript
// Add to TaskType union
export type TaskType = 'engineering' | 'bulk_ingestion' | 'local_utility' | 'feedback_loop';

// New validator shape
export interface FeedbackValidator {
  toolName: string;           // registered ArgusTool that scores the output
  successThreshold?: number;  // 0–1 score required; default 1.0 (binary pass)
}

// Extend DAGTask for feedback_loop tasks
export interface FeedbackLoopTask extends DAGTask {
  validator: FeedbackValidator;
  maxRounds: number;          // default 5
  initialPrompt: string;      // original task prompt (separate from retry prompt)
}

// Result shape
export interface FeedbackLoopResult {
  output: string;
  rounds: number;
  finalScore?: number;
  succeeded: boolean;
}
```

### 2. `src/core/ArgusEngine.ts` — new `runWithFeedback()` method

Add alongside the existing `run()` method:

```typescript
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
    const model = this.routeTask(task.taskType as TaskType);
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const output = await this.dispatchToModel(model, prompt);
    onDelta?.(output);

    // External validation
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

    // Inject feedback for next round — at top of next turn, not appended
    messages.push(
      { role: 'assistant', content: output },
      { role: 'user', content: `Feedback (round ${round + 1}): ${parsed.feedback}\n\nRevise and try again.` }
    );
  }

  // Return best attempt on budget exhaustion
  const lastOutput = messages.filter(m => m.role === 'assistant').pop()?.content ?? '';
  return { output: lastOutput, rounds: task.maxRounds, succeeded: false };
}
```

### 3. `src/server/protocol.ts` — expose via HTTP

Add a new route `POST /task/feedback` alongside the existing task endpoint:

```typescript
// Request body
interface FeedbackTaskRequest {
  prompt: string;
  validatorTool: string;
  maxRounds?: number;           // default 5
  successThreshold?: number;    // default 1.0
  taskType?: TaskType;          // default 'engineering'
}
```

### 4. Validator tool registration pattern

Validators must be registered as `ArgusTools` returning JSON `{ ok, score?, feedback }`. Example for a schema validator:

```typescript
registry.register({
  name: 'validate_json_schema',
  description: 'Validates JSON output against a schema. Returns { ok, score, feedback }.',
  schema: z.object({ input: z.string(), schema: z.string() }),
  execute: async ({ input, schema }) => {
    // ... ajv validate logic
    return JSON.stringify({ ok: valid, score: valid ? 1.0 : 0.0, feedback: errors });
  }
});
```

---

## Implementation Order

1. **Types** — add `FeedbackLoopTask`, `FeedbackValidator`, `FeedbackLoopResult` to `types.ts`
2. **Engine method** — add `runWithFeedback()` to `ArgusEngine`
3. **HTTP route** — add `POST /task/feedback` in `protocol.ts`
4. **First validator** — register `validate_json_schema` as proof-of-concept
5. **Test** — add to `tests/` with a mock validator that fails twice then passes

---

## Key Constraints

- Feedback injected at the **start** of the next user turn, not appended to the prior assistant turn — models attend more reliably to recent context start than to buried content
- Hard cap `maxRounds` enforced regardless of success condition — no runaway loops
- Return best attempt on exhaustion (not an error) — partial output is better than silent failure
- Validator tool must return parseable JSON or a bare `"ok"` string — two-format handling in the engine

---

## Out of Scope (this iteration)

- Best-of-N parallel sampling (separate task type; use `agent_swarm` for now)
- Adaptive round budgeting based on score trajectory
- Validator chains (multiple validators in sequence)
