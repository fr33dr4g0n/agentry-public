import { describe, expect, it } from "vitest";
import { CreateProjectRequestSchema, IngestEventSchema, SignupRequestSchema } from "./schemas.js";

describe("SignupRequestSchema", () => {
  it("accepts valid email", () => {
    expect(SignupRequestSchema.parse({ email: "a@b.com" }).email).toBe("a@b.com");
  });
  it("rejects junk", () => {
    expect(() => SignupRequestSchema.parse({ email: "not-an-email" })).toThrow();
    expect(() => SignupRequestSchema.parse({})).toThrow();
  });
});

describe("CreateProjectRequestSchema", () => {
  it("accepts minimum", () => {
    expect(CreateProjectRequestSchema.parse({ name: "p" }).name).toBe("p");
  });
  it("accepts full", () => {
    const p = CreateProjectRequestSchema.parse({
      name: "p",
      repo_url: "https://github.com/me/r",
      default_branch: "main",
      local_path: "/abs/path",
    });
    expect(p.repo_url).toBe("https://github.com/me/r");
  });
  it("rejects empty name", () => {
    expect(() => CreateProjectRequestSchema.parse({ name: "" })).toThrow();
  });
});

describe("IngestEventSchema", () => {
  it("accepts a real-shaped Sentry payload", () => {
    const p = IngestEventSchema.parse({
      event_id: "abcd",
      timestamp: 1234567890,
      platform: "node",
      environment: "prod",
      level: "error",
      message: "boom",
      exception: {
        values: [{
          type: "TypeError",
          value: "x is null",
          stacktrace: {
            frames: [{ filename: "src/a.js", function: "f", lineno: 1, in_app: true }],
          },
        }],
      },
      tags: { foo: "bar" },
      extra: { anything: { nested: true } },
    });
    expect(p.exception?.values?.[0]?.type).toBe("TypeError");
  });
  it("accepts the minimum (just an empty object)", () => {
    expect(() => IngestEventSchema.parse({})).not.toThrow();
  });
  it("rejects invalid level enum", () => {
    expect(() => IngestEventSchema.parse({ level: "catastrophic" })).toThrow();
  });
  it("survives unknown extra fields", () => {
    expect(() => IngestEventSchema.parse({ unknown_field: "ok" })).not.toThrow();
  });
});
