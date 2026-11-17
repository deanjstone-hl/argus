import { describe, expect, it } from "vitest";
import { findRpcExit, RpcFailureError } from "../src/t3-client.js";

describe("findRpcExit", () => {
  it("ignores frames for other requests and non-exit frames", () => {
    expect(findRpcExit(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [] }), "1")).toBeUndefined();
    expect(
      findRpcExit(JSON.stringify({ _tag: "Exit", requestId: "2", exit: { _tag: "Success", value: 1 } }), "1"),
    ).toBeUndefined();
  });

  it("returns the success value, including from a batched array frame", () => {
    const frame = JSON.stringify([
      { _tag: "Pong" },
      { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { threadId: "t1" } } },
    ]);
    expect(findRpcExit(frame, "1")).toEqual({ value: { threadId: "t1" } });
  });

  it("surfaces the failure message", () => {
    const frame = JSON.stringify({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "NotFound", message: "no such thread" } }] },
    });
    expect(() => findRpcExit(frame, "1")).toThrow(new RpcFailureError("no such thread"));
  });

  it("falls back to the error tag, then to the defect", () => {
    const tagged = JSON.stringify({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "ThreadArchived" } }] },
    });
    expect(() => findRpcExit(tagged, "1")).toThrow("ThreadArchived");
    const defect = JSON.stringify({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] },
    });
    expect(() => findRpcExit(defect, "1")).toThrow("boom");
  });
});
