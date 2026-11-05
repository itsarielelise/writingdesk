import { afterEach, describe, expect, it } from "vitest";
import { publicOrigin } from "@/lib/server/origin";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
afterEach(() => { delete process.env.SITE_URL; });

describe("publicOrigin", () => {
  it("uses forwarded headers behind a proxy", () => {
    expect(publicOrigin(req("http://localhost:10000/auth/callback", { "x-forwarded-host": "writing-desk-kezn.onrender.com", "x-forwarded-proto": "https" }))).toBe("https://writing-desk-kezn.onrender.com");
  });
  it("uses the Host header and assumes https for public hosts", () => {
    expect(publicOrigin(req("http://localhost:10000/x", { host: "writing-desk-kezn.onrender.com" }))).toBe("https://writing-desk-kezn.onrender.com");
  });
  it("falls back to SITE_URL when only an internal host is known", () => {
    process.env.SITE_URL = "https://example.com/";
    expect(publicOrigin(req("http://localhost:10000/x", { host: "localhost:10000" }))).toBe("https://example.com");
  });
  it("works for local development", () => {
    expect(publicOrigin(req("http://localhost:3000/x", { host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
});
