import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const PeersFileSchema = z.object({
  /** This environment's own name, stamped on messages it sends to a peer. */
  self: z.string().min(1),
  peers: z
    .array(z.object({ name: z.string().min(1), ssh: z.string().min(1) }))
    .min(1, "peers.json lists no peers"),
});

export type PeersFile = z.infer<typeof PeersFileSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), ".argus", "t3-peer-mcp", "peers.json");

export function parsePeersFile(raw: string): PeersFile {
  const parsed = PeersFileSchema.parse(JSON.parse(raw));
  const names = parsed.peers.map((peer) => peer.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`peers.json names peer "${duplicate}" twice`);
  return parsed;
}

export function loadPeersFile(path = process.env.T3_PEER_CONFIG ?? DEFAULT_CONFIG_PATH): PeersFile {
  return parsePeersFile(readFileSync(path, "utf8"));
}
