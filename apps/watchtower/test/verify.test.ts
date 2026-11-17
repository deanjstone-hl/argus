import { describe, it, expect } from "vitest";
import { verifyRowCounts, spotCheck, type ServiceCheckRow } from "../scripts/verify.js";

describe("verifyRowCounts", () => {
  it("passes when counts match", () => {
    expect(verifyRowCounts(220_006, 220_006)).toEqual({ ok: true, sourceCount: 220_006, destCount: 220_006 });
  });

  it("fails closed when destination is short", () => {
    const result = verifyRowCounts(220_006, 219_999);
    expect(result.ok).toBe(false);
    expect(result.sourceCount).toBe(220_006);
    expect(result.destCount).toBe(219_999);
  });

  it("fails closed when destination has extra rows", () => {
    expect(verifyRowCounts(100, 101).ok).toBe(false);
  });
});

function row(overrides: Partial<ServiceCheckRow> = {}): ServiceCheckRow {
  return {
    id: "row-1",
    service_key: "budget-api",
    host: "homelab",
    status: "healthy",
    detail: { latency_ms: 12 },
    checked_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("spotCheck", () => {
  it("passes when every sampled row matches exactly", () => {
    const source = [row({ id: "a" }), row({ id: "b", status: "degraded" })];
    const destById = new Map(source.map((r) => [r.id, r]));
    const result = spotCheck(source, destById);
    expect(result).toEqual({ ok: true, checked: 2, mismatches: [] });
  });

  it("fails closed when a sampled row is missing from the destination", () => {
    const source = [row({ id: "a" })];
    const result = spotCheck(source, new Map());
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ id: "a", field: "id", sourceValue: "a", destValue: undefined }]);
  });

  it("fails closed on a field-level mismatch", () => {
    const source = [row({ id: "a", status: "healthy" })];
    const destById = new Map([["a", row({ id: "a", status: "down" })]]);
    const result = spotCheck(source, destById);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ id: "a", field: "status", sourceValue: "healthy", destValue: "down" }]);
  });

  it("fails closed on a detail (JSON) mismatch", () => {
    const source = [row({ id: "a", detail: { latency_ms: 12 } })];
    const destById = new Map([["a", row({ id: "a", detail: { latency_ms: 999 } })]]);
    const result = spotCheck(source, destById);
    expect(result.ok).toBe(false);
    expect(result.mismatches[0].field).toBe("detail");
  });

  it("treats null and missing detail as equal", () => {
    const source = [row({ id: "a", detail: null })];
    const destById = new Map([["a", row({ id: "a", detail: undefined })]]);
    expect(spotCheck(source, destById).ok).toBe(true);
  });
});
