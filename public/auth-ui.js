// SANJEEVNI - shared sign-in UI for the protected pages (dashboard and
// officer page). Load it BEFORE the page's own scripts:
//   <script src="/auth-ui.js"></script>
//   <div id="sjUserChip"></div>   (where the "signed in as" chip goes)
//
// - Shows who is signed in, their role, and a Log out button.
// - If any API call comes back 401 (session expired / signed out
//   elsewhere), sends the user to the login page and back here after.
(function () {
  const loginUrl = (reason) =>
    `/login.html?next=${encodeURIComponent(location.pathname + location.search)}${reason ? `&${reason}=1` : ""}`;

  let redirecting = false;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const response = await nativeFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (response.status === 401 && url.origin === location.origin &&
        url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/") && !redirecting) {
      redirecting = true;
      location.replace(loginUrl("expired"));
    }
    return response;
  };

  const style = document.createElement("style");
  style.textContent = `
    .sj-chip { display:inline-flex; align-items:center; gap:10px; background:rgba(255,255,255,.14);
      border:1px solid rgba(255,255,255,.35); color:#fff; border-radius:999px; padding:5px 6px 5px 12px;
      font:13px Arial, sans-serif; }
    .sj-chip.on-light { background:#f1f8f2; border-color:#cfe3d1; color:#1b1b1b; }
    .sj-chip .sj-role { font-size:11px; font-weight:bold; text-transform:uppercase; letter-spacing:.4px;
      padding:2px 7px; border-radius:999px; background:rgba(255,255,255,.25); }
    .sj-chip.on-light .sj-role { background:#e0efe2; color:#1b5e20; }
    .sj-chip button { border:none; border-radius:999px; padding:6px 11px; font-weight:bold; font-size:12.5px;
      cursor:pointer; background:#fff; color:#1b5e20; }
    .sj-chip.on-light button { background:#2e7d32; color:#fff; }
    .sj-chip button:hover { filter:brightness(.93); }
    .sj-toast { position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:3000;
      background:#1b1b1b; color:#fff; padding:10px 16px; border-radius:10px; font:14px Arial, sans-serif;
      box-shadow:0 6px 20px rgba(0,0,0,.25); }
  `;
  document.head.appendChild(style);

  function toast(text) {
    const el = document.createElement("div");
    el.className = "sj-toast";
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  async function logout() {
    try {
      await nativeFetch("/api/auth/logout", { method: "POST" });
    } finally {
      location.replace("/login.html?loggedout=1");
    }
  }

  async function renderChip() {
    const slot = document.getElementById("sjUserChip");
    let me;
    try {
      const res = await nativeFetch("/api/auth/me");
      if (res.status === 401) return location.replace(loginUrl("expired"));
      me = await res.json();
    } catch {
      return; // server unreachable - the page shows its own connection error
    }
    if (!slot || !me.user) return;
    const chip = document.createElement("div");
    chip.className = "sj-chip" + (slot.dataset.theme === "light" ? " on-light" : "");
    const name = document.createElement("span");
    name.textContent = me.user.username; // textContent: never parsed as HTML
    const role = document.createElement("span");
    role.className = "sj-role";
    role.textContent = me.user.role;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Log out";
    btn.addEventListener("click", logout);
    chip.append(name, role, btn);
    slot.replaceChildren(chip);
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderChip();
    if (new URLSearchParams(location.search).get("denied") === "officer") {
      toast("Your account can view the dashboard only - the officer page needs an officer account.");
    }
  });
})();
