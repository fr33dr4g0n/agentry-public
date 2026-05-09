import { describe, expect, it } from "vitest";
import { constantTimeEqual, mintApiKey, mintDsn, parseDsn, sha256Hex } from "./crypto.js";

describe("sha256Hex", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("hello")).toBe(await sha256Hex("hello"));
    expect(await sha256Hex("hello")).not.toBe(await sha256Hex("world"));
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("constantTimeEqual", () => {
  it("works", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("ab", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("mintApiKey", () => {
  it("produces an agk_ prefixed key with consistent hash", async () => {
    const k = await mintApiKey();
    expect(k.raw).toMatch(/^agk_/);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(k.raw)).toBe(k.hash);
    expect(k.prefix).toBe(k.raw.slice(0, 12));
  });
  it("never collides", async () => {
    const k1 = await mintApiKey();
    const k2 = await mintApiKey();
    expect(k1.raw).not.toBe(k2.raw);
  });
});

describe("mintDsn / parseDsn", () => {
  it("round-trips with uuid-v7 style id", async () => {
    const projectId = "01970fed-1b4f-7c25-9e94-cb45a8def123";
    const d = await mintDsn(projectId);
    expect(d.raw.startsWith("agnt_" + projectId + ".")).toBe(true);
    const parsed = parseDsn(d.raw);
    expect(parsed?.projectId).toBe(projectId);
    expect(parsed?.token).toBe(d.token);
  });
  it("round-trips with simple id", async () => {
    const d = await mintDsn("p1");
    const parsed = parseDsn(d.raw);
    expect(parsed?.projectId).toBe("p1");
    expect(parsed?.token).toBe(d.token);
  });
  it("rejects malformed dsns", () => {
    expect(parseDsn("foo_bar")).toBeNull();
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("agnt_")).toBeNull();
    expect(parseDsn("agnt_only")).toBeNull();
    expect(parseDsn("agnt_id.")).toBeNull();
    expect(parseDsn("agnt_.token")).toBeNull();
  });
});
