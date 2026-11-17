// Client for one T3 server's orchestration API (protocol 2), reached through
// a local origin (the SSH tunnel). Reads are plain HTTP; writes go over the
// /ws Effect-RPC socket, because T3 0.0.46 removed the HTTP dispatch route.
//
// An unknown /api route does not 404: the SPA fallback answers 200 with the
// web app's index.html. Every read checks the content type for that reason.

import type { Projection, ShellSnapshot, ThreadShell } from "./commands.js";

const PROTOCOL_HEADER = { "x-t3-orchestration-protocol": "2" };
const RPC_TIMEOUT_MS = 30_000;

export class RpcFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcFailureError";
  }
}

interface RpcCause {
  _tag?: string;
  error?: { _tag?: string; message?: string } | string;
  defect?: unknown;
}

function describeCause(cause: RpcCause | undefined): string {
  if (cause === undefined) return "unknown error";
  if (typeof cause.error === "string") return cause.error;
  if (cause.error !== undefined) return cause.error.message ?? cause.error._tag ?? "unknown error";
  if (cause.defect !== undefined) return typeof cause.defect === "string" ? cause.defect : JSON.stringify(cause.defect);
  return cause._tag ?? "unknown error";
}

/** Parse one socket frame; returns the request's exit if this frame carries it. */
export function findRpcExit(frame: string, requestId: string): { value: unknown } | undefined {
  const decoded: unknown = JSON.parse(frame);
  const messages = Array.isArray(decoded) ? decoded : [decoded];
  const exit = messages.find(
    (message): message is { exit: { _tag: string; value?: unknown; cause?: RpcCause[] } } =>
      message?._tag === "Exit" && message.requestId === requestId,
  )?.exit;
  if (exit === undefined) return undefined;
  if (exit._tag === "Success") return { value: exit.value };
  throw new RpcFailureError(describeCause(exit.cause?.[0]));
}

export class T3Client {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, ...PROTOCOL_HEADER },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) throw new Error(`T3 ${path} failed: HTTP ${response.status}`);
    if (!contentType.includes("application/json")) {
      throw new Error(`T3 ${path} returned ${contentType || "no content type"}, not JSON — has the API changed?`);
    }
    return (await response.json()) as T;
  }

  getShell(): Promise<ShellSnapshot> {
    return this.getJson<ShellSnapshot>("/api/orchestration/shell");
  }

  async getProjection(threadId: string): Promise<Projection> {
    const body = await this.getJson<{ projection: Projection }>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
    );
    return body.projection;
  }

  /** One request per socket: the calls are rare and this keeps no state between tools. */
  rpc(tag: string, payload: unknown): Promise<unknown> {
    const url = `${this.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`;
    // Node's WebSocket (undici) accepts upgrade headers as a non-standard init field.
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } } as never);
    const requestId = "1";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`T3 ${tag} got no reply within ${RPC_TIMEOUT_MS / 1000}s`));
      }, RPC_TIMEOUT_MS);
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        socket.close();
        settle();
      };
      socket.onopen = () => {
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      };
      socket.onmessage = (event) => {
        try {
          const exit = findRpcExit(String(event.data), requestId);
          if (exit !== undefined) finish(() => resolve(exit.value));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      socket.onerror = () => finish(() => reject(new Error(`T3 socket error during ${tag}`)));
      socket.onclose = (event) =>
        finish(() => reject(new Error(`T3 socket closed during ${tag} (code ${event.code})`)));
    });
  }

  /** The HTTP shell's archivedThreads is always empty; archived threads only come over RPC. */
  async getArchivedThreads(): Promise<ThreadShell[]> {
    const snapshot = (await this.rpc("orchestration.getArchivedShellSnapshot", {})) as { threads: ThreadShell[] };
    return snapshot.threads;
  }

  dispatchCommand(command: unknown): Promise<unknown> {
    return this.rpc("orchestration.dispatchCommand", command);
  }

  launchThread(input: unknown): Promise<unknown> {
    return this.rpc("orchestration.launchThread", input);
  }
}
