import { describe, expect, it } from "vitest";
import { parsePeersFile } from "../src/config.js";

describe("parsePeersFile", () => {
  it("accepts a self name and at least one peer", () => {
    expect(parsePeersFile('{"self":"wsl","peers":[{"name":"homelab","ssh":"homelab"}]}')).toEqual({
      self: "wsl",
      peers: [{ name: "homelab", ssh: "homelab" }],
    });
  });

  it("rejects an empty peer list", () => {
    expect(() => parsePeersFile('{"self":"wsl","peers":[]}')).toThrow("lists no peers");
  });

  it("rejects duplicate peer names", () => {
    expect(() =>
      parsePeersFile('{"self":"wsl","peers":[{"name":"a","ssh":"x"},{"name":"a","ssh":"y"}]}'),
    ).toThrow('names peer "a" twice');
  });
});
