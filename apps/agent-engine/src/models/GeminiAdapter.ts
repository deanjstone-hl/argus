import { spawn, ChildProcess } from 'child_process';

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: { text: string };
  error?: { code: number; message: string };
}

class GeminiAdapter {
  private child: ChildProcess | null = null;
  private pendingRequests: Map<
    number,
    { resolve: (v: string) => void; reject: (e: Error) => void }
  > = new Map();
  private nextId: number = 1;
  private buffer: string = '';

  private ensureProcess(): ChildProcess {
    if (this.child) {
      return this.child;
    }

    this.child = spawn('gemini', ['--acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          const pending = this.pendingRequests.get(response.id);

          if (!pending) return;

          this.pendingRequests.delete(response.id);

          if (response.error) {
            pending.reject(
              new Error(`Gemini error: ${response.error.message}`),
            );
          } else if (response.result?.text) {
            pending.resolve(response.result.text);
          } else {
            pending.reject(new Error('Unexpected Gemini response format'));
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
          }
          this.pendingRequests.clear();
        }
      }
    });

    this.child.on('error', (err) => {
      for (const pending of this.pendingRequests.values()) {
        pending.reject(err);
      }
      this.pendingRequests.clear();
      this.child = null;
    });

    return this.child;
  }

  async ask(
    prompt: string,
    options?: { timeout?: number },
  ): Promise<string> {
    const timeout = options?.timeout ?? 60000;
    const child = this.ensureProcess();
    const id = this.nextId++;

    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('GeminiAdapter timeout'));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value.trim());
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const request = {
        jsonrpc: '2.0',
        id,
        method: 'chat/message',
        params: { text: prompt },
      };

      child.stdin?.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }
}

export const geminiAdapter = new GeminiAdapter();
