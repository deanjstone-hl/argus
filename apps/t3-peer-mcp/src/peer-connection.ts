// Reaches a peer environment's T3 server over SSH, never over the network
// directly. Both T3 servers bind 127.0.0.1:3773 only, so the peer is reached
// through an `ssh -L` tunnel, and the bearer token is a short-lived admin
// session minted on the peer by its own `t3 auth session issue`. The token
// travels back over the SSH channel's stdout into memory: it never touches
// argv, a URL, or disk on this side.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { T3Client } from "./t3-client.js";

export interface PeerConfig {
  /** Name agents use to address the peer, e.g. "homelab" or "wsl". */
  name: string;
  /** SSH destination: an alias from ~/.ssh/config or user@host. */
  ssh: string;
}

const SESSION_TTL = "15m";
const SESSION_REFRESH_MS = 12 * 60_000;
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"];

// Runs on the peer. Finds the T3 binary the same way t3-open-thread.sh does:
// a service install records its version, a desktop backend only its pid.
const ISSUE_SCRIPT = `
set -euo pipefail
home="\${T3CODE_HOME:-$HOME/.t3}"
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null; }
version=$(field "$home/runtime/service-state.json" activeVersion || true)
if [ -n "$version" ]; then bin="$home/runtime/versions/$version/t3"
else bin=$(readlink "/proc/$(field "$home/userdata/server-runtime.json" pid)/exe"); fi
port=$(field "$home/userdata/server-runtime.json" port)
[ -x "$bin" ] && [ -n "$port" ] || { echo "T3 server not found on $(hostname)" >&2; exit 1; }
issued=$("$bin" auth session issue --ttl "$1" --label "$2" --json)
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(json.dumps({"token": d["token"], "sessionId": d["sessionId"], "port": int(sys.argv[2])}))' "$issued" "$port"
`;

const REVOKE_SCRIPT = `
set -euo pipefail
home="\${T3CODE_HOME:-$HOME/.t3}"
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$1" "$2" 2>/dev/null; }
version=$(field "$home/runtime/service-state.json" activeVersion || true)
if [ -n "$version" ]; then bin="$home/runtime/versions/$version/t3"
else bin=$(readlink "/proc/$(field "$home/userdata/server-runtime.json" pid)/exe"); fi
"$bin" auth session revoke "$1" >/dev/null
`;

function runSsh(destination: string, script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, destination, "bash", "-s", "--", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ssh ${destination} failed (exit ${code}): ${stderr.trim() || "no output"}`));
    });
    child.stdin.end(script);
  });
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

// A raw TCP connect is not a usable readiness probe: under WSL2 mirrored
// networking it can succeed before ssh is listening, and the first requests
// then fail with ECONNREFUSED. An HTTP round trip only succeeds once the
// forward really reaches the peer's T3.
async function tunnelReady(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

interface Session {
  client: T3Client;
  sessionId: string;
  issuedAt: number;
}

export class PeerConnection {
  private tunnel?: { process: ChildProcess; localPort: number; remotePort: number };
  private session?: Session;
  private pending?: Promise<T3Client>;

  constructor(
    readonly config: PeerConfig,
    private readonly label: string,
  ) {}

  /** A client for the peer, reusing the tunnel and session while both are fresh. */
  client(): Promise<T3Client> {
    this.pending ??= this.connect().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async connect(): Promise<T3Client> {
    const tunnelAlive = this.tunnel !== undefined && this.tunnel.process.exitCode === null;
    if (this.session && tunnelAlive && Date.now() - this.session.issuedAt < SESSION_REFRESH_MS) {
      return this.session.client;
    }
    const previous = this.session;
    const output = await runSsh(this.config.ssh, ISSUE_SCRIPT, [SESSION_TTL, this.label]);
    const issued = JSON.parse(output) as { token: string; sessionId: string; port: number };
    if (!tunnelAlive || this.tunnel?.remotePort !== issued.port) await this.openTunnel(issued.port);
    this.session = {
      client: new T3Client(`http://127.0.0.1:${this.tunnel!.localPort}`, issued.token),
      sessionId: issued.sessionId,
      issuedAt: Date.now(),
    };
    if (previous) this.revoke(previous.sessionId);
    return this.session.client;
  }

  private async openTunnel(remotePort: number): Promise<void> {
    this.tunnel?.process.kill();
    const localPort = await freeLocalPort();
    const child = spawn(
      "ssh",
      [
        ...SSH_OPTIONS,
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        this.config.ssh,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`ssh tunnel to ${this.config.ssh} exited: ${stderr.trim()}`);
      if (await tunnelReady(localPort)) {
        this.tunnel = { process: child, localPort, remotePort };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    child.kill();
    throw new Error(`ssh tunnel to ${this.config.ssh} did not come up within 15s`);
  }

  private revoke(sessionId: string): void {
    runSsh(this.config.ssh, REVOKE_SCRIPT, [sessionId]).catch((error: Error) =>
      console.error(`t3-peer-mcp: could not revoke session on ${this.config.name}: ${error.message}`),
    );
  }

  /** Revoke the live session and close the tunnel; called on shutdown. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) {
      await runSsh(this.config.ssh, REVOKE_SCRIPT, [session.sessionId]).catch((error: Error) =>
        console.error(`t3-peer-mcp: could not revoke session on ${this.config.name}: ${error.message}`),
      );
    }
    this.tunnel?.process.kill();
    this.tunnel = undefined;
  }
}
