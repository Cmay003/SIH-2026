import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost, setUnauthorizedHandler } from "../api/client";
import { safeNext } from "../lib/navigation";

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("safeNext", () => {
  it.each([
    [null, "/"],
    ["/", "/"],
    ["/officer.html?focus=NODE-04", "/officer.html?focus=NODE-04"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/login.html", "/"],
    ["/\t/evil.example", "/"], // browsers drop the tab -> "//evil.example" (review R16)
    ["/\n/evil.example", "/"],
    ["/%09/ok", "/%09/ok"], // an ENCODED tab is a harmless same-site path
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input, "http://localhost:3000")).toBe(expected);
  });
});

describe("api client", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { ok: true, value: 3 });
    await expect(apiGet<{ value: number }>("/api/x")).resolves.toEqual({ ok: true, value: 3 });
  });

  it("redirects to login once on 401 from a data endpoint", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(401, { error: "Login required" });
    await expect(apiGet("/api/sensors")).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet("/api/hazards")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1); // not once per poll
  });

  it("redirects on the session-ended code too", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(401, { error: "Session gone", code: "login_required" });
    await expect(apiGet("/api/sos")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not redirect for a 401 that is not about the session (B53 redirect loop)", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(401, { detail: "Unauthorized - valid X-API-Key header required" });
    await expect(apiGet("/api/admin/nodes")).rejects.toMatchObject({
      status: 401, message: "Unauthorized - valid X-API-Key header required",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not redirect for a failed login (shows the message instead)", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(401, { error: "Sign-in failed: wrong username or password, or the account is temporarily locked after repeated failures." });
    await expect(apiPost("/api/auth/login", {})).rejects.toThrow("Sign-in failed: wrong username or password, or the account is temporarily locked after repeated failures.");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("uses FastAPI-style detail messages too", async () => {
    mockFetch(404, { detail: "Unknown node_id 'X'" });
    await expect(apiGet("/api/forecast/X")).rejects.toMatchObject({ status: 404, message: "Unknown node_id 'X'" });
  });

  it("sends JSON bodies", async () => {
    const spy = mockFetch(200, { ok: true });
    await apiPost("/api/auth/login", { username: "a", password: "b" });
    const [, init] = spy.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "a", password: "b" });
  });
});
