import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from '../core/LiveNoteStore.js';

// The knowledge app (myargus apps/knowledge/src/workers/embed.worker.ts) embeds
// chats in the browser with transformers.js. A query vector is only comparable
// with those if it is made the same way: the same model, the same weights and
// the same pooling. The browser runs on WASM, where transformers.js loads the
// q8 weights (model_quantized.onnx) by default; Node defaults to fp32, so q8 is
// pinned here. Ollama's nomic-embed-text is v1.5, a different model, which is
// why this does not go through OllamaAdapter.
export const EMBED_MODEL = 'Xenova/nomic-embed-text-v1';
const EMBED_DTYPE = 'q8';
// knowledge_chats.embedding is VECTOR(768).
const DIMENSIONS = 768;

type Extractor = (text: string, options: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;
type LoadPipeline = (task: string, model: string, options: Record<string, unknown>) => Promise<Extractor>;

export interface TransformersEmbedderOptions {
  // For tests. Defaults to transformers.js's `pipeline`, imported on first use
  // so the model runtime loads only when a live note is refreshed.
  loadPipeline?: LoadPipeline;
  // Where the model is downloaded to on first use, about 140 MB.
  cacheDir?: string;
}

async function loadTransformersPipeline(task: string, model: string, options: Record<string, unknown>): Promise<Extractor> {
  const { pipeline } = await import('@huggingface/transformers');
  return (await pipeline('feature-extraction', model, options)) as unknown as Extractor;
}

export function createTransformersEmbedder(options: TransformersEmbedderOptions = {}): Embedder {
  const loadPipeline = options.loadPipeline ?? loadTransformersPipeline;
  const cacheDir = options.cacheDir ?? join(homedir(), '.argus', 'models');
  let extractor: Promise<Extractor> | null = null;

  return {
    async embed(text) {
      if (!extractor) {
        extractor = loadPipeline('feature-extraction', EMBED_MODEL, { dtype: EMBED_DTYPE, cache_dir: cacheDir });
        // A failed load is not cached, so the next refresh tries again.
        extractor.catch(() => {
          extractor = null;
        });
      }
      const output = await (await extractor)(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      if (vector.length !== DIMENSIONS) {
        throw new Error(`${EMBED_MODEL}: expected ${DIMENSIONS} dimensions, got ${vector.length}`);
      }
      return vector;
    },
  };
}
