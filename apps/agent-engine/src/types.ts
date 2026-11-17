import { z } from 'zod';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
}

export type DAGTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DAGTask {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  dependencies: string[];
  status: DAGTaskStatus;
  output?: string;
}

export interface DAGPlan {
  thought: string;
  tasks: DAGTask[];
}

// One entry per task in a run-plan response, so a caller can attribute each
// output or error to its node. `skipped` means a dependency did not complete.
export interface TaskResult {
  status: 'completed' | 'failed' | 'skipped';
  output?: string;
  error?: string;
}

export interface PlanRunResult {
  text: string;
  tasks: Record<string, TaskResult>;
}

export type TaskType ='engineering' | 'bulk_ingestion' | 'local_utility' | 'feedback_loop' | 'best_of_n' | 'live_note_refresh';
export type AllocatedModel = 'CLAUDE' | 'GEMINI';

export interface FeedbackValidator {
  toolName: string;
  successThreshold?: number;
}

export interface FeedbackLoopTask extends DAGTask {
  taskType: TaskType;
  validator: FeedbackValidator;
  maxRounds: number;
  initialPrompt: string;
}

export interface FeedbackLoopResult {
  output: string;
  rounds: number;
  finalScore?: number;
  succeeded: boolean;
}

export interface ArgusTool<T extends z.ZodObject> {
  name: string;
  description: string;
  schema: T;
  execute: (args: z.infer<T>) => Promise<string>;
}

export interface SearchResult {
  fileName: string;
  chunk: string;
  score: number;
}
