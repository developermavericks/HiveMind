// HiveMind dashboard — data quality, reading audit, forecast accuracy, user admin and the signed-in user menu.
// Loaded after extra.js and before app.js. Uses app.js globals (S, api, post, esc, $, $$, toast, n0, dt, xModal, info…) only when called.
// Every endpoint is optional: a missing one shows a friendly empty state.

// ---------------------------------------------------------------- opportunity chips (pairing fit, data flags, hold reason)
const fitChip = (o) => {
  const f = o?.fit;
  if (!f) return "";
  return f.mode === "judged"
    ? `<span class="pill p-ok" title="The model judged this sector for this specific topic${f.relevance != null ? ` (relevance ${Number(f.relevance).toFixed(2)})` : ""}">Pairing judged for this topic</span>`
    : `<span class="pill p-muted" title="The sector link comes from the topic's broader area and has not been judged for this topic yet">Pairing inherited: hypothesis</span>`;
};
const flagChips = (o) => (o?.dataFlags ?? []).map((x) => `<span class="pill p-medium">${esc(x)}</span>`).join("");
const holdNotice = (o) => (o?.holdReason ? `<div class="hold"><b>Held back from “write now”.</b> ${esc(o.holdReason)}</div>` : "");

// ---------------------------------------------------------------- data quality
const Q_WORD = { green: "Data looks healthy", amber: "Some checks need attention", red: "Data quality is below the safe threshold; write now is held back" };
const qDot = (s) => `<span class="sd ${esc(s || "green")}" title="${esc(s || "")}"></span>`;
// A check's value is shown as given, in its own unit (a percentage unit means the number is already a percentage).
const qVal = (c) => {
  if (c.value == null) return "–";
  const v = typeof c.value === "number" ? (Number.isInteger(c.value) ? n0(c.value) : c.value.toFixed(1)) : c.value;
  return `${v}${c.unit ? (c.unit === "%" ? "%" : ` ${c.unit}`) : ""}`;
};
async function pgQuality(el) {
  const q = await api("/api/quality").catch(() => null);
  if (!q || q.error) { el.innerHTML = `<div class="empty"><h3>Data quality is not available yet</h3><p>It appears once the first collection has finished.</p></div>`; return; }
  const checks = q.checks ?? [], silent = (q.sources ?? []).filter((s) => s.silent), dup = q.duplicates ?? {};
  const dupPct = dup.rate == null ? "–" : `${(dup.rate <= 1 ? dup.rate * 100 : dup.rate).toFixed(1)}%`;
  el.innerHTML = `
    <div class="qbanner ${esc(q.status || "green")}"><span class="sd ${esc(q.status || "green")} big"></span><div><b>${esc(Q_WORD[q.status] ?? "Data quality")}</b><div class="small mute">${q.generatedAt ? `Checked ${esc(dt(q.generatedAt))}. ` : ""}These checks run on every refresh. When the status is red, “write now” is held back until the data recovers.</div></div></div>
    <section class="card" style="margin-top:16px"><div class="sec-h" style="margin:0 0 6px"><div><h2 style="font-size:15px">Checks${info("quality")}</h2><p>Each check compares a number with the limit it should stay within.</p></div></div>
      <div class="tw" style="max-height:none"><table class="t"><thead><tr><th></th><th>Check</th><th class="r">Now</th><th class="r">Limit</th><th>What it means</th></tr></thead><tbody>
      ${checks.length ? checks.map((c) => `<tr><td style="width:26px">${qDot(c.status)}</td><td class="b">${esc(c.label)}</td><td class="r num">${esc(qVal(c))}</td><td class="r num mute">${c.limit == null ? "–" : esc(String(c.limit))}</td><td class="small mute">${esc(c.detail ?? "")}</td></tr>`).join("") : `<tr><td colspan="5" class="mute">No checks reported.</td></tr>`}
      </tbody></table></div></section>
    <div class="grid g2" style="margin-top:16px">
      <section class="card"><h3>Source activity</h3><p class="hint">A source that has gone quiet for much longer than usual is flagged, so a gap is not mistaken for a quiet news day.</p>
        ${(q.sources ?? []).length ? `<div class="tw" style="max-height:340px"><table class="t"><thead><tr><th>Source</th><th>Last story</th><th class="r">Quiet for</th><th class="r">Usual gap</th><th></th></tr></thead><tbody>${[...(q.sources ?? [])].sort((a, b) => (b.silent ? 1 : 0) - (a.silent ? 1 : 0) || (b.hoursSilent ?? 0) - (a.hoursSilent ?? 0)).map((s) => `<tr><td class="b">${esc(s.name)}</td><td class="small">${s.lastSeen ? esc(dt(s.lastSeen)) : "–"}</td><td class="r num">${s.hoursSilent == null ? "–" : `${s.hoursSilent.toFixed(1)} h`}</td><td class="r num mute">${s.typicalGapHours == null ? "–" : `${s.typicalGapHours.toFixed(1)} h`}</td><td>${s.silent ? `<span class="pill p-bad">silent</span>` : `<span class="pill p-ok">active</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="mute small">No source data yet.</p>`}
        ${silent.length ? `<p class="small" style="margin:10px 0 0"><b>${silent.length}</b> source${silent.length > 1 ? "s are" : " is"} silent right now: ${silent.map((s) => esc(s.name)).join(", ")}.</p>` : ""}
      </section>
      <section class="card"><h3>Outlets we could not place</h3><p class="hint">An outlet missing from the ownership list counts as its own independent origin, which can overstate confirmation. Add these to the source list.</p>
        ${(q.unknownOutlets ?? []).length ? `<div class="tw" style="max-height:340px"><table class="t"><thead><tr><th>Outlet name</th><th class="r">Headlines</th></tr></thead><tbody>${q.unknownOutlets.map((u) => `<tr><td class="b">${esc(u.name)}</td><td class="r num">${n0(u.count)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="mute small">Every outlet seen is in the ownership list.</p>`}
      </section>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <section class="card"><h3>Duplicate stories</h3><p class="hint">The same event counted twice inflates its coverage. Likely duplicates are merged in the analysis; nothing is deleted.</p>
        <div class="kpis" style="margin:8px 0"><div class="kpi"><div class="v num">${dupPct}</div><div class="l">Duplicate rate</div></div><div class="kpi"><div class="v num">${n0(dup.pairs ?? 0)}</div><div class="l">Likely pairs found</div></div></div>
        ${(dup.sample ?? []).length ? `<div class="small mute b" style="margin-bottom:4px">EXAMPLES</div>${dup.sample.slice(0, 6).map((p) => `<div class="small" style="padding:5px 0;border-top:1px solid var(--line)">${esc(p.a)}<br><span class="mute">≈ ${esc(p.b)}</span></div>`).join("")}` : ""}
      </section>
      <section class="card"><h3>Topics to review</h3><p class="hint">Topics whose stories are spread across unrelated areas. They stay visible in Trends but are not paired with a sector.</p>
        ${(q.topicsToReview ?? []).length ? `<div class="tw" style="max-height:340px"><table class="t"><thead><tr><th>Topic</th><th class="r">Stories</th><th class="r">Fit with main area</th></tr></thead><tbody>${q.topicsToReview.map((t) => `<tr class="click" data-topic="${esc(t.key)}"><td class="b">${esc(t.name)}</td><td class="r num">${n0(t.count)}</td><td class="r num">${t.parentShare == null ? "–" : Math.round((t.parentShare <= 1 ? t.parentShare * 100 : t.parentShare))}%</td></tr>`).join("")}</tbody></table></div>` : `<p class="mute small">No topics flagged.</p>`}
      </section>
    </div>`;
  if (typeof bindTopicRows === "function") bindTopicRows(el);
}

// ---------------------------------------------------------------- reading audit (human spot-check + second opinion)
const auditPct = (v) => (v == null ? "–" : `${Math.round((v <= 1 ? v * 100 : v))}%`);
function auditStats(st) {
  if (!st) return "";
  const target = st.target ?? 0.9, acc = st.accuracy;
  return `<div class="kpis" style="margin:0 0 14px">
    <div class="kpi"><div class="v num">${n0(st.reviewed ?? 0)}</div><div class="l">Stories reviewed</div><div class="s">${n0(st.correct ?? 0)} correct · ${n0(st.wrong ?? 0)} wrong · ${n0(st.unsure ?? 0)} unsure</div></div>
    <div class="kpi"><div class="v num">${auditPct(acc)}</div><div class="l">Reading accuracy${info("audit")}</div><div class="s">target ${auditPct(target)}</div></div>
    <div class="kpi"><div class="v num">${n0(S.audit.items.length)}</div><div class="l">Left in this queue</div><div class="s">a fresh sample is drawn each week</div></div></div>`;
}
const impactLine = (i) => `<span class="tag" title="${esc(i.area || "")}">${esc(i.group)} <span class="mute">·</span> ${esc(i.direction)} <span class="mute">·</span> ${Number(i.severity ?? 0).toFixed(1)}${i.bracket ? ` <span class="mute">·</span> ${esc(i.bracket)}` : ""}</span>`;
function auditCard() {
  const it = S.audit.items[S.audit.i];
  if (!it) return `<div class="empty"><h3>Nothing left to review</h3><p>You have reviewed the whole sample. A fresh one is drawn automatically.</p></div>`;
  return `<section class="card audit-card"><div class="small mute b" style="letter-spacing:.06em">STORY ${S.audit.i + 1} OF ${S.audit.items.length}${it.reason ? ` · ${esc(String(it.reason).replace(/-/g, " ").toUpperCase())}` : ""}</div>
    <h3 style="font-size:19px;margin:6px 0 4px"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
    <p class="small" style="margin:0 0 10px">${esc(it.summary || "No summary was written.")}</p>
    <div class="small mute b">WHAT THE SYSTEM READ</div>
    <div class="chips" style="margin:6px 0">${(it.impacts ?? []).length ? it.impacts.map(impactLine).join("") : `<span class="mute small">No real-world impact recorded</span>`}</div>
    <div class="chips" style="margin:6px 0">${it.sentiment ? `<span class="tag">tone: ${esc(it.sentiment)}</span>` : ""}${it.stance ? `<span class="tag">stance: ${esc(it.stance)}</span>` : ""}${(it.topics ?? []).map((t) => `<span class="tag">topic: ${esc(t)}</span>`).join("")}${it.origins != null ? `<span class="tag">${n0(it.origins)} origin${it.origins === 1 ? "" : "s"}</span>` : ""}</div>
    <p class="small mute" style="margin:10px 0 6px">Does the reading above fairly describe the headline? Judge who is affected, how seriously and the tone.</p>
    <div class="ctl" style="margin-top:6px"><input type="text" id="aud-note" class="f" placeholder="Optional note" style="flex:1;min-width:200px">
      <button class="btn good" data-v="correct">Correct <span class="kbd">1</span></button><button class="btn bad" data-v="wrong">Wrong <span class="kbd">2</span></button><button class="btn ghost" data-v="unsure">Unsure <span class="kbd">3</span></button></div></section>`;
}
async function pgAudit(el) {
  S.audit ??= { items: [], stats: null, i: 0 };
  const [qd, so] = await Promise.all([api("/api/audit/queue?limit=50").catch(() => null), api("/api/audit/second-opinion").catch(() => null)]);
  if (!qd) { el.innerHTML = `<div class="empty"><h3>The audit queue is not available yet</h3><p>It needs the server to be running the latest version.</p></div>`; return; }
  if (S.audit.sig !== (qd.items ?? []).map((x) => x.id).join(",")) { S.audit = { items: qd.items ?? [], stats: qd.stats, i: 0, sig: (qd.items ?? []).map((x) => x.id).join(",") }; }
  else S.audit.stats = qd.stats;
  const paint = () => {
    el.innerHTML = `<div class="sec-h"><div><h2>Reading audit${info("audit")}</h2><p>A weekly spot-check by a person. It is the only direct measure of how often the AI reading is right.</p></div></div>
      <div id="aud-stats">${auditStats(S.audit.stats)}</div><div id="aud-card">${auditCard()}</div>
      <section class="card" style="margin-top:16px"><div class="sec-h" style="margin:0 0 8px"><div><h3 style="margin:0">Second opinion</h3><p class="hint" style="margin:0">A stronger model re-reads the story behind each top opportunity and says whether it agrees with the first reading.</p></div><button class="btn ghost" id="so-run">Run second opinion</button></div>
        ${so && so.summary ? `<div class="kpis" style="margin:8px 0"><div class="kpi"><div class="v num">${n0(so.summary.checked ?? 0)}</div><div class="l">Checked</div><div class="s">${esc(so.summary.model ?? "")}</div></div><div class="kpi"><div class="v num">${n0(so.summary.agree ?? 0)}</div><div class="l">Agree</div></div><div class="kpi"><div class="v num">${n0(so.summary.disagree ?? 0)}</div><div class="l">Disagree</div></div></div>` : `<p class="mute small">No second opinions yet.</p>`}
        ${(so?.items ?? []).length ? `<div class="tw" style="max-height:320px"><table class="t"><thead><tr><th>Story</th><th>Result</th><th>Note</th></tr></thead><tbody>${so.items.map((x) => `<tr><td class="b">${esc(x.title)}</td><td>${x.agrees ? `<span class="pill p-ok">agrees</span>` : `<span class="pill p-bad">disagrees</span>`}</td><td class="small mute">${esc(x.note ?? "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
      </section>`;
    $$("#aud-card [data-v]", el).forEach((b) => (b.onclick = () => review(b.dataset.v)));
    const run = $("#so-run", el);
    if (run) run.onclick = async () => { run.disabled = true; try { await post("/api/job", { kind: "second-opinion" }); toast("Second opinion started; results appear here when it finishes"); } catch (e) { toast(e.message, 5000); run.disabled = false; } };
  };
  const review = async (verdict) => {
    const it = S.audit.items[S.audit.i];
    if (!it) return;
    const note = ($("#aud-note", el)?.value ?? "").slice(0, 300);
    try {
      const r = await post("/api/audit/review", { key: it.id, verdict, note });
      if (r.stats) S.audit.stats = r.stats;
      S.audit.items.splice(S.audit.i, 1);
      if (S.audit.i >= S.audit.items.length) S.audit.i = 0;
      $("#aud-stats", el).innerHTML = auditStats(S.audit.stats); $("#aud-card", el).innerHTML = auditCard();
      $$("#aud-card [data-v]", el).forEach((b) => (b.onclick = () => review(b.dataset.v)));
    } catch (e) { toast(e.message, 5000); }
  };
  paint();
  if (!S.audit.keys) {
    S.audit.keys = true;
    document.addEventListener("keydown", (e) => {
      if (S.page !== "accuracy" || S.tab !== "audit" || e.target.matches?.("input,textarea,select") || e.metaKey || e.ctrlKey) return;
      const v = { 1: "correct", 2: "wrong", 3: "unsure" }[e.key];
      const b = v && document.querySelector(`#aud-card [data-v="${v}"]`);
      if (b) b.click();
    });
  }
}

// ---------------------------------------------------------------- forecast accuracy (section on Accuracy → Validation)
async function xForecastAccuracy(box) {
  const f = await api("/api/forecast-accuracy").catch(() => null);
  if (!f) { box.innerHTML = ""; return; }
  const pr = (v) => (v == null ? "–" : `${Math.round((v <= 1 ? v * 100 : v))}%`), m = (v) => (v == null ? "–" : (v * 100).toFixed(2) + " pts");
  const target = f.target ?? 0.8;
  box.innerHTML = `<section class="card"><div class="sec-h" style="margin:0"><div><h2 style="font-size:15px">Forecast accuracy${info("forecastAcc")}</h2><p>Each forecast is compared with what actually happened. The 80% band should contain the real value about 80% of the time.</p></div></div>
    ${f.evaluated ? `<div class="kpis" style="margin:12px 0"><div class="kpi"><div class="v num">${pr(f.bandCoverage)}</div><div class="l">Band coverage</div><div class="s">target ${pr(target)}</div></div>
      <div class="kpi"><div class="v num">${m(f.maeModel)}</div><div class="l">Average error</div><div class="s">naive guess ${m(f.maeNaive)}</div></div>
      <div class="kpi"><div class="v num">${f.beatsNaive == null ? "–" : f.beatsNaive ? "Yes" : "Not yet"}</div><div class="l">Beats a naive guess</div><div class="s">${n0(f.evaluated)} forecasts judged</div></div></div>
      ${(f.byHorizon ?? []).length ? `<div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Looking ahead</th><th class="r">Forecasts</th><th class="r">Band coverage</th><th class="r">Model error</th><th class="r">Naive error</th></tr></thead><tbody>${f.byHorizon.map((h) => `<tr><td class="b">${esc(String(h.hours))} hours</td><td class="r num">${n0(h.n)}</td><td class="r num">${pr(h.coverage)}</td><td class="r num">${m(h.maeModel)}</td><td class="r num mute">${m(h.maeNaive)}</td></tr>`).join("")}</tbody></table></div>` : ""}`
      : `<div class="empty" style="margin-top:10px"><p style="margin:0">No forecast is old enough to judge yet. This needs more history.</p></div>`}
    ${f.note ? `<p class="small mute" style="margin:10px 0 0">${esc(f.note)}</p>` : ""}</section>`;
}

// ---------------------------------------------------------------- signed-in user: menu, sign out, change password
async function loadMe() {
  try { S.me = (await api("/api/auth/me")).user ?? null; } catch { S.me = null; }
  renderUserBox();
  const admin = S.me?.role === "admin";
  if (S.me && !admin) { const r = document.getElementById("runtoggle"); if (r) r.style.display = "none"; }
  document.documentElement.dataset.role = S.me?.role ?? "";
  if (S.me && !admin && typeof MEMBER_HIDDEN !== "undefined" && MEMBER_HIDDEN.has(S.page)) location.hash = "#/overview";
}
const isAdmin = () => !S.me || S.me.role === "admin"; // no auth configured (404) behaves like admin
function renderUserBox() {
  const el = document.getElementById("userbox");
  if (!el) return;
  if (!S.me) { el.innerHTML = ""; return; }
  const ini = (S.me.name || S.me.email || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  el.innerHTML = `<div class="ub"><span class="av">${esc(ini)}</span><div class="who"><b>${esc(S.me.name || S.me.email)}</b><span>${esc(S.me.role === "admin" ? "Administrator" : "Member")}</span></div>
    <button class="iconbtn sm" id="ub-menu" title="Account" aria-label="Account menu" aria-haspopup="true"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></button></div>
    <div class="um" id="um" style="display:none"><button id="um-pw">Change password</button><button id="um-out">Sign out</button></div>`;
  const menu = document.getElementById("um");
  document.getElementById("ub-menu").onclick = (e) => { e.stopPropagation(); menu.style.display = menu.style.display === "none" ? "" : "none"; };
  document.addEventListener("click", () => { menu.style.display = "none"; });
  document.getElementById("um-out").onclick = async () => { try { await post("/api/auth/logout", {}); } catch { /* already signed out */ } location.href = "/login"; };
  document.getElementById("um-pw").onclick = changePasswordDialog;
}
function changePasswordDialog() {
  const b = xModal("Change password", `<form id="pwf" class="stack-form" autocomplete="off">
    <label>Current password<input type="password" id="pw0" autocomplete="current-password" required></label>
    <label>New password<input type="password" id="pw1" autocomplete="new-password" minlength="10" required></label>
    <label>Repeat new password<input type="password" id="pw2" autocomplete="new-password" minlength="10" required></label>
    <p class="small mute" style="margin:0">At least 10 characters. You will stay signed in on this device.</p>
    <div id="pwe" class="small" style="color:var(--bad);min-height:18px"></div>
    <button class="btn" type="submit">Update password</button></form>`);
  b.querySelector("#pwf").onsubmit = async (e) => {
    e.preventDefault();
    const [a, n, r] = ["#pw0", "#pw1", "#pw2"].map((s) => b.querySelector(s).value);
    if (n !== r) { b.querySelector("#pwe").textContent = "The new passwords do not match."; return; }
    try { await post("/api/auth/password", { current: a, next: n }); toast("Password updated"); document.getElementById("modal").classList.remove("on"); }
    catch (err) { b.querySelector("#pwe").textContent = err.message; }
  };
}

// ---------------------------------------------------------------- user administration (admins only)
async function pgUsers(el) {
  if (!isAdmin()) { el.innerHTML = `<div class="empty"><h3>Only administrators can manage users</h3></div>`; return; }
  const d = await api("/api/users").catch((e) => ({ error: e.message }));
  if (d.error) { el.innerHTML = banner("bad", `<b>Could not load users.</b> ${esc(d.error)}`); return; }
  const users = d.users ?? [], pending = users.filter((u) => u.status === "pending"), rest = users.filter((u) => u.status !== "pending");
  const st = (s) => `<span class="pill ${s === "active" ? "p-ok" : s === "pending" ? "p-medium" : "p-muted"}">${esc(s)}</span>`;
  const row = (u) => `<tr><td class="b">${esc(u.name || "–")}<div class="small mute">${esc(u.email)}</div></td><td>${st(u.status)}</td><td>${esc(u.role)}</td><td class="small">${u.lastLoginAt ? esc(dt(u.lastLoginAt)) : "never"}</td><td class="r" style="white-space:nowrap">
    ${u.status === "pending" ? `<button class="btn sm" data-a="approve" data-id="${esc(String(u.id))}">Approve</button> ` : ""}
    ${u.status === "active" ? `<button class="btn ghost sm" data-a="${u.role === "admin" ? "member" : "admin"}" data-id="${esc(String(u.id))}">${u.role === "admin" ? "Make member" : "Make admin"}</button> <button class="btn ghost sm" data-a="reset" data-id="${esc(String(u.id))}">Reset password</button> ` : ""}
    ${u.status === "disabled" ? `<button class="btn ghost sm" data-a="enable" data-id="${esc(String(u.id))}">Enable</button> ` : u.status !== "pending" ? `<button class="btn ghost sm" data-a="disable" data-id="${esc(String(u.id))}">Disable</button>` : `<button class="btn ghost sm" data-a="disable" data-id="${esc(String(u.id))}">Decline</button>`}</td></tr>`;
  el.innerHTML = `<div class="sec-h"><div><h2>Users</h2><p>New accounts wait here until an administrator approves them. The first account is the administrator.</p></div></div>
    ${pending.length ? `<section class="card" style="border-color:var(--warn);margin-bottom:16px"><h3>Waiting for approval (${pending.length})</h3><div class="tw" style="max-height:none"><table class="t"><tbody>${pending.map(row).join("")}</tbody></table></div></section>` : ""}
    <section class="card"><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rest.map(row).join("") || `<tr><td colspan="5" class="mute">No other users.</td></tr>`}</tbody></table></div></section>`;
  $$("[data-a]", el).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a, id = b.dataset.id;
    if (a === "disable" && !confirm("Disable this account? They will be signed out and cannot sign in.")) return;
    b.disabled = true;
    try {
      if (a === "approve") await post("/api/users/approve", { id });
      else if (a === "admin" || a === "member") await post("/api/users/role", { id, role: a });
      else if (a === "disable") await post("/api/users/disable", { id });
      else if (a === "enable") await post("/api/users/enable", { id });
      else if (a === "reset") {
        const r = await post("/api/users/reset", { id });
        const m = xModal("Temporary password", `<p class="small">Give this to the person now. It is shown once; they should change it after signing in.</p><div class="code" id="tp" style="font-size:18px;padding:10px;user-select:all">${esc(r.temporaryPassword)}</div><div style="margin-top:12px"><button class="btn" id="tpc">Copy</button></div>`);
        m.querySelector("#tpc").onclick = () => { navigator.clipboard?.writeText(r.temporaryPassword); toast("Copied"); };
        return;
      }
      toast("Done"); render();
    } catch (e) { toast(e.message, 5000); b.disabled = false; }
  }));
}

// Small status chip linking to the data-quality tab (used in the Overview's Data confidence panel).
function qualityChip(q) {
  if (!q || !q.status) return "";
  const cls = { green: "p-ok", amber: "p-medium", red: "p-bad" }[q.status] ?? "p-muted", word = { green: "healthy", amber: "needs attention", red: "below threshold" }[q.status] ?? q.status;
  const flags = (q.flags ?? []).join(" · ");
  return `<a class="pill ${cls} dot" href="#/accuracy/quality" title="${esc(flags || "Open the data-quality checks")}" style="margin-left:6px;font-weight:600;text-decoration:none">Data quality: ${esc(word)}</a>`;
}
