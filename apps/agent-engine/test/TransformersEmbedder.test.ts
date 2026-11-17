import { describe, it, expect } from 'vitest';
import { createTransformersEmbedder, EMBED_MODEL } from '../src/models/TransformersEmbedder.js';

// A stand-in for transformers.js's `pipeline`: records how it was loaded and
// called, and returns a tensor-like object with a Float32Array.
function fakePipeline(dimensions = 768) {
  const loads: Array<{ task: string; model: string; options: Record<string, unknown> }> = [];
  const calls: Array<{ text: string; options: Record<string, unknown> }> = [];
  const load = async (task: string, model: string, options: Record<string, unknown>) => {
    loads.push({ task, model, options });
    return async (text: string, callOptions: Record<string, unknown>) => {
      calls.push({ text, options: callOptions });
      return { data: new Float32Array(dimensions).fill(0.5) };
    };
  };
  return { load, loads, calls };
}

describe('createTransformersEmbedder', () => {
  it('embeds as the knowledge app does: the same model, quantized, mean-pooled and normalised', async () => {
    const fake = fakePipeline();
    const embedder = createTransformersEmbedder({ loadPipeline: fake.load, cacheDir: '/cache' });
    const vector = await embedder.embed('passkeys');

    expect(EMBED_MODEL).toBe('Xenova/nomic-embed-text-v1');
    expect(fake.loads).toEqual([
      { task: 'feature-extraction', model: 'Xenova/nomic-embed-text-v1', options: { dtype: 'q8', cache_dir: '/cache' } },
    ]);
    expect(fake.calls).toEqual([{ text: 'passkeys', options: { pooling: 'mean', normalize: true } }]);
    expect(vector).toHaveLength(768);
    expect(Array.isArray(vector)).toBe(true);
  });

  it('loads the model once', async () => {
    const fake = fakePipeline();
    const embedder = createTransformersEmbedder({ loadPipeline: fake.load, cacheDir: '/cache' });
    await Promise.all([embedder.embed('a'), embedder.embed('b')]);
    expect(fake.loads).toHaveLength(1);
  });

  it('retries the load on the next call after a failed one', async () => {
    const fake = fakePipeline();
    let attempts = 0;
    const embedder = createTransformersEmbedder({
      loadPipeline: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return fake.load(...args);
      },
      cacheDir: '/cache',
    });
    await expect(embedder.embed('a')).rejects.toThrow('offline');
    await expect(embedder.embed('a')).resolves.toHaveLength(768);
  });

  it('rejects a vector that would not fit the 768-d embedding column', async () => {
    const fake = fakePipeline(384);
    const embedder = createTransformersEmbedder({ loadPipeline: fake.load, cacheDir: '/cache' });
    await expect(embedder.embed('a')).rejects.toThrow('expected 768 dimensions, got 384');
  });
});
