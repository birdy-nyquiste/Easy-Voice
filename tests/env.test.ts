import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredEnv } from "@/lib/env";

afterEach(() => vi.unstubAllEnvs());

describe("requiredEnv", () => {
  it("returns the value when set", () => {
    vi.stubEnv("SOME_SECRET", "abc");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("abc");
  });

  it("falls back to the dev default outside production", () => {
    vi.stubEnv("SOME_SECRET", "");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("dev");
  });

  it("refuses to run a production server without it", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SOME_SECRET", "");
    expect(() => requiredEnv("SOME_SECRET", "dev")).toThrow(/Missing required environment variable SOME_SECRET/);
  });

  it("lets `next build` proceed without production secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("SOME_SECRET", "");
    expect(requiredEnv("SOME_SECRET", "dev")).toBe("dev");
  });
});
