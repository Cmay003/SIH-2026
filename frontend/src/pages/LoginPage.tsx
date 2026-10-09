import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { apiPost, ApiError } from "../api/client";
import type { LoginResponse } from "../api/types";
import { Logo } from "../components/Logo";
import { safeNext } from "../lib/navigation";
import styles from "./Login.module.css";

type Notice = { kind: "error" | "info"; text: string } | null;

function initialNotice(params: URLSearchParams): Notice {
  if (params.get("expired")) return { kind: "info", text: "Your session ended. Please sign in again." };
  if (params.get("loggedout")) return { kind: "info", text: "You have been signed out." };
  if (params.get("next")) return { kind: "info", text: "Please sign in to continue." };
  return null;
}

export function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [notice, setNotice] = useState<Notice>(() => initialNotice(params));
  const [invalid, setInvalid] = useState({ username: false, password: false });
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const name = username.trim();
    setInvalid({ username: !name, password: !password });
    if (!name || !password) {
      setNotice({ kind: "error", text: "Enter your username and password." });
      (name ? passwordRef : usernameRef).current?.focus();
      return;
    }
    setStatus("submitting");
    try {
      await apiPost<LoginResponse>("/api/auth/login", { username: name, password });
      setStatus("done");
      window.location.replace(safeNext(params.get("next")));
    } catch (err) {
      setStatus("idle");
      setNotice({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Can't reach the SANJEEVNI server. Check your connection and try again.",
      });
      setPassword("");
      setInvalid({ username: false, password: true });
      passwordRef.current?.focus();
    }
  }

  const onPasswordKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.("CapsLock") ?? false);

  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <div className={styles.logo}>
          <Logo size={52} decorative />
          <div>
            <h1>SANJEEVNI</h1>
            <small>Disaster monitoring &amp; response</small>
          </div>
        </div>
        <div className={styles.brandCopy}>
          <h2>Authorised staff access</h2>
          <p>Live sensor readings, hazard alerts and citizen SOS requests are restricted to disaster-management staff.</p>
          <ul className={styles.points}>
            <li>Real-time hazard map and alerts</li>
            <li>Citizen SOS queue and routing</li>
            <li>Sensor node health monitoring</li>
          </ul>
        </div>
        <div className={styles.brandFoot}>Smart India Hackathon 2026 · Team V.A.S.H.I.K.A.R.A.N</div>
      </aside>

      <main className={styles.formSide}>
        <div className={styles.card}>
          <h2>Sign in</h2>
          <p className={styles.sub}>Use the account issued to you by your SANJEEVNI administrator.</p>

          <div role="alert" aria-live="assertive">
            {notice && <div className={`${styles.notice} ${styles[notice.kind]}`}>{notice.text}</div>}
          </div>

          <form onSubmit={onSubmit} noValidate>
            <div className={styles.field}>
              <label htmlFor="username">Username</label>
              <input id="username" ref={usernameRef} type="text" autoComplete="username" autoCapitalize="none"
                     spellCheck={false} autoFocus required value={username} aria-invalid={invalid.username}
                     onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label htmlFor="password">Password</label>
              <div className={styles.inputWrap}>
                <input id="password" ref={passwordRef} type={showPassword ? "text" : "password"}
                       autoComplete="current-password" required value={password} aria-invalid={invalid.password}
                       aria-describedby={capsLock ? "caps-lock" : undefined}
                       onChange={(e) => setPassword(e.target.value)} onKeyUp={onPasswordKey} onKeyDown={onPasswordKey} />
                <button type="button" className={styles.togglePw} aria-controls="password"
                        onClick={() => { setShowPassword((v) => !v); passwordRef.current?.focus(); }}>
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
              {capsLock && <div id="caps-lock" className={styles.caps}>Caps Lock is on</div>}
            </div>
            <button type="submit" className={styles.submit} disabled={status !== "idle"}>
              {status === "submitting" && <span className={styles.spinner} aria-hidden="true" />}
              {status === "submitting" ? "Signing in..." : status === "done" ? "Signed in" : "Sign in"}
            </button>
          </form>

          <p className={styles.help}>Forgot your password or locked out? Ask your administrator to reset it.</p>

          <div className={styles.sosLink}>
            <span>Citizen needing help?</span>
            <a href="/sos.html">Open SOS page →</a>
          </div>
        </div>
      </main>
    </div>
  );
}
