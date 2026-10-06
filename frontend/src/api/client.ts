// Fetch wrapper for the SANJEEVNI API (same origin; the session cookie is
// sent automatically). A 401 from any data endpoint means the session
// ended: send the user to the login page and back here afterwards - the
// same behaviour public/auth-ui.js gives the old pages.

export class ApiError extends Error {
  readonly status: number;
  /** Parsed response body - e.g. the SOS 409 "already_active" details */
  readonly data: unknown;
  constructor(status: number, message: string, data: unknown = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function loginUrl(reason?: "expired" | "loggedout"): string {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  return `/login.html?next=${next}${reason ? `&${reason}=1` : ""}`;
}

// Replaceable so tests can observe the redirect instead of navigating.
let onUnauthorized = (): void => window.location.replace(loginUrl("expired"));
let redirecting = false;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
  redirecting = false;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);

  if (res.status === 401 && !path.startsWith("/api/auth/") && !redirecting) {
    redirecting = true;
    onUnauthorized();
  }
  if (!res.ok) {
    const fields = (data ?? {}) as { error?: unknown; detail?: unknown };
    const message = typeof fields.error === "string" ? fields.error
      : typeof fields.detail === "string" ? fields.detail
      : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => request<T>("GET", path);
export const apiPost = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
