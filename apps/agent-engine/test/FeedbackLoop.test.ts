import { describe, it, expect, vi, beforeEach } from 'vitest';
import { engine } from '../src/core/ArgusEngine.js';
import { registry } from '../src/core/ArgusRegistry.js';
import type { FeedbackLoopTask } from '../src/types.js';
import { z } from 'zod';
import * as claudeModule from '../src/models/ClaudeAdapter.js';

vi.mock('../src/models/ClaudeAdapter.js', () => ({
  claudeAdapter: {
    ask: vi.fn().mockResolvedValue('This is a model response that is long enough to pass validation checks and meet all requirements.'),
  },
}));

describe('FeedbackLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let callCount = 0;
    const ValidatorSchema = z.object({
      input: z.string(),
    });

    registry.register({
      name: 'test_validator_sequential',
      description: 'Test validator that fails twice then passes',
      schema: ValidatorSchema,
      execute: async ({ input }) => {
        callCount++;
        if (callCount < 3) {
          return JSON.stringify({
            ok: false,
            score: 0.0,
            feedback: `Attempt ${callCount}: Try again`,
          });
        }
        return JSON.stringify({
          ok: true,
          score: 1.0,
          feedback: 'Success!',
        });
      },
    });

    const PartialValidatorSchema = z.object({
      input: z.string(),
    });

    registry.register({
      name: 'test_validator_partial',
      description: 'Test validator that scores based on input length',
      schema: PartialValidatorSchema,
      execute: async ({ input }) => {
        const score = Math.min(input.length / 100, 1.0);
        return JSON.stringify({
          ok: score >= 0.5,
          score,
          feedback:
            score >= 0.5
              ? `Sufficient length: ${input.length} chars`
              : `Too short: ${input.length} chars (need 50+)`,
        });
      },
    });
  });

  describe('runWithFeedback', () => {
    it('succeeds on first attempt when validator passes', async () => {
      const ValidatorSchema = z.object({
        input: z.string(),
      });

      registry.register({
        name: 'test_validator_immediate',
        description: 'Test validator that always passes',
        schema: ValidatorSchema,
        execute: async () => {
          return JSON.stringify({
            ok: true,
            score: 1.0,
            feedback: 'Perfect!',
          });
        },
      });

      const task: FeedbackLoopTask = {
        id: 'test_1',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_immediate', successThreshold: 1.0 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response',
      };

      const result = await engine.runWithFeedback(task);
      expect(result.succeeded).toBe(true);
      expect(result.rounds).toBe(1);
      expect(result.finalScore).toBe(1.0);
    });

    it('retries up to maxRounds until success', async () => {
      const task: FeedbackLoopTask = {
        id: 'test_2',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_sequential', successThreshold: 1.0 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response',
      };

      const result = await engine.runWithFeedback(task);
      expect(result.succeeded).toBe(true);
      expect(result.rounds).toBe(3);
      expect(result.finalScore).toBe(1.0);
    });

    it('returns best attempt when maxRounds exhausted', async () => {
      const ValidatorSchema = z.object({
        input: z.string(),
      });

      registry.register({
        name: 'test_validator_never_pass',
        description: 'Test validator that never passes',
        schema: ValidatorSchema,
        execute: async () => {
          return JSON.stringify({
            ok: false,
            score: 0.1,
            feedback: 'Keep trying',
          });
        },
      });

      const task: FeedbackLoopTask = {
        id: 'test_3',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_never_pass', successThreshold: 1.0 },
        maxRounds: 2,
        initialPrompt: 'Generate a test response',
      };

      const result = await engine.runWithFeedback(task);
      expect(result.succeeded).toBe(false);
      expect(result.rounds).toBe(2);
    });

    it('respects successThreshold', async () => {
      const task: FeedbackLoopTask = {
        id: 'test_4',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_partial', successThreshold: 0.5 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response that is at least 50 chars long to pass the validator',
      };

      const result = await engine.runWithFeedback(task);
      expect(result.finalScore).toBeGreaterThanOrEqual(0.5);
    });

    it('handles validator returning bare ok string', async () => {
      const ValidatorSchema = z.object({
        input: z.string(),
      });

      registry.register({
        name: 'test_validator_bare_ok',
        description: 'Test validator that returns bare ok string',
        schema: ValidatorSchema,
        execute: async () => {
          return 'ok';
        },
      });

      const task: FeedbackLoopTask = {
        id: 'test_5',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_bare_ok', successThreshold: 1.0 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response',
      };

      const result = await engine.runWithFeedback(task);
      expect(result.succeeded).toBe(true);
      expect(result.rounds).toBe(1);
    });

    it('throws when validator tool not found', async () => {
      const task: FeedbackLoopTask = {
        id: 'test_6',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'nonexistent_validator', successThreshold: 1.0 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response',
      };

      await expect(engine.runWithFeedback(task)).rejects.toThrow('Validator tool not found');
    });

    it('calls onDelta callback with output', async () => {
      const onDelta = vi.fn();
      const ValidatorSchema = z.object({
        input: z.string(),
      });

      registry.register({
        name: 'test_validator_delta',
        description: 'Test validator for delta',
        schema: ValidatorSchema,
        execute: async () => {
          return JSON.stringify({
            ok: true,
            score: 1.0,
            feedback: 'Done',
          });
        },
      });

      const task: FeedbackLoopTask = {
        id: 'test_7',
        toolName: 'feedback_loop',
        taskType: 'engineering',
        arguments: {},
        dependencies: [],
        status: 'pending',
        validator: { toolName: 'test_validator_delta', successThreshold: 1.0 },
        maxRounds: 5,
        initialPrompt: 'Generate a test response',
      };

      await engine.runWithFeedback(task, onDelta);
      expect(onDelta).toHaveBeenCalled();
    });
  });
});
