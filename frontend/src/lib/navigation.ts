/** Where to go after signing in: only a page on THIS site, never another
 *  site and never back to the login page itself. Mirrors auth.js.
 *  Browsers treat "//host" and "/\host" as other sites and silently drop
 *  tabs/newlines ("/<tab>/evil" becomes "//evil"), so control characters
 *  and backslashes are rejected outright, then the URL must resolve to our
 *  own origin (review R16). */
export function safeNext(next: string | null | undefined, origin = window.location.origin): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname.startsWith("/login")) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
