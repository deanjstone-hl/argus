import axios, { AxiosResponse } from 'axios';

const OLLAMA_BASE = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';

interface EmbeddingsRequest {
  model: string;
  prompt: string;
}

interface EmbeddingsResponse {
  embedding: number[];
}

class OllamaAdapter {
  async embed(text: string): Promise<number[]> {
    const response: AxiosResponse<EmbeddingsResponse> = await axios.post(
      `${OLLAMA_BASE}/api/embeddings`,
      {
        model: EMBED_MODEL,
        prompt: text,
      } as EmbeddingsRequest,
    );
    return response.data.embedding;
  }
}

export const ollamaAdapter = new OllamaAdapter();
