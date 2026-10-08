// =====================================================================
// SANJEEVNI - HTTP security headers.
//
// BASIC headers go on every response. The strict Content-Security-Policy
// goes only on the React pages (frontend/dist): their HTML has no inline
// scripts or styles. The classic public/ pages rely on inline <script>
// and <style>, so they don't get the CSP (they're the fallback only).
// =====================================================================

// What the React pages need, and nothing else:
//  - scripts, styles, fonts, API calls: same origin only
//  - images: same origin, data: URIs (Leaflet's CSS icons) and the
//    OpenStreetMap tile servers used by the officer map
//  - never framed by another site (clickjacking), no plugins, no <base>
//    or form tricks
const REACT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.tile.openstreetmap.org",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function basicSecurityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY", // older browsers; frame-ancestors covers modern ones
    // Location: SOS page; microphone: its voice note. Nothing else.
    "Permissions-Policy": "geolocation=(self), microphone=(self), camera=(), payment=(), usb=()",
  });
  next();
}

function setReactPageCsp(res) {
  res.set("Content-Security-Policy", REACT_CSP);
}

module.exports = { REACT_CSP, basicSecurityHeaders, setReactPageCsp };
