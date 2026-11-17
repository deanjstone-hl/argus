import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { registry } from '../src/core/ArgusRegistry.js';

describe('ArgusRegistry', () => {
  describe('validate', () => {
    it('returns null for valid task args', () => {
      const result = registry.validate('task', { taskType: 'engineering', prompt: 'hello' });
      expect(result).toBeNull();
    });

    it('returns null for task args with optional dependencies', () => {
      const result = registry.validate('task', {
        taskType: 'bulk_ingestion',
        prompt: 'process files',
        dependencies: ['dep1', 'dep2'],
      });
      expect(result).toBeNull();
    });

    it('returns error string for invalid task args (missing prompt)', () => {
      const result = registry.validate('task', { taskType: 'engineering' });
      expect(result).toBeTypeOf('string');
      expect(result).not.toBeNull();
      expect(result).toContain('prompt');
    });

    it('returns error string for invalid task args (missing taskType)', () => {
      const result = registry.validate('task', { prompt: 'hello' });
      expect(result).toBeTypeOf('string');
      expect(result).toContain('taskType');
    });

    it('returns error string for wrong taskType enum', () => {
      const result = registry.validate('task', { taskType: 'invalid_type', prompt: 'hello' });
      expect(result).toBeTypeOf('string');
      expect(result).not.toBeNull();
    });

    it('returns error string for non-string prompt', () => {
      const result = registry.validate('task', { taskType: 'engineering', prompt: 123 });
      expect(result).toBeTypeOf('string');
      expect(result).not.toBeNull();
    });

    it('returns null for valid context_payload args', () => {
      const result = registry.validate('context_payload', {
        fileName: 'test.md',
        content: 'hello world',
      });
      expect(result).toBeNull();
    });

    it('returns error string for invalid context_payload (missing fileName)', () => {
      const result = registry.validate('context_payload', { content: 'hello' });
      expect(result).toBeTypeOf('string');
      expect(result).toContain('fileName');
    });

    it('returns error string for invalid context_payload (missing content)', () => {
      const result = registry.validate('context_payload', { fileName: 'test.md' });
      expect(result).toBeTypeOf('string');
      expect(result).toContain('content');
    });

    it('returns error string for unknown tool', () => {
      const result = registry.validate('nonexistent_tool', {});
      expect(result).toContain('Tool not found');
    });

    it('includes tool name in error message for unknown tool', () => {
      const result = registry.validate('foobar', {});
      expect(result).toContain('foobar');
    });

    it('returns error string for dependencies with non-string items', () => {
      const result = registry.validate('task', {
        taskType: 'engineering',
        prompt: 'hello',
        dependencies: [123],
      });
      expect(result).toBeTypeOf('string');
    });
  });

  describe('register and getTool', () => {
    it('registers a new tool and retrieves it', () => {
      const schema = z.object({ value: z.number() });
      registry.register({
        name: 'test_tool_new',
        description: 'Test tool',
        schema,
        execute: async () => 'done',
      });
      const tool = registry.getTool('test_tool_new');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('test_tool_new');
      expect(tool?.description).toBe('Test tool');
    });

    it('returns undefined for unregistered tool', () => {
      const tool = registry.getTool('does_not_exist');
      expect(tool).toBeUndefined();
    });

    it('overwrites existing tool with same name', () => {
      const schema1 = z.object({ foo: z.string() });
      const schema2 = z.object({ bar: z.number() });
      registry.register({
        name: 'test_overwrite',
        description: 'First',
        schema: schema1,
        execute: async () => 'first',
      });
      registry.register({
        name: 'test_overwrite',
        description: 'Second',
        schema: schema2,
        execute: async () => 'second',
      });
      const tool = registry.getTool('test_overwrite');
      expect(tool?.description).toBe('Second');
    });

    it('registered tool can be validated', () => {
      const schema = z.object({ count: z.number() });
      registry.register({
        name: 'validate_test',
        description: 'For validation',
        schema,
        execute: async () => 'ok',
      });
      const result = registry.validate('validate_test', { count: 42 });
      expect(result).toBeNull();
    });
  });

  describe('getDefinitions', () => {
    it('returns definitions including built-in tools', () => {
      const defs = registry.getDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(2);
      const names = defs.map((d) => d.name);
      expect(names).toContain('task');
      expect(names).toContain('context_payload');
    });

    it('each definition has name, description, and schema', () => {
      const defs = registry.getDefinitions();
      for (const def of defs) {
        expect(def.name).toBeTypeOf('string');
        expect(def.description).toBeTypeOf('string');
        expect(def.schema).toBeDefined();
        expect(typeof def.schema).toBe('object');
      }
    });

    it('schema is converted to JSON schema format', () => {
      const defs = registry.getDefinitions();
      const taskDef = defs.find((d) => d.name === 'task');
      expect(taskDef).toBeDefined();
      expect(taskDef?.schema).toHaveProperty('type');
      expect(taskDef?.schema).toHaveProperty('properties');
    });

    it('task schema includes taskType, prompt, and dependencies', () => {
      const defs = registry.getDefinitions();
      const taskDef = defs.find((d) => d.name === 'task');
      const schema = taskDef?.schema as any;
      expect(schema.properties).toHaveProperty('taskType');
      expect(schema.properties).toHaveProperty('prompt');
      expect(schema.properties).toHaveProperty('dependencies');
    });

    it('context_payload schema includes fileName and content', () => {
      const defs = registry.getDefinitions();
      const contextDef = defs.find((d) => d.name === 'context_payload');
      const schema = contextDef?.schema as any;
      expect(schema.properties).toHaveProperty('fileName');
      expect(schema.properties).toHaveProperty('content');
    });

    it('newly registered tool appears in definitions', () => {
      const schema = z.object({ id: z.string() });
      registry.register({
        name: 'test_in_defs',
        description: 'Test definition',
        schema,
        execute: async () => 'ok',
      });
      const defs = registry.getDefinitions();
      const found = defs.find((d) => d.name === 'test_in_defs');
      expect(found).toBeDefined();
      expect(found?.description).toBe('Test definition');
    });
  });

  describe('integration', () => {
    it('register, validate, getTool, and getDefinitions work together', () => {
      const schema = z.object({ input: z.string().min(3) });
      const toolDef = {
        name: 'integration_test',
        description: 'Integration test tool',
        schema,
        execute: async () => 'result',
      };
      registry.register(toolDef);

      const validation = registry.validate('integration_test', { input: 'hello' });
      expect(validation).toBeNull();

      const tool = registry.getTool('integration_test');
      expect(tool).toBeDefined();

      const defs = registry.getDefinitions();
      const def = defs.find((d) => d.name === 'integration_test');
      expect(def).toBeDefined();
    });

    it('invalid data fails validation but tool still exists', () => {
      const schema = z.object({ required: z.boolean() });
      registry.register({
        name: 'validation_test',
        description: 'Test',
        schema,
        execute: async () => 'ok',
      });

      const invalidResult = registry.validate('validation_test', { required: 'not a boolean' });
      expect(invalidResult).not.toBeNull();

      const tool = registry.getTool('validation_test');
      expect(tool).toBeDefined();
    });

    it('multiple validation errors are included in response', () => {
      const result = registry.validate('task', {
        taskType: 'invalid',
        prompt: 123,
      });
      expect(result).toBeTypeOf('string');
      expect(result?.split(';').length).toBeGreaterThanOrEqual(1);
    });
  });
});
