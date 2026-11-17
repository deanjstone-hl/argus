import Database from 'better-sqlite3';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SearchResult } from '../types.js';
import { ollamaAdapter } from '../models/OllamaAdapter.js';

interface EmbeddingRow {
  id: string;
  fileName: string;
  chunk: string;
  vector: Buffer;
}

export class VectorEngine {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private allStmt: Database.Statement;

  constructor(dbPath: string = './argus-vectors.db') {
    this.db = new Database(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        fileName TEXT NOT NULL,
        chunk TEXT NOT NULL,
        vector BLOB NOT NULL
      )
    `);

    this.insertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO embeddings (id, fileName, chunk, vector) VALUES (?, ?, ?, ?)'
    );

    this.allStmt = this.db.prepare(
      'SELECT id, fileName, chunk, vector FROM embeddings'
    );
  }

  private serializeVector(vec: number[]): Buffer {
    return Buffer.from(new Float64Array(vec).buffer);
  }

  private deserializeVector(buf: Buffer): number[] {
    return Array.from(new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8));
  }

  private cosine(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, idx) => sum + val * b[idx]!, 0);
    const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  async indexFile(fileName: string, content: string): Promise<void> {
    const paragraphs = content
      .split(/\n{2,}/)
      .filter((p) => p.trim().length > 0);

    const chunks: string[] = [];

    for (const paragraph of paragraphs) {
      if (paragraph.length <= 500) {
        chunks.push(paragraph);
      } else {
        const lines = paragraph.split('\n');
        let currentChunk = '';

        for (const line of lines) {
          if ((currentChunk + line).length > 500 && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = line;
          } else {
            currentChunk += (currentChunk ? '\n' : '') + line;
          }
        }

        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
      }
    }

    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]!;
      const vector = await ollamaAdapter.embed(chunk);
      const id = `${fileName}:${idx}`;
      this.insertStmt.run(id, fileName, chunk, this.serializeVector(vector));
    }
  }

  async search(query: string, topK: number = 5): Promise<SearchResult[]> {
    const queryVector = await ollamaAdapter.embed(query);
    const rows = this.allStmt.all() as EmbeddingRow[];

    const results = rows.map((row) => {
      const rowVector = this.deserializeVector(row.vector);
      const score = this.cosine(queryVector, rowVector);
      return {
        fileName: row.fileName,
        chunk: row.chunk,
        score,
      } as SearchResult;
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async indexVault(vaultPath: string): Promise<void> {
    const traverseDirectory = async (dirPath: string, basePath: string): Promise<void> => {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        const relativePath = join(basePath, entry.name).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          await traverseDirectory(fullPath, relativePath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await readFile(fullPath, 'utf-8');
          await this.indexFile(relativePath, content);
        }
      }
    };

    await traverseDirectory(vaultPath, '');
  }
}
