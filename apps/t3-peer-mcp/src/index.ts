#!/usr/bin/env node
import { hostname } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadPeersFile } from "./config.js";
import { PeerConnection } from "./peer-connection.js";
import { createServer } from "./tools.js";

const config = loadPeersFile();
const label = `t3-peer-mcp:${config.self}@${hostname()}`;
const peers = config.peers.map((peer) => new PeerConnection(peer, label));
const registry = {
  self: config.self,
  peers: peers.map((peer) => ({ name: peer.config.name, client: () => peer.client() })),
};

const server = createServer(registry);
await server.connect(new StdioServerTransport());
console.error(`argus-t3-peer-mcp running in stdio mode (self: ${config.self}, peers: ${config.peers.map((p) => p.name).join(", ")})`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.all(peers.map((peer) => peer.close()));
  process.exit(0);
}
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
