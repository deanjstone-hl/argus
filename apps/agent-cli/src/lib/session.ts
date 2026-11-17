import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

// Same check agent-engine applies to /chat's sessionId (the CLI needs a UUID).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionId = (value: string): boolean => UUID_PATTERN.test(value);

/** Resolved per call so a test can point HOME at a temp directory. */
export function lastSessionPath(): string {
  return join(homedir(), '.argus', 'last-session');
}

/** The id `agent run --continue` resumes, or undefined when none is stored. */
export function readLastSession(path = lastSessionPath()): string | undefined {
  let stored: string;
  try {
    stored = readFileSync(path, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!isSessionId(stored)) {
    throw new Error(`${path} does not hold a session UUID; start one with --session <uuid>`);
  }
  return stored;
}

export function saveLastSession(sessionId: string, path = lastSessionPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${sessionId}\n`);
}
