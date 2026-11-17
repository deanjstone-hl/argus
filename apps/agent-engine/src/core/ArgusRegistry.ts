import { ArgusTool, TaskType } from '../types.js';
import { z } from 'zod';

class ArgusRegistry {
  private tools: Map<string, ArgusTool<z.ZodObject>>;

  constructor() {
    this.tools = new Map();

    const ContextPayloadSchema = z.object({
      fileName: z.string(),
      content: z.string(),
    });

    this.register({
      name: 'context_payload',
      description: 'Built-in',
      schema: ContextPayloadSchema,
      execute: async () => 'ok',
    });

    const TaskSchema = z.object({
      taskType: z.enum(['engineering', 'bulk_ingestion', 'local_utility', 'feedback_loop']),
      prompt: z.string(),
      dependencies: z.array(z.string()).optional(),
    });

    this.register({
      name: 'task',
      description: 'Generic task executor',
      schema: TaskSchema,
      execute: async () => 'ok',
    });

    const ValidateJsonSchema = z.object({
      input: z.string(),
    });

    this.register({
      name: 'validate_json_schema',
      description: 'Validates JSON output. Returns { ok, score, feedback }.',
      schema: ValidateJsonSchema,
      execute: async ({ input }) => {
        try {
          JSON.parse(input);
          return JSON.stringify({ ok: true, score: 1.0, feedback: 'Valid JSON' });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Parse error';
          return JSON.stringify({ ok: false, score: 0.0, feedback: `Invalid JSON: ${message}` });
        }
      },
    });
  }

  register<T extends z.ZodObject>(tool: ArgusTool<T>): void {
    this.tools.set(tool.name, tool as unknown as ArgusTool<z.ZodObject>);
  }

  validate(toolName: string, rawArgs: unknown): string | null {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `Tool not found: ${toolName}`;
    }

    const result = tool.schema.safeParse(rawArgs);
    if (!result.success) {
      const errors = result.error.issues
        .map((issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return errors;
    }

    return null;
  }

  getDefinitions(): Array<{ name: string; description: string; schema: unknown }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: z.toJSONSchema(tool.schema),
    }));
  }

  getTool(toolName: string): ArgusTool<z.ZodObject> | undefined {
    return this.tools.get(toolName);
  }
}

export const registry = new ArgusRegistry();
