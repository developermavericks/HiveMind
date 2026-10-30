// Sign-in page logic. No inline script (the page's Content-Security-Policy forbids it). Talks only to /api/auth/*.
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("form"), msg = $("msg"), submit = $("submit"), tabs = $("tabs"), pw = $("password"), eye = $("eye");
  let mode = "signin", setup = false, busy = false;

  // The intro video plays once with the card hidden, then the card fades in over its last frame. A reload plays it again. The card appears at once for reduced
  // motion or Data Saver, if the video cannot be loaded or autoplay is refused, and in any case a few seconds after the video should have ended.
  const bg = $("bg"), START = 0.6;
  let shown = false;
  const reveal = () => { if (shown) return; shown = true; document.body.classList.remove("intro"); document.body.classList.add("after"); };
  if (!bg) reveal();
  else {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.connection?.saveData;
    const off = () => { bg.pause?.(); bg.classList.add("off"); reveal(); };
    if (calm) off();
    else {
      bg.addEventListener("ended", reveal);
      bg.addEventListener("error", off);
      // The first 0.6 s of the clip is skipped (the #t=0.6 in the address does it; this covers a browser that ignores it).
      bg.addEventListener("loadedmetadata", () => { if (bg.currentTime < START) bg.currentTime = START; if (isFinite(bg.duration)) setTimeout(reveal, bg.duration * 1000 + 3000); });
      setTimeout(() => { if (bg.paused || bg.currentTime <= START) off(); }, 6000); // nothing has played after 6 s: do not keep people waiting
      bg.play?.().catch(off);
    }
  }

  const say = (text, ok = false) => { msg.textContent = text || ""; msg.hidden = !text; msg.classList.toggle("ok", !!ok); };
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-requested-with": "hivemind" }, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, data };
  };

  function render() {
    const up = mode === "signup";
    $("f-name").hidden = !up;
    $("meter").hidden = !up;
    pw.autocomplete = up ? "new-password" : "current-password";
    pw.placeholder = up ? "At least 10 characters" : "Your password";
    $("tab-in").setAttribute("aria-selected", String(!up)); $("tab-up").setAttribute("aria-selected", String(up));
    tabs.hidden = setup;
    if (setup) {
      $("title").textContent = "Create the administrator account";
      $("sub").textContent = "This is the first sign-in on this system. The account you create here manages everyone else.";
      submit.textContent = "Create administrator account"; $("foot").textContent = "You will use this email and password to sign in.";
    } else if (up) {
      $("title").textContent = "Request access";
      $("sub").textContent = "Create your account. An administrator approves it before you can sign in.";
      submit.textContent = "Create account"; $("foot").textContent = "Your request is reviewed by an administrator.";
    } else {
      $("title").textContent = "Welcome back";
      $("sub").textContent = "Sign in to see what the market is about to talk about.";
      submit.textContent = "Sign in"; $("foot").textContent = "Access is by invitation. New accounts are approved by an administrator.";
    }
    document.title = (setup ? "Set up" : up ? "Create account" : "Sign in") + " · HiveMind";
    say("");
  }

  function strength(v) {
    let s = 0;
    if (v.length >= 10) s++; if (v.length >= 14) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
    if (/\d/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    if (v.length < 10) s = Math.min(s, 1);
    return Math.min(4, s);
  }
  const LEVELS = [["8%", "var(--bad)", "Use at least 10 characters. A short phrase works well."], ["25%", "var(--bad)", "Too short or too simple."], ["50%", "#e0a100", "Getting there. Add length or a number."], ["75%", "#6fb436", "Good."], ["100%", "var(--ok)", "Strong."]];
  pw.addEventListener("input", () => {
    if (mode !== "signup" && !setup) return;
    const l = LEVELS[pw.value ? strength(pw.value) : 0];
    $("bar").style.width = pw.value ? l[0] : "0"; $("bar").style.background = l[1]; $("hint").textContent = pw.value ? l[2] : LEVELS[0][2];
  });

  eye.addEventListener("click", () => {
    const show = pw.type === "password";
    pw.type = show ? "text" : "password"; eye.textContent = show ? "Hide" : "Show";
    eye.setAttribute("aria-pressed", String(show)); eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b && !busy) { mode = b.dataset.mode; render(); } });

  async function login(email, password) {
    const r = await post("/api/auth/login", { email, password });
    if (r.ok) { location.replace("/"); return; }
    say(r.data.error || "Could not sign in. Please try again.");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const email = $("email").value.trim(), password = pw.value, name = $("name").value.trim();
    const up = mode === "signup" || setup;
    if (!email || !password) return say("Enter your email and password.");
    if (up && !name) return say("Enter your name.");
    busy = true; submit.disabled = true; say("");
    const label = submit.textContent; submit.textContent = "Please wait…";
    try {
      if (up) {
        const r = await post("/api/auth/signup", { name, email, password });
        if (!r.ok) say(r.data.error || "Could not create the account.");
        else if (r.data.first) { await login(email, password); }
        else { mode = "signin"; setup = false; render(); say("Request received. An administrator needs to approve your account before you can sign in.", true); pw.value = ""; }
      } else {
        await login(email, password);
      }
    } catch {
      say("Can't reach the server. Check your connection and try again.");
    } finally {
      busy = false; submit.disabled = false; if (submit.textContent === "Please wait…") submit.textContent = label;
    }
  });

  (async () => {
    try { const r = await fetch("/api/auth/state", { credentials: "same-origin" }); if (r.ok) setup = !!(await r.json()).setup; } catch { /* assume normal sign-in */ }
    if (setup) mode = "signup";
    render();
    $("email").focus();
  })();
})();
