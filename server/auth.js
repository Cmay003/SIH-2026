// =====================================================================
// SANJEEVNI - login + sessions for the dashboard and officer page.
//
// - Users live in SQLite (users table). Passwords are hashed with scrypt
//   (Node's built-in crypto, per-user random salt) - never stored plain.
// - Accounts are created with the CLI (node server/create_user.js add <name>):
//   there is NO default account or password.
// - Login sets an HttpOnly, SameSite=Strict session cookie (Secure over
//   HTTPS). Only a SHA-256 hash of the session token is stored, so a
//   leaked database doesn't hand out live sessions.
// - Sessions end after SESSION_IDLE_MINUTES without activity, or
//   SESSION_MAX_HOURS after login, whichever comes first.
// - Brute force: an account locks for LOCK_MINUTES after MAX_FAILED_LOGINS
//   wrong passwords; each IP gets at most IP_MAX_ATTEMPTS per window.
// - Roles: viewer (dashboard), officer (dashboard + officer page + SOS
//   actions), admin (same as officer; user management is CLI-only).
// =====================================================================
const crypto = require("crypto");

const SESSION_COOKIE = "sanjeevni_session";
const SESSION_IDLE_MINUTES = 60;
const SESSION_MAX_HOURS = 12; // about one duty shift
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const IP_MAX_ATTEMPTS = 20;
const IP_WINDOW_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 10;
const ROLES = ["viewer", "officer", "admin"];
const OFFICER_ROLES = new Set(["officer", "admin"]);
const ADMIN_ROLES = new Set(["admin"]); // node registry: changes what the AI trusts

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Async: scrypt takes ~50-100 ms, and the sync version blocked the whole
// Node event loop (ingestion, SOS) for every login attempt (review R24).
const scryptAsync = (password, salt, keylen, options) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(keyB64, "base64");
    const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Verified against when the username doesn't exist, so a login attempt
// takes the same time either way (no username probing by timing).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function initAuthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE COLLATE NOCASE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'officer',
      active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  // Optional mobile number for officer WhatsApp alerts (officer_alerts.js),
  // E.164 ("+919876543210"). Set with create_user.js add ... --phone /
  // set-phone. Only officer/admin accounts are ever messaged.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "phone")) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  }
}

// ---- phone numbers (officer WhatsApp alerts) ------------------------------
// E.164 = ITU-T Recommendation E.164, "The international public
// telecommunication numbering plan" (https://www.itu.int/rec/T-REC-E.164,
// page read 2026-10-09; in-force edition 02/2026). The 15-digit maximum
// (country code included) is the commonly cited E.164 limit; I could not
// open the full ITU text, so it is checked here only as a sanity bound.
// Stored and sent WITH the leading "+": Meta's Cloud API prepends the
// BUSINESS number's country code to a number without it, which can reach
// the wrong person (developers.facebook.com/docs/whatsapp/cloud-api/
// reference/phone-numbers, read 2026-10-09).
// Spaces, hyphens, dots and brackets are accepted on input and removed.
// Minimum 8 digits is my own sanity bound, not from the standard.
const E164 = /^\+[1-9]\d{7,14}$/;

/** "+91 98765-43210" -> "+919876543210", or null when it is not an E.164 number. */
function normalizePhone(input) {
  if (typeof input !== "string") return null;
  const compact = input.trim().replace(/[\s().-]/g, "");
  return E164.test(compact) ? compact : null;
}

/** "+919876543210" -> "+91******3210" for logs and lists (never the full number). */
function maskPhone(phone) {
  if (typeof phone !== "string" || phone.length < 7) return phone ? "***" : "";
  return phone.slice(0, 3) + "*".repeat(phone.length - 7) + phone.slice(-4);
}

// A redirect target on THIS site only - otherwise ?next= could bounce a
// user to a phishing page right after signing in. Browsers treat "//host"
// and "/\host" as other sites, and silently DROP tabs/newlines, so
// "/<tab>/evil" becomes "//evil" (review R16). So: no control characters
// or backslashes at all, then resolve it as a URL and require our host.
function isSafeLocalPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  try {
    return new URL(path, "http://local.invalid").host === "local.invalid";
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A malformed cookie from some other app on this host used to throw
      // here and turn every page into a 500 (review R14) - ignore it.
    }
  }
  return out;
}

// Equal-length, constant-time comparison of two strings of any content.
// (Comparing raw Buffers threw RangeError for a same-length key with
// non-ASCII characters - review R17.)
function safeEqualStrings(a, b) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function setupAuth(app, db, { officerApiKey }) {
  initAuthTables(db);

  const q = {
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    recordFailure: db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?"),
    recordSuccess: db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?"),
    insertSession: db.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ),
    sessionWithUser: db.prepare(`
      SELECT s.token_hash, s.last_seen_at, s.expires_at, u.id AS user_id, u.username, u.role, u.active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
    `),
    touchSession: db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteExpired: db.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?"),
  };

  const ipAttempts = new Map(); // ip -> { count, windowStart }

  function ipLimited(ip) {
    const now = Date.now();
    if (ipAttempts.size > 5000) {
      // Drop expired windows so the map can't grow forever (review R25)
      for (const [key, e] of ipAttempts) {
        if (now - e.windowStart > IP_WINDOW_MINUTES * 60000) ipAttempts.delete(key);
      }
    }
    const entry = ipAttempts.get(ip);
    if (!entry || now - entry.windowStart > IP_WINDOW_MINUTES * 60000) {
      ipAttempts.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > IP_MAX_ATTEMPTS;
  }

  function cookieFlags(req, maxAgeSeconds) {
    const secure = req.secure ? "; Secure" : "";
    return `; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = q.sessionWithUser.get(tokenHash);
    if (!row) return null;
    const now = Date.now();
    const idleExpired = now - new Date(row.last_seen_at).getTime() > SESSION_IDLE_MINUTES * 60000;
    if (!row.active || idleExpired || now > new Date(row.expires_at).getTime()) {
      q.deleteSession.run(tokenHash);
      return null;
    }
    // Refresh the idle timer at most once a minute (not on every 5 s poll)
    if (now - new Date(row.last_seen_at).getTime() > 60000) {
      q.touchSession.run(new Date(now).toISOString(), tokenHash);
    }
    return { tokenHash, user: { id: row.user_id, username: row.username, role: row.role } };
  }

  // State-changing requests made with the session cookie must come from
  // our own pages. SameSite=Strict already blocks most cross-site use;
  // this Origin check is a second layer against CSRF.
  function sameOrigin(req) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin fetches from older browsers may omit it
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // ---- middleware -----------------------------------------------------
  // The ONLY 401 that means "your session ended". The pages send the user
  // to the login page just for this code, so a 401 that is about something
  // else (e.g. the AI backend rejecting the server's key) can't start a
  // redirect loop between a page and /login.html (B53).
  const LOGIN_REQUIRED = { error: "Login required", code: "login_required" };

  function requireLogin(req, res, next) {
    const session = currentSession(req);
    if (!session) return res.status(401).json(LOGIN_REQUIRED);
    if (!sameOrigin(req)) return res.status(403).json({ error: "Cross-site request blocked" });
    req.user = session.user;
    next();
  }

  // Officer actions: a logged-in officer/admin, OR the X-API-Key header
  // (kept for scripts, tests and admin tools - not for browsers).
  // Admin actions (requireAdmin): the same, but only the admin role.
  function requireRoles(roles, roleName) {
    return (req, res, next) => {
      const key = req.headers["x-api-key"];
      if (officerApiKey && typeof key === "string" && key && safeEqualStrings(key, officerApiKey)) {
        req.user = { username: "api-key", role: "admin" };
        return next();
      }
      const session = currentSession(req);
      if (!session) return res.status(401).json(LOGIN_REQUIRED);
      if (!roles.has(session.user.role)) return res.status(403).json({ error: `${roleName} role required` });
      if (!sameOrigin(req)) return res.status(403).json({ error: "Cross-site request blocked" });
      req.user = session.user;
      next();
    };
  }
  const requireOfficer = requireRoles(OFFICER_ROLES, "Officer");
  const requireAdmin = requireRoles(ADMIN_ROLES, "Admin");

  // HTML pages: redirect to the login page instead of returning JSON.
  // `denied` names what was refused, for the dashboard's explanation toast.
  function requirePage(roles, denied = "officer") {
    return (req, res, next) => {
      const session = currentSession(req);
      if (!session) {
        return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
      }
      if (roles && !roles.has(session.user.role)) {
        return res.redirect(`/?denied=${denied}`);
      }
      res.set("Cache-Control", "no-store"); // don't leave the page in a shared browser's cache
      req.user = session.user;
      next();
    };
  }

  // ---- routes -----------------------------------------------------------
  // One message for EVERY failed sign-in - unknown user, wrong password,
  // disabled or locked account. A separate "account locked" (HTTP 423)
  // told an attacker which usernames exist (review R13).
  const SIGN_IN_FAILED =
    "Sign-in failed: wrong username or password, or the account is temporarily locked after repeated failures. " +
    "Try again later or ask your administrator.";

  // Express 4 doesn't catch errors from async handlers, and on Node 22+ an
  // unhandled rejection kills the whole process - so failures become a 500.
  app.post("/api/auth/login", (req, res) => {
    login(req, res).catch((err) => {
      console.error("[auth] login error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Sign-in is temporarily unavailable." });
    });
  });

  async function login(req, res) {
    const { username, password } = req.body || {};
    if (ipLimited(req.ip)) {
      return res.status(429).json({ error: `Too many login attempts. Try again in ${IP_WINDOW_MINUTES} minutes.` });
    }
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return res.status(400).json({ error: "Enter your username and password." });
    }

    const found = q.userByName.get(username.trim());
    // Always run the (slow) hash check, so timing doesn't reveal anything either
    const passwordOk = await verifyPassword(password, found ? found.password_hash : DUMMY_HASH);
    // Decide from a FRESH copy of the row (B45). Parallel requests all read
    // the same failed_attempts before their scrypt finished, so 20 wrong
    // passwords at once counted as ONE failure and the lock never came.
    // DatabaseSync is synchronous and nothing awaits between this read and
    // the write below, so no other request can run in between. Re-checking
    // the lock here also stops a correct guess in the same burst from
    // signing in after the burst has locked the account.
    const user = found ? q.userByName.get(found.username) : null;
    const now = Date.now();
    const locked = !!(user && user.locked_until && new Date(user.locked_until).getTime() > now);
    if (!user || !user.active || locked || !passwordOk) {
      if (user && !locked && !passwordOk) {
        // A lock that has EXPIRED starts the count from zero again. Before,
        // the old count stayed at 5, so one wrong password every 15 min
        // kept an officer locked out indefinitely (review R12).
        const lockExpired = !!user.locked_until;
        const failures = (lockExpired ? 0 : user.failed_attempts) + 1;
        const lock = failures >= MAX_FAILED_LOGINS ? new Date(now + LOCK_MINUTES * 60000).toISOString() : null;
        q.recordFailure.run(failures, lock, user.id);
      }
      return res.status(401).json({ error: SIGN_IN_FAILED });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const at = new Date(now);
    q.deleteExpired.run(at.toISOString(), new Date(now - SESSION_IDLE_MINUTES * 60000).toISOString());
    q.insertSession.run(sha256(token), user.id, at.toISOString(), at.toISOString(),
      new Date(now + SESSION_MAX_HOURS * 3600000).toISOString());
    q.recordSuccess.run(at.toISOString(), user.id);
    res.set("Set-Cookie", `${SESSION_COOKIE}=${token}${cookieFlags(req, SESSION_MAX_HOURS * 3600)}`);
    res.json({ ok: true, user: { username: user.username, role: user.role } });
  }

  app.post("/api/auth/logout", (req, res) => {
    const session = currentSession(req);
    if (session) q.deleteSession.run(session.tokenHash);
    res.set("Set-Cookie", `${SESSION_COOKIE}=${cookieFlags(req, 0)}`);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: "Not logged in" });
    res.json({
      user: { username: session.user.username, role: session.user.role },
      idle_timeout_minutes: SESSION_IDLE_MINUTES,
    });
  });

  // Already logged in -> skip the login form
  app.get("/login.html", (req, res, next) => {
    if (currentSession(req)) {
      const nextUrl = String(req.query.next || "/");
      return res.redirect(isSafeLocalPath(nextUrl) ? nextUrl : "/");
    }
    next();
  });

  return { requireLogin, requireOfficer, requireAdmin, requirePage, OFFICER_ROLES, ADMIN_ROLES };
}

module.exports = {
  setupAuth, hashPassword, verifyPassword, passwordProblem, initAuthTables,
  ROLES, MIN_PASSWORD_LENGTH, normalizePhone, maskPhone, PHONE_ROLES: OFFICER_ROLES,
};
