// HiveMind dashboard — core: state, API helpers, router, top bar, Overview, Opportunities and the detail drawer.
// Other pages live in pages.js. All numbers come from the API; the page never computes scores itself.
const { esc, clip, spark, ring, hbars, heat, momentum, tip, fmtT, pct } = HC;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };

const S = {
  company: ls.get("company") || "bcg", date: null, page: "overview", status: null, cfg: null,
  gran: ls.get("gran") || "hour", level: "bracket", sel: null, compare: new Set(), show: { bars: true, share: true, avg: true, forecast: true },
  opp: { action: "all", stage: "all", q: "", group: true, sort: "score", dir: -1, page: 1, size: 25, trigger: false, xtrend: false, mode: "whitespace" }, oppByKey: new Map(), authors: [],
};
// Sidebar groups. Each group with several views shows them as tabs; old routes still work through LEGACY.
const PAGES = {
  overview: { name: "Overview", title: "Executive overview", sub: "What the news is doing, which topics are gaining attention, and what to write now", fn: (el) => pgOverview(el) },
  leadership: { name: "Leadership", title: "Leadership view", sub: "What is trending and why, what people are writing about it, and what nobody has written yet", fn: (el) => pgLeadership(el) },
  opportunities: { name: "Opportunities", title: "Opportunities", sub: "Ranked topic opportunities with score, evidence and suggested action", fn: (el) => pgOpportunities(el) },
  trends: { name: "Trends", title: "Trends", sub: "Coverage volume, share and forecast over time", tabs: [
    { k: "topics", t: "Topics", sub: "Specific recurring topics: coverage volume, share and forecast over time", fn: (el) => pgMomentum(el) },
    { k: "sectors", t: "Sectors", sub: "Broad news areas: coverage volume, share and forecast over time", fn: (el) => pgMomentum(el) },
    { k: "entities", t: "Entities", sub: "Organisations, places and people that stories are about", fn: (el) => pgEntities(el) },
    { k: "sentiment", t: "Sentiment", sub: "Positive and negative tone of coverage by sector and topic", fn: (el) => pgSentiment(el) },
    { k: "xtrends", t: "𝕏 Twitter Trends", sub: "Live Top 70 Twitter trends in India, automated 8-hour polling and editorial opportunity cross-matching", fn: (el) => pgXTrends(el) },
  ] },
  clients: { name: "Clients", title: "Clients", sub: "Company lenses and client management", tabs: [
    { k: "lens", t: "Company lens", sub: "How the news reaches each of the company's sectors", fn: (el) => pgSectors(el) },
    { k: "clients", t: "Clients", sub: "Create and switch client companies, manage sector lenses and run matching", fn: (el) => pgClients(el) },
  ] },
  sources: { name: "Sources", title: "Sources", sub: "Where the news comes from", tabs: [
    { k: "collection", t: "Sources & collection", sub: "Approved sources, independence of coverage and collection health", fn: (el) => pgSources(el) },
    // JOURNALISTS DISABLED: { k: "journalists", t: "Journalists", sub: "Journalist directory, best-fit journalists per opportunity and editor approval", fn: (el) => pgJournalists(el) },
    { k: "authored", t: "Authored articles", sub: "Opinion and analysis pieces from the print editions, the angles they take up, and the editor approval queue", fn: (el) => pgAuthored(el) },
  ] },
  accuracy: { name: "Accuracy", title: "Accuracy", sub: "Does the method predict topics that later gain attention?", tabs: [
    { k: "validation", t: "Validation", sub: "Live hit rate, weight tuning, forecast accuracy and the historical backtest", fn: (el) => pgAccuracy(el) },
    { k: "quality", t: "Data quality", sub: "Is the data behind today's numbers healthy?", fn: (el) => pgQuality(el) },
    { k: "audit", t: "Audit", sub: "A person spot-checks how the AI read the news", fn: (el) => pgAudit(el) },
    { k: "method", t: "Method", sub: "How every number is calculated and how this maps to the HiveMind concept", fn: (el) => pgMethod(el) },
  ] },
  guide: { name: "Guide", title: "Guide", sub: "What the numbers mean and how to use them", fn: (el) => (S.me && S.me.role !== "admin" ? pgGuideSimple(el) : pgGuide(el)) },
  support: { name: "Report Issue", title: "Support & Issue Tracking", sub: "Report an issue, request a feature, or raise questions to the administrator", fn: (el) => pgSupport(el) },
  settings: { name: "Settings", title: "Settings", sub: "Keys, system, run logs and usage", tabs: [
    { k: "integrations", t: "Integrations & keys", sub: "API keys, on/off switches and connection tests", fn: (el) => pgSettings(el) },
    { k: "system", t: "System", sub: "This machine, the local model and the LLM fallback", fn: (el) => pgSettings(el) },
    { k: "logs", t: "Run logs", sub: "Every automated and manual run, with what it collected and whether it worked", fn: (el) => pgLogs(el) },
    { k: "tickets", t: "Tickets & Support", admin: true, sub: "Review user tickets, bug reports, and requests", fn: (el) => pgAdminTickets(el) },
    { k: "audit-logs", t: "User Audit Trail", admin: true, sub: "Who used what, when, IP address, Wi-Fi / ISP, location, and errors", fn: (el) => pgAuditLogs(el) },
    { k: "usage", t: "Usage", sub: "API calls, tokens, balances and daily budgets", fn: (el) => pgUsage(el) },
    { k: "users", t: "Users & Client Scoping", admin: true, sub: "Who can sign in, client scoping, and permissions", fn: (el) => pgUsers(el) },
  ] },
};
const LEGACY = { momentum: "trends/topics", sectors: "clients/lens", company: "clients/lens", clients: "clients/clients", sources: "sources/collection", journalists: "sources/authored", validation: "accuracy/validation", method: "accuracy/method" };
const MEMBER_HIDDEN = new Set(["leadership", "clients", "sources", "accuracy", "settings"]); // pages a normal user does not see
const NAV_TOP = ["overview", "leadership", "opportunities", "trends", "clients", "sources", "accuracy"], NAV_BOTTOM = ["guide", "support", "settings"];
const NAV_ICON = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  leadership: '<path d="M4 20V9M10 20V4M16 20v-8M22 20H2"/>',
  opportunities: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  trends: '<path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/>',
  clients: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4"/>',
  sources: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  accuracy: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  guide: '<path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M8 8h6M8 12h6"/>',
  support: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
};
const curTab = () => { const g = PAGES[S.page]; return g.tabs ? g.tabs.find((t) => t.k === S.tab) ?? g.tabs[0] : null; };

// ---------------------------------------------------------------- helpers
const apiCache = new Map();
const API_CACHE_TTL = 30_000; // 30s cache for instantaneous tab switching and back-navigation

async function api(path, opts) {
  const isGet = !opts || !opts.method || opts.method === "GET";
  if (isGet && apiCache.has(path)) {
    const hit = apiCache.get(path);
    if (Date.now() - hit.ts < API_CACHE_TTL) {
      return hit.data;
    }
  }
  let r, j;
  // 503 + retry: a helper is still preparing this page (it never blocks the server); ask again a few times while the loader stays up.
  for (let tries = 0; ; tries++) {
    r = await fetch(path, opts);
    j = await r.json().catch(() => ({}));
    if (!(isGet && r.status === 503 && j.retry && tries < 12)) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (r.status === 401 && j.login) { location.href = j.login; throw new Error("Please sign in."); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  if (isGet) {
    apiCache.set(path, { data: j, ts: Date.now() });
    if (apiCache.size > 200) apiCache.delete(apiCache.keys().next().value);
  } else {
    apiCache.clear();
  }
  return j;
}
const post = (path, body) => { apiCache.clear(); return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); };
const qs = (extra = "") => `company=${encodeURIComponent(S.company)}${S.date ? `&date=${S.date}` : ""}${extra}`;
const n0 = (v) => (v == null ? "–" : Number(v).toLocaleString());
const x2 = (v) => (v == null ? "–" : `×${v.toFixed(2)}`);
const ago = (ms) => { const h = (Date.now() - ms) / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; };
const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dt = (ms) => new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function toast(msg, ms = 3200) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), ms); }
const actionLabel = (a) => {
  if (typeof isAdmin === "function" && isAdmin()) return a;
  const map = { "write now": "Act Now", "investigate": "Explore", "monitor": "Watchlist", "skip": "Low Priority" };
  return map[a] || a;
};
const actionPill = (a) => `<span class="pill ${a === "write now" ? "p-write" : "p-" + a}">${a === "write now" ? "● " : ""}${esc(actionLabel(a))}</span>`;
const stageLabel = (s) => {
  if (typeof isAdmin === "function" && isAdmin()) return s === "watch" ? "watchlist" : s;
  const map = { "rising": "Trending Up", "emerging": "New Trend", "steady": "Steady", "crowded": "Saturated", "declining": "Fading", "watch": "Watchlist" };
  return map[s] || s;
};
const stagePill = (s) => `<span class="pill p-${s} dot">${esc(stageLabel(s))}</span>`;
const evLabel = (e) => {
  if (typeof isAdmin === "function" && isAdmin()) return `evidence ${e.level}`;
  const map = { "high": "Verified (High)", "medium": "Moderate Confidence", "low": "Early Signal" };
  return map[e.level] || `evidence ${e.level}`;
};
const evPill = (e) => `<span class="pill p-${e.level}" title="${esc((e.reasons || []).join(" · "))}">${esc(evLabel(e))}</span>`;
const COMP = { momentum: "Momentum", acceleration: "Acceleration", sourceBreadth: "Independent sources", sectorEvidence: "Sector evidence", triggerTiming: "Trigger timing", headroom: "Editorial headroom" };
const STAGE_ORDER = ["emerging", "rising", "steady", "crowded", "declining", "watch"];
const STAGE_NAME = { emerging: "Emerging", rising: "Rising", steady: "Steady", crowded: "Crowded", declining: "Declining", watch: "Watchlist" };
// Loader: a spinner, a plain message and a seconds counter, so a slow first load (up to ~20 s while the server calculates) never looks broken.
const loading = () => `<div class="loadmsg" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span><div><b>Loading…</b><div class="small mute">Calculating the latest numbers. The first load after an update can take up to 20 seconds. <span class="loadsecs"></span></div></div></div><div class="grid g3"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`;
let loadTick = null;
function startLoadTimer() {
  clearInterval(loadTick);
  const t0 = Date.now();
  loadTick = setInterval(() => {
    const els = document.querySelectorAll(".loadsecs");
    if (!els.length) { clearInterval(loadTick); return; }
    const s = Math.round((Date.now() - t0) / 1000);
    els.forEach((e) => { e.textContent = s >= 2 ? `(${s} s)` : ""; });
  }, 1000);
}
const banner = (kind, html) => `<div class="banner ${kind}"><span>${kind === "bad" ? "⚠" : kind === "warn" ? "⚠" : "ⓘ"}</span><div>${html}</div></div>`;
const stack = (comp) => !isAdmin() ? "" : `<div class="stack">${Object.entries(comp).map(([k, c]) => `<i class="c-${k}" style="width:${c.points}%" title="${COMP[k]}${isAdmin() ? `: ${c.points.toFixed(1)} pts` : ""}"></i>`).join("")}</div>`;
const stackLegend = () => `<div class="legend">${Object.keys(COMP).map((k) => `<span><i class="c-${k}"></i>${COMP[k]}${typeof info === "function" ? info("c_" + k) : ""}</span>`).join("")}</div>`;

// ---------------------------------------------------------------- shell
function requestGeoLocation() {
  if (window.HIVEMIND_ENABLE_GEO && "geolocation" in navigator && !sessionStorage.getItem("geo_checked")) {
    sessionStorage.setItem("geo_checked", "1");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        post("/api/auth/geo", {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }).catch(() => {});
      },
      () => {
        sessionStorage.setItem("geo_checked", "denied");
      },
      { timeout: 10000, maximumAge: 300000, enableHighAccuracy: false }
    );
  }
}

function buildShell() {
  const link = (k) => `<a href="#/${k}" data-p="${k}"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[k]}</svg></span>${PAGES[k].name}</a>`;
  $("#nav").innerHTML = NAV_TOP.map(link).join("");
  $("#nav2").innerHTML = NAV_BOTTOM.map(link).join("");
  requestGeoLocation();
}
function renderTabs() {
  const g = PAGES[S.page], el = $("#tabs");
  if (!g.tabs) { el.classList.remove("on"); el.innerHTML = ""; return; }
  el.classList.add("on");
  el.innerHTML = `<nav class="tabs" aria-label="${esc(g.name)} sections">${g.tabs.filter((t) => !t.admin || isAdmin()).map((t) => `<a href="#/${S.page}/${t.k}" class="${t.k === S.tab ? "on" : ""}">${esc(t.t)}</a>`).join("")}</nav>`;
}
// ---- progress panel: every running job, with a bar, count, rate and time remaining ----
S.samples = {};
function rateOf(key, done) {
  const a = (S.samples[key] ??= []), now = Date.now();
  if (!a.length || a.at(-1)[1] !== done || now - a.at(-1)[0] > 4000) a.push([now, done]);
  while (a.length > 2 && now - a[0][0] > 120000) a.shift();
  if (a.length < 2) return null;
  const mins = (a.at(-1)[0] - a[0][0]) / 60000, d = a.at(-1)[1] - a[0][1];
  return mins > 0.05 && d > 0 ? d / mins : null;
}
const etaText = (left, perMin) => (perMin ? (left / perMin < 1 ? "under a minute left" : left / perMin < 90 ? `about ${Math.round(left / perMin)} min left` : `about ${(left / perMin / 60).toFixed(1)} h left`) : "estimating time left…");
function progressRow(key, title, done, total, note = "") {
  const pc = total ? Math.min(100, (100 * done) / total) : 0, rate = rateOf(key, done), left = Math.max(0, total - done);
  return `<div class="prow"><div class="ph"><b>${esc(title)}</b><span class="num">${n0(done)} / ${n0(total)} · ${pc.toFixed(pc < 10 ? 1 : 0)}%${rate ? ` · ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/min` : ""} · ${etaText(left, rate)}</span></div><div class="pbar"><i class="run" style="width:${Math.max(1.5, pc)}%"></i></div>${note ? `<div class="tiny mute">${note}</div>` : ""}</div>`;
}
function renderProgress(st) {
  const r = st.runner, live = st.live, el = $("#job"), rows = [];
  const col = r.running && r.total ? { done: r.done, total: r.total } : live;
  if (r.running || live) rows.push(col?.total ? progressRow("collect", `Collecting ${(r.running ? r.date : live?.date) ? fmtDay(r.running ? r.date : live.date) : "the latest news"} — stories read`, col.done, col.total) : `<div class="prow"><div class="ph"><b>Collecting</b><span>polling Google News…</span></div><div class="pbar"><i class="run ind"></i></div></div>`);
  const en = st.enrich;
  if (en.running) rows.push(progressRow("label", "Labelling topics", en.labelled, en.labelled + en.pending, "Adds topic labels, content type and causal pathways to stories already read; nothing is re-read."));
  // Every other background job: a bar where there is a count (sentiment), otherwise a moving bar with the elapsed time.
  const since = (t) => (t ? ` · running for ${Math.max(1, Math.round((Date.now() - t) / 1000))} s` : "");
  const live2 = (title, note, t) => `<div class="prow"><div class="ph"><b>${esc(title)}</b><span>${esc(note)}${since(t)}</span></div><div class="pbar"><i class="run ind"></i></div></div>`;
  const J = st.jobs ?? {};
  if (J.sentiment?.running && st.sentiment) {
    const base = (S.progressBase ??= {}).sentiment ??= st.sentiment.pending + 1;
    rows.push(progressRow("sentiment", "Labelling tone of coverage", Math.max(0, base - st.sentiment.pending), base, "Positive, negative or neutral, for stories already read."));
  }
  if (!J.sentiment?.running && S.progressBase) delete S.progressBase.sentiment;
  if (J["topic-merge"]?.running) rows.push(live2("Merging duplicate topics", "grouping topics that mean the same thing", J["topic-merge"].startedAt));
  if (J["entities-merge"]?.running) rows.push(live2("Merging entity names", "same company or person, different wording", J["entities-merge"].startedAt));
  if (J.fulltext?.running) rows.push(live2("Fetching article text", "second attempt at stories read from the headline", J.fulltext.startedAt));
  if (J.ocr?.running) rows.push(live2("Reading the print editions", "downloading, finding opinion and analysis pieces, matching them to angles", J.ocr.startedAt));
  const A = st.activity ?? {};
  if (A.topicVerify) rows.push(live2("Checking stories against their topics", "removing headlines that only mention the subject"));
  if (A.topicMatch) rows.push(live2("Judging topics for each client", "checking which sectors each rising topic really matters to"));
  if (A.secondOpinion) rows.push(live2("Second opinion", "a stronger model is double-checking readings"));
  if (A.hot) rows.push(live2("Checking hot topics", "wider web search and search interest"));
  const an = st.integrations?.find((i) => i.name === "anthropic");
  const recent = an?.state?.lastErrorAt && Date.now() - an.state.lastErrorAt < 5 * 60e3 && (!an.state.lastOkAt || an.state.lastErrorAt >= an.state.lastOkAt - 60000);
  const warn = rows.length && recent ? `<div class="pwarn">Claude requests are failing: ${esc(String(an.state.lastError ?? "").replace(/\s+/g, " ").slice(0, 140))}${st.fallbackActive ? " Using the local model instead." : st.chain?.includes("ollama") ? "" : " No local model is available as a fallback, so some stories will be retried on the next run."}</div>` : "";
  if (rows.length) { el.className = "progress"; el.innerHTML = rows.join("") + warn; el.style.display = ""; return; }
  // Results of finished runs live in the notification bell, not on the page. Only an urgent, ongoing problem stays here.
  const dry = st.integrations?.find((i) => i.health === "exhausted");
  if (dry) { el.className = "banner bad"; el.innerHTML = `<span>⚠</span><div><b>${esc(dry.label)} has run out of credit.</b> ${dry.name === "anthropic" && st.chain?.includes("ollama") ? "The local model is being used instead." : "Add credit or switch it off in <a href=\"#/settings/usage\">Settings</a>."}</div>`; el.style.display = ""; return; }
  el.style.display = "none";
}

function renderTop() {
  showSyncBox();
  const st = S.status, p = PAGES[S.page], tab = curTab();
  const isAdm = typeof isAdmin === "function" && isAdmin();
  const assignedCo = S.me?.company ? S.me.company.toUpperCase() : "BCG";
  $("#ttl").textContent = !isAdm && S.page === "overview" ? `HiveMind · ${assignedCo} Intelligence` : p.title;
  $("#sub").textContent = !isAdm && S.page === "overview" 
    ? `Real-time strategic priorities, verified news momentum, and executive briefs for ${assignedCo}.` 
    : (tab?.sub ?? p.sub);
  renderTabs();
  if (!st) return;

  // Client scoping: non-admins cannot switch to other clients
  if (!isAdm) {
    $("#csel").style.display = "none";
    let badge = $("#cbadge");
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "cbadge";
      badge.className = "pill p-write";
      badge.style.fontWeight = "600";
      badge.style.letterSpacing = "0.03em";
      $("#csel").parentNode.insertBefore(badge, $("#csel"));
    }
    badge.textContent = assignedCo;
    badge.title = `Your account is scoped strictly to ${assignedCo}. Client switching is restricted to administrators.`;
  } else {
    $("#csel").style.display = "";
    const badge = $("#cbadge");
    if (badge) badge.remove();
    const opts = st.companies.map((c) => `<option value="${esc(c.id)}"${c.id === S.company ? " selected" : ""}>${esc(c.name)}</option>`).join("");
    if ($("#csel").dataset.sig !== opts) { $("#csel").innerHTML = opts; $("#csel").dataset.sig = opts; }
    $("#csel").value = S.company;
  }

  const dopts = `<option value="">Live (latest data)</option>` + st.dates.map((d) => `<option value="${d.day}"${d.day === S.date ? " selected" : ""}>${fmtDay(d.day)} · ${n0(d.stories)}</option>`).join("");
  if ($("#dsel").dataset.sig !== dopts) { $("#dsel").innerHTML = dopts; $("#dsel").dataset.sig = dopts; }
  $("#dsel").value = S.date ?? "";

  if (!isAdm) {
    $("#llm").className = `pill p-ok dot`;
    $("#llm").textContent = "Intelligence Engine Ready";
    $("#llm").title = "Automated analysis active and verified";
    $("#llm").style.cursor = "default";
    $("#llm").onclick = null;
  } else {
    const prov = st.noClaude ? `Claude off · ${[st.models?.openai && "Luna", st.models?.groq && "Groq"].filter(Boolean).join(" + ") || "no model"}` : st.provider ? (st.provider === "anthropic" ? "Claude Haiku" : `Ollama (${st.llm?.message || "local"})`) : (st.llm.ok ? "LLM ready" : "LLM off");
    $("#llm").className = `pill ${st.llm.ok ? "p-ok" : "p-bad"} dot`;
    $("#llm").textContent = st.fallbackActive ? `${prov} [fallback]` : prov;
    $("#llm").title = `LLM Provider: ${st.provider || 'none'} · Click to manage in Settings`;
    $("#llm").style.cursor = "pointer";
    $("#llm").onclick = () => { location.hash = "#/settings"; };
  }

  renderProgress(st);
  $("#side-foot").innerHTML = `${st.schedule.minutes ? `Auto-collect every ${st.schedule.minutes} min${st.schedule.nextRunAt ? ` · next ~${new Date(Math.max(st.schedule.nextRunAt, Date.now())).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "Manual collection"}<br>${n0(st.recommendations)} recommendations logged`;
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.p === S.page));
  document.title = `HiveMind · ${tab ? tab.t : p.title}`;
}

async function loadStatus() {
  try {
    const prev = S.status;
    S.status = await api("/api/status");
    if (!S.status.companies.some((c) => c.id === S.company)) S.company = S.status.companies[0]?.id ?? "bcg";
    renderTop();
    if (S.me !== undefined && isAdmin()) loadNotifs(); // the bell is for administrators (not before we know who is signed in)
    const was = prev && busyNow(prev), now = busyNow(S.status);
    if (was && !now) { apiCache.clear(); render(); } // a job just finished
    else if (now && !document.activeElement?.matches("input,textarea,select") && !$("#drawer").classList.contains("on")) renderSoft();
  } catch (e) { $("#sub").textContent = "Cannot reach the server: " + e.message; }
  setTimeout(loadStatus, S.status && busyNow(S.status) ? 4000 : 10000);
}
// Is anything running in the background? (collection, labelling, any follow-up job, or in-process checks)
function busyNow(st) {
  return !!(st && (st.runner?.running || st.live || st.enrich?.running || Object.values(st.jobs ?? {}).some((j) => j.running) || Object.values(st.activity ?? {}).some(Boolean)));
}
let softAt = 0;
function renderSoft() { if (Date.now() - softAt > 60000 && !document.hidden && S.page === "overview" && !$("#drawer").classList.contains("on")) { softAt = Date.now(); render(); } }

// ---------------------------------------------------------------- router
async function route() {
  const [path, query = ""] = (location.hash.replace(/^#\//, "") || "overview").split("?");
  let [p, tab = null] = path.split("/");
  if (LEGACY[p] && !tab) [p, tab] = LEGACY[p].split("/"); // old links only; "sources/journalists" must keep its own tab
  S.page = PAGES[p] ? p : "overview";
  if (S.me && S.me.role !== "admin" && MEMBER_HIDDEN.has(S.page)) { S.page = "overview"; tab = null; history.replaceState(null, "", "#/overview"); }
  const g = PAGES[S.page];
  S.tab = g.tabs ? (g.tabs.some((t) => t.k === tab) ? tab : g.tabs[0].k) : null;
  if (S.page === "trends") S.level = S.tab === "sectors" ? "bracket" : "topic";
  const qp = new URLSearchParams(query);
  if (S.page === "opportunities" && (qp.has("action") || qp.has("trigger"))) { // deep links from the Overview cards
    Object.assign(S.opp, { action: qp.get("action") || "all", trigger: qp.get("trigger") === "1", stage: "all", q: "", page: 1 });
    history.replaceState(null, "", "#/opportunities");
  }
  window.scrollTo(0, 0);
  await render();
  const open = qp.get("open"); // deep link: #/opportunities?open=<opportunity key>
  if (open) { if (!S.oppByKey.has(open)) { const r = await api(`/api/opportunities?${qs(`&limit=300&group=pair&mode=${S.opp.mode}&slim=1`)}`); r.items.forEach((o) => S.oppByKey.set(o.key, o)); } openOpp(open); }
}
async function render() {
  renderTop();
  const el = $("#page"), page = S.page;
  const tab = curTab(), fn = tab ? tab.fn : PAGES[page].fn, sig = `${page}/${S.tab ?? ""}/${S.date ?? "live"}`;
  if (el.dataset.page !== sig) { el.innerHTML = loading(); el.dataset.page = sig; startLoadTimer(); }
  try { await fn(el); } catch (e) { if (S.page === page) el.innerHTML = banner("bad", `<b>Could not load this page.</b> ${esc(e.message)}`); }
}

// ---------------------------------------------------------------- Overview
async function pgOverview(el) {
  const [o, cfg] = await Promise.all([api(`/api/overview?${qs()}`), S.cfg ?? api("/api/config")]);
  S.cfg = cfg;
  if (o.empty) { el.innerHTML = `<div class="empty"><h3>No data yet</h3><p>Start a collection with the <b>Run</b> button above, or <span class="code">node src/cli.mjs run</span>.</p></div>`; return; }
  const k = o.kpis, h = o.history, st = S.status;
  const notes = [];
  if (S.date) notes.push(banner("info", `📅 <b>Viewing archive for ${fmtDay(S.date)}</b> · Showing news clusters, momentum and opportunities calculated for that day. <button class="btn sm ghost" style="margin-left:8px;padding:2px 8px;font-size:12px" onclick="$('#dsel').value='';$('#dsel').dispatchEvent(new Event('change'))">Return to Live</button>`));
  if (!st.llm.ok) notes.push(banner("warn", `<b>LLM is off.</b> ${esc(st.llm.message)} Briefs and new readings need it; everything already stored still works.`));
  if (o.stale) notes.push(banner("warn", `<b>Data is ${Math.round(o.dataAgeHours)} hours old.</b> Press Run to collect the latest stories; recent-window metrics describe the last collection, not now.`));
  const act = k.actions || {}, funnel = [
    ["Headlines polled (latest run)", k.headlines ?? 0], ["Distinct stories (clusters)", k.stories], ["Also read from article text", Math.round(k.fullTextPct * k.stories)],
    ["Topic-labelled stories", k.labelledStories], ["Opportunities scored", k.opportunities], ["Write now", act["write now"] || 0],
  ];
  const fmax = Math.max(...funnel.map((f) => f[1]), 1);
  const stg = o.stages.bracket, stTot = Object.values(stg).reduce((a, b) => a + b, 0) || 1;
  el.innerHTML = `${notes.join("")}
  <div class="kpis admin-only">
    <div class="kpi go" tabindex="0" role="link" data-go="#/sources"><div class="v num">${n0(k.stories)}</div><div class="l">${lbl("Stories analysed", "stories")}</div><div class="s">${k.days} days · ${n0(k.headlines)} headlines in the latest run</div></div>
    <div class="kpi go" tabindex="0" role="link" data-go="origins:all"><div class="v num">${n0(k.independentOrigins)}</div><div class="l">${lbl("Independent origins", "origins")}</div><div class="s">from ${n0(k.outletMentions)} outlet mentions (syndication removed)</div></div>
    <div class="kpi go" tabindex="0" role="link" data-go="#/sources"><div class="v num">${k.publications}</div><div class="l">${lbl("Approved sources", "sources")}</div><div class="s">newsrooms, trade press and primary sources</div></div>
    <div class="kpi go" tabindex="0" role="link" data-go="#/trends/topics"><div class="v num">${k.brackets}${k.topics ? ` + ${n0(k.topics)}` : ""}</div><div class="l">${lbl("Topics tracked", "topics")}</div><div class="s">${k.brackets} broad areas${k.topics ? ` + ${n0(k.topics)} specific` : ""}</div></div>
    <div class="kpi go" tabindex="0" role="link" data-go="#/opportunities?trigger=1"><div class="v num">${n0(k.verifiedTriggers)}</div><div class="l">${lbl("Verified triggers (72h)", "triggers")}</div><div class="s">primary source, or ≥ ${cfg.evidence.verifiedTriggerOrigins} independent origins</div></div>
    <div class="kpi accent go" tabindex="0" role="link" data-go="#/opportunities?action=write now"><div class="v num">${act["write now"] || 0}</div><div class="l">${lbl("Write now", "writeNow")}</div><div class="s"><a href="#/opportunities?action=investigate">${act.investigate || 0} investigate</a> · <a href="#/opportunities?action=monitor">${act.monitor || 0} monitor</a> · <a href="#/opportunities?action=skip">${act.skip || 0} skip</a></div></div>
  </div>

  <section><div class="sec-h"><div><h2>Today’s priorities for ${esc(o.company?.name ?? "")}${info("score")}</h2><p>One row per topic, best sector pairing shown. Click a row for evidence, score breakdown, momentum chart, author fit and brief.</p></div><a class="btn ghost sm" href="#/opportunities">All opportunities →</a></div>
    <div class="card flush">${o.topOpportunities.length ? o.topOpportunities.map(oppRow).join("") : `<div class="empty" style="margin:16px">No opportunity clears the monitoring threshold yet. ${o.company?.matched ? "" : "Sector matching for this company is still running."}</div>`}</div></section>

  <section class="grid g-7-5">
    <div class="card"><h3>Momentum leaders${info("risers")}</h3><p class="hint">Topics whose coverage share is growing fastest against baseline (last ${h.params.recentHours}h vs the preceding ${h.baselineHours}h). Needs ≥ ${cfg.evidence.minClusters} stories.</p>
      <div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Topic</th><th>Stage</th><th class="r">Momentum${info("momentum")}</th><th class="r">Share${info("share")}</th><th>Trend</th><th class="r">Origins${info("origins")}</th></tr></thead><tbody>
      ${o.risers.map((r) => `<tr class="click" data-topic="${esc(r.key)}"><td class="b">${esc(r.name)}</td><td>${stagePill(r.stage)}</td><td class="r num b">${x2(r.ratio)}</td><td class="r num">${pct(r.share)}</td><td>${spark(r.spark)}</td><td class="r num">${originsLink(r.originsRecent, r.key, r.name)}</td></tr>`).join("") || `<tr><td colspan="6" class="mute">No topic has enough stories yet.</td></tr>`}</tbody></table></div>
      ${o.topicRisers.length ? `<h3 style="margin-top:16px">Specific topics gaining attention</h3><div class="tw" style="max-height:none"><table class="t"><tbody>${o.topicRisers.map((r) => `<tr class="click" data-topic="${esc(r.key)}"><td class="b">${esc(r.name)} <span class="mute tiny">${esc(r.parentName ?? "")}</span></td><td>${stagePill(r.stage)}</td><td class="r num b">${x2(r.ratio)}</td><td>${spark(r.spark)}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>
    <div class="grid" style="align-content:start">
      <div class="card"><h3>Topic lifecycle${info("lifecycle")}</h3><p class="hint">Where the ${stTot} broad topics sit. Each stage follows a visible rule (see Method).</p>
        <div class="stage-bar">${STAGE_ORDER.filter((s) => stg[s]).map((s) => `<div class="sg-${s}" style="flex:${stg[s]}" title="${STAGE_NAME[s]}: ${stg[s]}">${stg[s]}</div>`).join("")}</div>
        <div class="legend">${STAGE_ORDER.map((s) => `<span><i class="st-dot sg-${s}"></i>${STAGE_NAME[s]} ${stg[s]}</span>`).join("")}</div></div>
      <div class="card admin-only"><h3>From headlines to decisions${info("funnel")}</h3><p class="hint">How many items survive each step.</p><div class="funnel">${funnel.map(([l, v]) => `<div class="fun"><span>${l}</span><div class="bar"><i style="width:${Math.max(2, (100 * v) / fmax)}%"></i></div><span class="num b" style="text-align:right">${n0(v)}</span></div>`).join("")}</div></div>
      <div class="card admin-only"><h3>Data confidence${info("confidence")} ${qualityChip(o.quality)}</h3><p class="hint">Why scores should be read with care. Stories are read from headlines and snippets to keep cost down; the evidence rules rely on independent origins instead.</p>
        <div class="compo"><span>Baseline depth</span><div class="bar"><i style="width:${Math.min(100, (100 * h.baselineHours) / cfg.intervals.baselineHours)}%"></i></div><span class="num">${h.baselineHours}h / ${cfg.intervals.baselineHours}h</span></div>
        <div class="compo"><span>Also read from article text</span><div class="bar"><i style="width:${100 * k.fullTextPct}%"></i></div><span class="num">${Math.round(100 * k.fullTextPct)}%</span></div>
        <div class="compo"><span>Timely collection</span><div class="bar"><i style="width:${100 * (1 - h.reconstructed / Math.max(1, k.stories))}%"></i></div><span class="num">${Math.round(100 * (1 - h.reconstructed / Math.max(1, k.stories)))}%</span></div>
        <p class="small mute" style="margin:8px 0 0">${o.outages.length ? `${o.outages.length} collection gap${o.outages.length > 1 ? "s" : ""} detected (hours with almost nothing collected). ` : "No collection gaps in the window. "}“Timely” = first seen within ${cfg.intervals.observedLagHours}h of publication; older stories are placed at their publication time.</p></div>
    </div>
  </section>`;
  bindOppRows(el); bindTopicRows(el);
}

// ---------------------------------------------------------------- opportunity rows (shared)
const alsoLine = (o) => (o.alsoCovers?.length ? `<div class="small mute" style="margin-top:4px">Also covers: ${o.alsoCovers.slice(0, 4).map((a) => esc(a.name)).join(", ")}${o.alsoCovers.length > 4 ? ` +${o.alsoCovers.length - 4}` : ""}</div>` : "");
function oppRow(o) {
  S.oppByKey.set(o.key, o);
  const m = o.metrics;
  return `<div class="opp" data-opp="${esc(o.key)}">
    <div>${ring(o.score)}</div>
    <div><div class="ttl">${esc(o.sector)} <span class="mute">×</span> ${esc(o.label.name)}${o.label.level === "topic" ? ` <span class="tag">specific topic</span>` : ""}${o.xTrending ? ` <span class="pill" style="background:#1d9bf0;color:#fff;font-size:10.5px;font-weight:700;letter-spacing:0.02em" title="Trending on X (${o.xTrending.region === 'worldwide' ? 'Worldwide' : 'India'}): Rank #${o.xTrending.rank} · ${esc(o.xTrending.name)}">𝕏 #${o.xTrending.rank} ${o.xTrending.region === 'worldwide' ? '🌐' : '🇮🇳'}</span>` : ""}</div>
      <div class="ang">${o.angle ? esc(clip(o.angle, 190)) : esc(clip(o.why, 190))}</div>${alsoLine(o)}
      <div class="meta">${actionPill(o.action)}${stagePill(o.stage)}${evPill(o.evidence)}<span class="tag">${x2(m.ratio)} ${typeof isAdmin === "function" && isAdmin() ? "momentum" : "above baseline"}</span><span class="tag">${pct(m.share)} ${typeof isAdmin === "function" && isAdmin() ? "share" : "of news"}</span><span class="tag">${originsLink(m.originsRecent, o.label.key, o.label.name)} ${typeof isAdmin === "function" && isAdmin() ? "origins" : "verified sources"}</span>${xSentChip(o.sentiment)}${fitChip(o)}${flagChips(o)}<span class="tag">${esc(o.window.label)}</span>${o.evidenceStatus === "hypothesis" ? `<span class="pill p-muted">hypothesis link</span>` : ""}${o.otherSectors?.length ? `<span class="tag">+${o.otherSectors.length} more sector${o.otherSectors.length > 1 ? "s" : ""}</span>` : ""}${o.brief ? `<span class="pill p-muted">brief: ${esc(o.brief.status.replace("_", " "))}</span>` : ""}</div></div>
    <div style="text-align:right">${spark(o.spark ?? [])}</div></div>`;
}
const bindOppRows = (el) => $$("[data-opp]", el).forEach((r) => (r.onclick = () => openOpp(r.dataset.opp)));
const bindTopicRows = (el) => $$("[data-topic]", el).forEach((r) => (r.onclick = () => { S.sel = r.dataset.topic; location.hash = r.dataset.topic.startsWith("t:") ? "#/trends/topics" : "#/trends/sectors"; }));

// ---------------------------------------------------------------- Opportunities page
// Other sectors a grouped row also fits (the API calls them otherSectors; moreSectors is accepted too).
const moreOf = (o) => o.moreSectors ?? o.otherSectors ?? [];
async function pgOpportunities(el) {
  const f = S.opp;
  const r = await api(`/api/opportunities?${qs(`&limit=1000&group=${f.group ? "topic" : "pair"}&mode=${f.mode}&slim=1`)}`);
  S.oppByKey = new Map(r.items.map((o) => [o.key, o]));
  if (r.empty || !r.items.length) { el.innerHTML = `<div class="empty">No opportunities yet. ${r.company?.matched ? "" : "Matching the news areas to this company’s sectors is still in progress, or no LLM is available."}</div>`; return; }
  const c = r.counts, open = new Set();
  const sub = { "write now": "all conditions met", investigate: "promising, evidence or verification missing", monitor: "watchlist / low score", skip: "declining, crowded or weak" }, tipk = { "write now": "writeNow", investigate: "investigate", monitor: "monitor", skip: "skip" };
  el.innerHTML = `<div class="kpis admin-only" style="margin-bottom:16px">${["write now", "investigate", "monitor", "skip"].map((a) => `<div class="kpi go ${a === "write now" ? "accent" : ""}" tabindex="0" role="button" data-act="${a}"><div class="v num">${c.action[a] || 0}</div><div class="l">${lbl(a[0].toUpperCase() + a.slice(1), tipk[a])}</div><div class="s">${sub[a]}</div></div>`).join("")}</div>
  <div class="card" style="margin-bottom:16px"><div class="ctl">
    <input type="text" id="oq" placeholder="Search sector, topic or angle…" value="${esc(f.q)}" style="max-width:280px">
    <div class="seg" id="oact">${["all", "write now", "investigate", "monitor", "skip"].map((a) => `<button data-a="${a}" class="${f.action === a ? "on" : ""}">${a === "all" ? "All" : a}</button>`).join("")}</div>
    <label>Stage <select id="ostage"><option value="all">All</option>${STAGE_ORDER.map((s) => `<option value="${s}"${f.stage === s ? " selected" : ""}>${STAGE_NAME[s]}</option>`).join("")}</select></label>
    <div class="seg" id="omode" title="Both views count the same opinion and analysis pieces from the print editions">${[["whitespace", "Nobody has written it"], ["validated", "Others have written it"]].map(([k, t]) => `<button data-m="${k}" class="${f.mode === k ? "on" : ""}">${t}</button>`).join("")}</div>
    <label class="chk"><input type="checkbox" id="ogroup" ${f.group ? "checked" : ""}> One row per topic</label>
    <label class="chk"><input type="checkbox" id="otrig" ${f.trigger ? "checked" : ""}> With a verified trigger</label>
    <label class="chk"><input type="checkbox" id="oxtrend" ${f.xtrend ? "checked" : ""}> 𝕏 Trending only</label>
    <span class="mute small" id="ocount"></span></div></div>
  <div class="card flush"><div class="tw" style="max-height:none"><table class="t" id="otab"><thead><tr><th>Score${info("score")}</th><th>Opportunity</th><th>Action</th><th>Stage</th><th class="r s" data-s="ratio">Momentum${info("momentum")}</th><th class="r s" data-s="share">Share${info("share")}</th><th class="r s" data-s="origins">Origins${info("origins")}</th><th>Evidence</th><th>Window</th></tr></thead><tbody></tbody></table></div><div id="opager"></div></div>
  <p class="small mute" style="margin-top:10px">Score (0–100) ranks opportunities; it is <b>not</b> a probability. Weights are pilot assumptions — see <a href="#/accuracy/method">Method</a>.</p>`;
  const rowHtml = (o) => {
    const more = moreOf(o), isOpen = open.has(o.key);
    return `<tr class="click" data-opp="${esc(o.key)}"><td>${ring(o.score, 44)}</td><td style="max-width:420px"><div class="b">${esc(o.sector)} <span class="mute">×</span> ${esc(o.label.name)} ${xSentChip(o.sentiment)}${fitChip(o)}${authChip(o)}${flagChips(o)}${o.xTrending ? `<span class="pill" style="background:#1d9bf0;color:#fff;font-size:10px;font-weight:700;margin-left:4px" title="Trending on X (${o.xTrending.region === 'worldwide' ? 'Worldwide' : 'India'}): Rank #${o.xTrending.rank} · ${esc(o.xTrending.name)}">𝕏 #${o.xTrending.rank} ${o.xTrending.region === 'worldwide' ? '🌐' : '🇮🇳'}</span>` : ""}</div><div class="small mute">${esc(clip(o.angle || o.why, 140))}</div>${alsoLine(o)}${more.length ? `<button type="button" class="chip" data-more="${esc(o.key)}" aria-expanded="${isOpen}" style="margin-top:4px">${isOpen ? "Hide" : `+${more.length} more sector${more.length > 1 ? "s" : ""}`}</button>` : ""}</td><td>${actionPill(o.action)}</td><td>${stagePill(o.stage)}</td><td class="r num b">${x2(o.metrics.ratio)}</td><td class="r num">${pct(o.metrics.share)}</td><td class="r num">${originsLink(o.metrics.originsRecent, o.label.key, o.label.name)}</td><td>${evPill(o.evidence)}</td><td class="small">${esc(o.window.label)}</td></tr>` +
      (isOpen ? `<tr class="sub"><td></td><td colspan="8"><div class="chips">${more.map((s) => `<span class="chip" ${s.key && S.oppByKey.has(s.key) ? `data-opp="${esc(s.key)}"` : ""}>${esc(s.sector)} <b class="num">${Math.round(s.score)}</b>${s.action ? ` ${actionPill(s.action)}` : ""}</span>`).join("")}</div></td></tr>` : "");
  };
  const draw = () => {
    let rows = r.items.filter((o) => (f.action === "all" || o.action === f.action) && (f.stage === "all" || o.stage === f.stage) && (!f.trigger || o.trigger?.verified) && (!f.xtrend || o.xTrending) && (!f.q || `${o.sector} ${o.label.name} ${o.angle} ${o.label.parentName}`.toLowerCase().includes(f.q.toLowerCase())));
    const key = { score: (o) => o.score, ratio: (o) => o.metrics.ratio ?? -1, share: (o) => o.metrics.share, origins: (o) => o.metrics.originsRecent }[f.sort];
    rows = rows.sort((a, b) => f.dir * (key(a) - key(b)));
    const pages = Math.max(1, Math.ceil(rows.length / f.size)); if (f.page > pages) f.page = pages;
    $("#ocount").textContent = `${n0(rows.length)} shown`;
    $("#otab tbody").innerHTML = rows.slice((f.page - 1) * f.size, f.page * f.size).map(rowHtml).join("") || `<tr><td colspan="9" class="mute" style="text-align:center;padding:22px">Nothing matches these filters.</td></tr>`;
    $("#opager").innerHTML = xPager(rows.length, f.page, f.size);
    bindOppRows($("#otab"));
    $$("[data-more]", $("#otab")).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); open.has(b.dataset.more) ? open.delete(b.dataset.more) : open.add(b.dataset.more); draw(); }));
    $$("#opager [data-pg]").forEach((b) => (b.onclick = () => { f.page = +b.dataset.pg; draw(); $("#otab").scrollIntoView({ block: "start", behavior: "smooth" }); }));
    const sz = $("#opager [data-size]"); if (sz) sz.onchange = () => { f.size = +sz.value; f.page = 1; draw(); };
  };
  const setAct = (a) => { f.action = a; f.page = 1; $$("#oact button").forEach((x) => x.classList.toggle("on", x.dataset.a === a)); draw(); };
  $("#oq").oninput = (e) => { f.q = e.target.value; f.page = 1; draw(); };
  $$("#oact button").forEach((b) => (b.onclick = () => setAct(b.dataset.a)));
  $$("[data-act]", el).forEach((k) => { const go = () => setAct(f.action === k.dataset.act ? "all" : k.dataset.act); k.onclick = (e) => { if (!e.target.closest("[data-info]")) go(); }; k.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } }; });
  $("#ostage").onchange = (e) => { f.stage = e.target.value; f.page = 1; draw(); };
  $$("#omode button").forEach((b) => (b.onclick = () => { f.mode = b.dataset.m; f.page = 1; render(); }));
  $("#ogroup").onchange = (e) => { f.group = e.target.checked; f.page = 1; render(); };
  $("#otrig").onchange = (e) => { f.trigger = e.target.checked; f.page = 1; draw(); };
  $("#oxtrend").onchange = (e) => { f.xtrend = e.target.checked; f.page = 1; draw(); };
  $$("#otab th.s").forEach((th) => (th.onclick = (e) => { if (e.target.closest("[data-info]")) return; f.dir = f.sort === th.dataset.s ? -f.dir : -1; f.sort = th.dataset.s; draw(); }));
  draw();
}

// ---------------------------------------------------------------- Opportunity drawer
const DRAWER_TIP = { "Coverage share": "share", Momentum: "momentum", Acceleration: "accel", "Independent origins": "origins", "Impact breadth": "breadth", "Article text read": "fulltext", "Verified stories": "verified", Baseline: "baseline" };
function closeDrawer() { $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on"); xCloseNotifs?.(); tip.hide(); }
async function openOpp(key) {
  let o = S.oppByKey.get(key);
  if (!o) return;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on");
  const d = $("#drawer");
  d.innerHTML = `<div class="drawer-h"><div>${ring(o.score, 64)}</div><div style="min-width:0"><div class="tiny mute b" style="letter-spacing:.06em;text-transform:uppercase">Opportunity</div><h2 style="font-size:18px">${esc(o.sector)} <span class="mute">×</span> ${esc(o.label.name)}</h2><div style="margin-top:6px">${actionPill(o.action)} ${stagePill(o.stage)} ${evPill(o.evidence)} <span class="pill p-muted">${o.kind === "forecast" ? "attention forecast" : "editorial suggestion · too little data to forecast"}</span></div></div><button class="x" id="dx" aria-label="Close">✕</button></div><div class="drawer-b">${loading()}</div>`;
  $("#dx").onclick = closeDrawer;
  const lk = o.label.key;
  // The list leaves out each row's stories, score components and article lists to stay small; the opened row gets them here (cached after the first open).
  const [t, ser, hist, briefs, full] = await Promise.all([
    api(`/api/topic?${qs(`&key=${encodeURIComponent(lk)}`)}`).catch(() => null),
    api(`/api/series?keys=${encodeURIComponent(lk)}&gran=hour${S.date ? `&date=${S.date}` : ""}`).catch(() => null),
    api(`/api/recommendations?company=${encodeURIComponent(S.company)}&key=${encodeURIComponent(o.key)}`).catch(() => ({ history: [] })),
    api(`/api/briefs?opp=${encodeURIComponent(o.key)}`).catch(() => ({ briefs: [] })),
    o.slim ? api(`/api/opportunity?${qs(`&key=${encodeURIComponent(o.key)}&mode=${S.opp.mode}&group=${S.opp.group ? "topic" : "pair"}`)}`).catch(() => null) : null,
  ]);
  if (full && !full.error) { o = full; S.oppByKey.set(key, full); }
  const m = o.metrics, tr = o.trigger;
  const body = $(".drawer-b", d);
  body.innerHTML = `
    <div class="card"><h3>Suggested angle</h3>
      <div class="mdp-advisory-card" style="margin:10px 0;padding:16px 18px;border-top:3px solid var(--brand);background:var(--surface2)">
        <div class="mdp-card-topbar">
          <div class="mdp-card-badges">
            <span class="mdp-practice-tag">🏢 ${esc(o.sector)} Practice</span>
            <span class="mdp-role-pill">👤 BCG Managing Director &amp; Senior Partner (MDP)</span>
            <span class="mdp-format-pill">Strategic Advisory Brief</span>
          </div>
          <div class="tag b">📊 ${o.storyCount ?? o.metrics?.count ?? 0} stories tracked</div>
        </div>

        ${o.sectorDescription ? `<div style="margin:8px 0 4px;padding:6px 10px;background:var(--surface);border:1px solid var(--line);border-radius:6px;font-size:11.5px;color:var(--ink2)"><b>Sector Scope:</b> ${esc(o.sectorDescription)}</div>` : ""}

        <h4 style="margin:6px 0 4px;font-size:15px;line-height:1.4;color:var(--ink)">${o.angle ? esc(o.angle) : "<span class='mute'>No angle written for this pairing yet.</span>"}</h4>

        <div class="mdp-thesis-box" style="margin:8px 0">
          <div class="mdp-box-lbl">STRATEGIC RATIONALE &amp; SECTOR TRANSMISSION</div>
          <div class="mdp-thesis-text">${esc(o.why)}</div>
        </div>

        <div class="mdp-card-footer" style="padding-top:8px;margin-top:4px">
          <div class="small mute"><b>Channel:</b> ${esc(o.channel)} · <b>Front:</b> ${esc(o.front.replace("_", " "))} · <b>Relevance:</b> ${o.relevance.toFixed(2)}</div>
          <button class="btn sm ghost" id="dcopybrief">📋 Copy Advisory Angle</button>
        </div>
      </div>
      <div style="margin-top:8px"><span class="tag">relevance ${o.relevance.toFixed(2)}</span><span class="tag">${esc(o.channel)}</span><span class="tag">front: ${esc(o.front.replace("_", " "))}</span><span class="tag">📊 ${o.storyCount ?? o.metrics?.count ?? 0} stories tracked</span><span class="pill ${o.evidenceStatus === "supported" ? "p-ok" : "p-muted"}">${o.evidenceStatus === "supported" ? "sector link supported by evidence" : "sector link is a hypothesis"}</span> ${fitChip(o)}${flagChips(o)} <span class="tag">${esc(o.window.label)}</span></div>
      ${o.label.level === "topic" ? `<p class="small mute">Specific topic within <b>${esc(o.label.parentName ?? "")}</b>.</p>` : ""}
      ${o.otherSectors?.length ? `<p class="small mute" style="margin:8px 0 0">Also relevant to: ${o.otherSectors.map((s) => `<a href="#" data-opp="${esc(s.key)}">${esc(s.sector)}</a> (${Math.round(s.score)})`).join(", ")}</p>` : ""}</div>

    <div class="card"><h3>Why now</h3>
      ${holdNotice(o)}
      ${tr ? `<div class="story"><a class="h" href="${esc(tr.url)}" target="_blank" rel="noopener">${esc(tr.title)}</a><div class="small mute">${tr.verified ? `<span class="pill p-ok">verified trigger</span>` : `<span class="pill p-muted">unverified</span>`} ${esc(tr.reason)} · ${Math.round(tr.ageHours)}h ago</div></div>` : `<p class="mute">No trigger story found in the last 7 days.</p>`}
      <p class="small" style="margin:8px 0 2px"><b>Stage rule:</b> ${esc(o.stageRule)}</p>
      ${o.actionWhy.map((w) => `<p class="small" style="margin:2px 0"><b>Action:</b> ${esc(w)}</p>`).join("")}
      <p class="small mute" style="margin:6px 0 0"><b>Review condition:</b> ${esc(o.review)}</p></div>

    <div class="card"><div class="sec-h" style="margin:0 0 8px"><div><h3>Opportunity Score · ${o.score.toFixed(1)} / 100${info("score")}</h3><p class="hint" style="margin:0">Six factors add up to the score. Click an ⓘ, or any label in the chart, to see what it means.</p></div></div>
      <div class="grid g-5-7" style="align-items:center">
        <div style="text-align:center">${HC.radar ? HC.radar(o.components, 250) : ""}</div>
        <div>
          ${stack(o.components)}${stackLegend()}
          <div style="margin-top:10px">${Object.entries(o.components).map(([k2, c]) => `<div class="compo"><span title="${esc(c.note)}">${COMP[k2]}${info("c_" + k2)} ${isAdmin() ? `<span class="mute tiny">${c.weight}%</span>` : ""}</span><div class="bar"><i style="width:${c.score}%"></i></div><span class="num small" style="text-align:right">${isAdmin() ? `${c.score.toFixed(0)} → ${c.points.toFixed(1)}` : ""}</span></div><div class="tiny mute" style="margin:-3px 0 4px 140px">${esc(c.note)}</div>`).join("")}</div>
        </div>
      </div>
    </div>

    <div class="card"><div class="sec-h" style="margin:0"><div><h3>Coverage Momentum &amp; Candlestick${info("momentumChart")}</h3><p class="hint" style="margin:0">Raw volume (bars), coverage share &amp; rolling average, or Candlestick OHLC.</p></div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="chart-view-seg" id="dcviewseg"><button data-cv="momentum" class="on">📈 Momentum</button><button data-cv="candlestick">🕯️ Candlestick</button></div>
        <div class="seg" id="dgran"><button data-g="hour" class="on">Hourly</button><button data-g="day">Daily</button></div>
      </div></div>
      <div class="cl" id="dcleg"><span><i style="background:var(--bars-strong);opacity:.7"></i>stories (left axis)</span><span><i class="ln" style="background:var(--line-share)"></i>coverage share</span><span><i class="ln" style="background:var(--line-avg)"></i>rolling average</span><span><i class="dash"></i>forecast</span><span><i style="background:repeating-linear-gradient(45deg,var(--line2) 0 2px,var(--surface2) 2px 5px)"></i>collection gap</span></div>
      <div class="chart" id="dchart"></div><div id="dline"></div><div id="dextra" style="margin-top:8px"></div></div>

    <div class="grid g4">${[["Coverage share", pct(m.share), `baseline ${pct(m.baseShare)}`], ["Momentum", x2(m.ratio), `previous step ${x2(m.ratioPrev)}`], ["Acceleration", m.accel == null ? "–" : (m.accel >= 0 ? "+" : "") + m.accel.toFixed(2), "Δ log₂ momentum"], ["Independent origins", m.originsRecent, `${m.count} stories, last ${m.windowHours}h`], ["Impact breadth", m.areaCount, (m.areas || []).slice(0, 3).join(", ") || "areas"], ["Article text read", `${m.fullTextCount}/${m.count}`, "stories also read beyond the headline"], ["Verified stories", m.verifiedCount, `≥ ${S.cfg?.evidence.verifiedTriggerOrigins ?? 3} origins or primary`], ["Baseline", `${m.baselineHours}h`, `of ${S.cfg?.intervals.baselineHours ?? 168}h target`]].map(([l, v, s]) => `<div class="kpi" style="padding:10px 12px"><div class="v num" style="font-size:19px">${l === "Independent origins" ? originsLink(v, lk, o.label.name) : v}</div><div class="l">${lbl(l, DRAWER_TIP[l])}</div><div class="s">${esc(s)}</div></div>`).join("")}</div>

    ${o.geoBreakdown?.length ? `
      <div class="card" id="dgeocard">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3>Geographical Focus &amp; Locations</h3>
            <p class="hint" style="margin:2px 0 0">Click a location to filter the evidence stories below.</p>
          </div>
          <button class="btn sm ghost" id="dgeoclear" style="display:none">Clear filter</button>
        </div>
        <div class="geo-filter-bar" id="dgeobar" style="margin-top:10px">
          <button class="geo-pill active" data-dgeo="all">🌐 All Locations <span class="badge">${(t?.stories ?? o.stories).length}</span></button>
          ${o.geoBreakdown.map((g) => `<button class="geo-pill" data-dgeo="${esc(g.name)}">📍 ${esc(g.name)} <span class="badge">${g.count}</span></button>`).join("")}
        </div>
      </div>
    ` : ""}

    <div class="card" id="devidencecard">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h3>Evidence</h3>
          <p class="hint" style="margin:2px 0 0" id="devhint">Stories behind this topic in the last 72h (most significant first). Facts in any brief must come from these.</p>
        </div>
        <div id="devfiltertag" style="display:none"></div>
      </div>
      <div id="devlist" style="margin-top:10px"></div>
    </div>

    ${t?.pathways?.length ? `<div class="card"><h3>Event → disruption → sector → question</h3><p class="hint">Causal pathways suggested by the model. “Observed” means the story itself reports the disruption; everything else is a hypothesis.</p>${t.pathways.map((p) => `<div class="story"><div><span class="pill ${p.status === "observed" ? "p-ok" : "p-muted"}">${p.status}</span> <b>${esc(p.disruption)}</b> → ${esc(p.sector)}</div><div class="small">Question: ${esc(p.question)}</div><div class="tiny mute">${esc(clip(p.story, 100))}</div></div>`).join("")}</div>` : ""}

    <div class="card"><h3>Signals still missing${info("searchInterest")}</h3>${o.missing.length ? `<ul class="small" style="margin:6px 0;padding-left:18px">${o.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="mute">None.</p>`}
      <div id="dsearch"></div></div>

    <div class="card" id="dxsocial">
      <div class="sec-h" style="margin:0 0 10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="background:#1d9bf0;color:#fff;width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:15px">𝕏</span>
          <div>
            <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px">
              Twitter / X Trending Status
              <span class="pill ${o.xTrending ? 'p-ok' : 'p-muted'}" style="${o.xTrending ? 'background:#1d9bf0;color:#fff;font-weight:700' : ''}">${o.xTrending ? `● Trending #${o.xTrending.rank} (${o.xTrending.region === 'worldwide' ? 'Worldwide 🌐' : 'India 🇮🇳'})` : '○ Not Trending'}</span>
            </h3>
            <p class="hint" style="margin:2px 0 0">Verified against live Top 70 Twitter trends in India and Worldwide (hourly public mirror feed · zero API cost · zero scraping).</p>
          </div>
        </div>
        <div id="dxactions">
          <button class="btn ghost sm" id="xtrefresh" title="Re-check live Twitter trends">↻ Refresh X Trends</button>
        </div>
      </div>
      <div id="dxbody">
        ${renderXTrendingBody(o)}
      </div>
    </div>

    ${authoredCard(o)}
    <div class="card"><h3>Brief</h3><div id="dbrief"></div></div>
    <div class="card"><h3>Recommendation history</h3><p class="hint">Every logged change, with why it changed. Evidence is stored with each entry.</p>${hist.history.length ? `<div class="timeline">${hist.history.map((h) => `<div class="ev"><div class="small b">${dt(h.ts)} · ${actionPill(h.action)} ${stagePill(h.stage)} score ${h.score.toFixed(0)}</div><div class="small">${esc(h.reason)}</div></div>`).join("")}</div>` : `<p class="mute small">Not logged yet. History is recorded every few minutes while the server runs.</p>`}</div>`;

  // Filter evidence stories by geographical location in Opportunity drawer
  const allEvidence = (t?.stories ?? o.stories) || [];
  let curDGeo = "all";

  const renderEvidenceList = (items, filterLabel = null) => {
    const listEl = $("#devlist", body);
    if (!listEl) return;
    const hintEl = $("#devhint", body);
    const tagEl = $("#devfiltertag", body);
    const clearBtn = $("#dgeoclear", body);

    if (filterLabel) {
      if (hintEl) hintEl.textContent = `Showing ${items.length} of ${allEvidence.length} stories for "${filterLabel}".`;
      if (tagEl) {
        tagEl.style.display = "";
        tagEl.innerHTML = `<span class="pill p-ok">Filtered: 📍 ${esc(filterLabel)}</span>`;
      }
      if (clearBtn) clearBtn.style.display = "";
    } else {
      if (hintEl) hintEl.textContent = `Stories behind this topic in the last 72h (most significant first). Facts in any brief must come from these.`;
      if (tagEl) tagEl.style.display = "none";
      if (clearBtn) clearBtn.style.display = "none";
    }

    if (!items.length) {
      listEl.innerHTML = `<div class="empty" style="padding:16px 0;color:var(--mute)">No evidence stories found matching "${esc(filterLabel || "")}". <a href="#" id="dgeoresetlink" style="color:var(--brand);margin-left:6px;cursor:pointer">Show all stories</a></div>`;
      const resetLink = $("#dgeoresetlink", listEl);
      if (resetLink) resetLink.onclick = (e) => { e.preventDefault(); filterByGeo("all"); };
      return;
    }

    listEl.innerHTML = items.map((s) => `
      <div class="story">
        <a class="h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
        <div style="margin:3px 0">
          ${s.verified ? `<span class="pill p-ok">verified</span> ` : ""}
          ${s.primary ? `<span class="pill p-high">primary source</span> ` : ""}
          ${(s.geography && s.geography.length) ? s.geography.map((g) => `<button class="tag clickable-geo" data-dgeo="${esc(g)}" style="background:var(--brand-soft);color:var(--brand);font-weight:600;cursor:pointer;border:none;padding:2px 8px;border-radius:4px" title="Filter by ${esc(g)}">📍 ${esc(g)}</button>`).join(" ") : ""}
          <span class="tag">${s.outlets ?? 1} outlet${(s.outlets ?? 1) > 1 ? "s" : ""} → ${s.origins ?? 1} origin${(s.origins ?? 1) > 1 ? "s" : ""}</span>
          <span class="tag">${s.fullText ? "full text" : "headline only"}</span>
          ${s.contentType ? `<span class="tag">${esc(s.contentType)}</span>` : ""}
          ${s.wire ? `<span class="tag">wire: ${esc(s.wire)}</span>` : ""}
        </div>
        ${s.summary ? `<div class="small mute">${esc(s.summary)}</div>` : ""}
      </div>
    `).join("");

    $$(".clickable-geo", listEl).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        filterByGeo(btn.dataset.dgeo);
      };
    });
  };

  const filterByGeo = (target) => {
    if (curDGeo === target && target !== "all") {
      target = "all";
    }
    curDGeo = target;
    $$("#dgeobar .geo-pill", body).forEach((b) => b.classList.toggle("active", b.dataset.dgeo === target));

    if (target === "all") {
      renderEvidenceList(allEvidence, null);
    } else {
      const tg = target.toLowerCase();
      const filtered = allEvidence.filter((s) => {
        const geos = (s.geography && s.geography.length) ? s.geography : [];
        const inGeo = geos.some((g) => {
          const gl = String(g).toLowerCase();
          return gl === tg || gl.includes(tg) || tg.includes(gl);
        });
        if (inGeo) return true;
        const text = `${s.title || ""} ${s.summary || ""}`.toLowerCase();
        return text.includes(tg);
      });
      renderEvidenceList(filtered, target);
    }
  };

  // Render initial evidence list
  renderEvidenceList(allEvidence, null);

  // Bind clicks on geo pills
  $$("#dgeobar .geo-pill", body).forEach((b) => {
    b.onclick = () => filterByGeo(b.dataset.dgeo);
  });
  const dGeoClearBtn = $("#dgeoclear", body);
  if (dGeoClearBtn) {
    dGeoClearBtn.onclick = () => filterByGeo("all");
  }

  $$("[data-opp]", body).forEach((a) => (a.onclick = (e) => { e.preventDefault(); if (S.oppByKey.has(a.dataset.opp)) openOpp(a.dataset.opp); else toast("Switch off “one row per topic” to open that pairing."); }));
  // momentum chart (hourly/daily)
  let series = ser?.series?.[lk];
  let dChartMode = "momentum";
  const drawChart = () => {
    if (series) {
      if (dChartMode === "candlestick") {
        HC.candlestick($("#dchart"), series, {
          onCandleClick: (candle) => {
            const timeLabel = fmtT(candle.t, "hour");
            toast(`Selected ${timeLabel}: ${candle.volume || 0} stories tracked (${(candle.close * 100).toFixed(2)}% share)`);
          }
        });
        $("#dcleg").innerHTML = `<span><i style="background:#089981;border-radius:2px"></i>Positive &amp; Neutral (Green)</span><span><i style="background:#f23645;border-radius:2px"></i>Negative (Red)</span><span><i style="background:#f23645;border-radius:2px"></i>🔨 Hammer Decline</span><span><i class="ln" style="background:#2962ff"></i>MA(7) Trend</span><span><i class="dash"></i>Forecast 72h</span>`;
      } else {
        HC.momentum($("#dchart"), series);
        $("#dline").innerHTML = xForecastLine(series, m);
        $("#dcleg").innerHTML = `<span><i style="background:var(--bars-strong);opacity:.7"></i>stories (left axis)</span><span><i class="ln" style="background:var(--line-share)"></i>coverage share</span><span><i class="ln" style="background:var(--line-avg)"></i>rolling average</span><span><i class="dash"></i>forecast</span>`;
      }
    } else {
      $("#dchart").innerHTML = `<div class="empty">No series available.</div>`;
    }
  };
  $("#dextra", body).innerHTML = `${xSeasonChip(t?.seasonality)}${t?.sentiment ? `<div style="margin-top:8px"><span class="tiny mute b">SENTIMENT${info("sentimentNet")}</span>${xSentStrip(t.sentiment)}</div>` : ""}`;
  drawChart();

  $$("#dcviewseg button", body).forEach((b) => (b.onclick = () => {
    dChartMode = b.dataset.cv;
    $$("#dcviewseg button", body).forEach((x) => x.classList.toggle("on", x === b));
    drawChart();
  }));

  $$("#dgran button", body).forEach((b) => (b.onclick = async () => {
    $$("#dgran button", body).forEach((x) => x.classList.toggle("on", x === b));
    const r = await api(`/api/series?keys=${encodeURIComponent(lk)}&gran=${b.dataset.g}${S.date ? `&date=${S.date}` : ""}`);
    series = r.series[lk]; drawChart();
  }));
  searchPanel($("#dsearch", body), t?.searchInterest, o.label.name);
  const dCopyBtn = $("#dcopybrief", body);
  if (dCopyBtn) {
    dCopyBtn.onclick = () => {
      const text = [
        `BCG MDP STRATEGIC ADVISORY ANGLE`,
        `================================`,
        `SECTOR:    ${o.sector}`,
        `TOPIC:     ${o.label.name}`,
        `ROLE:      BCG Managing Director & Senior Partner (MDP)`,
        `SCOPE:     ${o.sectorDescription || "General practice"}`,
        ``,
        `EDITORIAL ANGLE / WRITE-ABOUT:`,
        o.angle || "N/A",
        ``,
        `STRATEGIC RATIONALE:`,
        o.why || "N/A",
        ``,
        `METRICS:   Relevance ${o.relevance.toFixed(2)} · ${o.channel} channel · ${o.front} front · ${o.storyCount ?? 0} stories tracked`
      ].join("\n");
      navigator.clipboard?.writeText(text);
      toast("📋 Advisory angle copied to clipboard!");
    };
  }
  const xtBtn = $("#xtrefresh", body);
  if (xtBtn) {
    xtBtn.onclick = async () => {
      xtBtn.disabled = true; xtBtn.textContent = "Checking…";
      try {
        await post("/api/xtrends/refresh", {});
        const updated = await api(`/api/opportunity?${qs(`&key=${encodeURIComponent(o.key)}&mode=${S.opp.mode}&group=${S.opp.group ? "topic" : "pair"}`)}`).catch(() => null);
        if (updated && !updated.error) {
          o = updated;
          S.oppByKey.set(o.key, updated);
        }
        toast(o.xTrending ? `Verified trending on 𝕏 (#${o.xTrending.rank} ${o.xTrending.region === 'worldwide' ? 'Worldwide 🌐' : 'India 🇮🇳'})` : "Checked live trends: Not currently trending in Top 70");
        const b = $("#dxbody", body);
        if (b) b.innerHTML = renderXTrendingBody(o);
        const headerPill = $("#dxsocial .sec-h .pill", body);
        if (headerPill) {
          headerPill.className = `pill ${o.xTrending ? 'p-ok' : 'p-muted'}`;
          headerPill.style = o.xTrending ? 'background:#1d9bf0;color:#fff;font-weight:700' : '';
          headerPill.textContent = o.xTrending ? `● Trending #${o.xTrending.rank} (${o.xTrending.region === 'worldwide' ? 'Worldwide 🌐' : 'India 🇮🇳'})` : '○ Not Trending';
        }
      } catch (e) {
        toast("Refresh failed: " + e.message);
      } finally {
        xtBtn.disabled = false; xtBtn.textContent = "↻ Refresh X Trends";
      }
    };
  }
  // JOURNALISTS DISABLED: fitPanel($("#dfit", body), o);
  briefPanel($("#dbrief", body), o, briefs.briefs);
}

function renderXTrendingBody(o) {
  const xt = o.xTrending;
  if (xt) {
    const isWorld = xt.region === "worldwide";
    const regLabel = isWorld ? "WORLDWIDE 🌐" : "IN INDIA 🇮🇳";
    const flag = isWorld ? "🌐 Global Trend" : "🇮🇳 India Trend";
    return `
      <div style="background:rgba(29,155,240,0.06);border:1px solid rgba(29,155,240,0.3);border-radius:8px;padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="pill" style="background:#1d9bf0;color:#fff;font-weight:700;font-size:12px;padding:3px 10px">● TRENDING ON 𝕏 ${regLabel}</span>
            <span class="tag" style="background:rgba(29,155,240,0.18);color:#1d9bf0;font-weight:700">Rank #${xt.rank}</span>
            <span class="tag" style="font-weight:600">${flag}</span>
          </div>
          ${xt.count ? `<span class="small b mute" style="font-size:12.5px">${esc(xt.count)} tweets</span>` : ""}
        </div>
        <div style="font-size:14.5px;margin:10px 0 6px">
          <b>Active Trend:</b> <span class="tag" style="background:#1d9bf0;color:#fff;font-weight:700;font-size:14px;padding:4px 10px;margin-left:4px">${esc(xt.name)}</span>
        </div>
        <p class="small" style="margin:6px 0 0;color:var(--text);line-height:1.45">${esc(xt.reason || `This editorial angle directly corresponds to active viral trending discourse on Twitter ${isWorld ? 'worldwide' : 'in India'}.`)}</p>
        <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="pill p-ok" style="font-size:11px">Viral Angle Verified</span>
          <span class="tag" style="font-size:11px">High Social Resonance</span>
          <span class="tag" style="font-size:11px">${isWorld ? 'Worldwide Stream' : 'India Stream'}</span>
        </div>
      </div>`;
  }
  return `
    <div style="background:var(--surface2);border:1px dashed var(--line);border-radius:8px;padding:14px 16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="pill p-muted" style="font-weight:600;font-size:12px;padding:3px 10px">○ NOT CURRENTLY TRENDING ON 𝕏</span>
        <span class="tag" style="font-size:11px">Outside Top 70</span>
      </div>
      <p style="margin:6px 0 4px;font-size:13.5px;line-height:1.45;color:var(--text)">
        This editorial angle is <b>not actively trending in India or Worldwide Top 70 Twitter topics</b> at this moment.
      </p>
      <p class="small mute" style="margin:0 0 10px;line-height:1.4">
        This opportunity is backed by verified news publications and coverage baseline momentum, rather than social media virality.
      </p>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span class="tag" style="font-size:11px">Checked against India & Worldwide Top 70</span>
        <span class="tag" style="font-size:11px">News-Led Opportunity</span>
      </div>
    </div>`;
}

function searchPanel(el, si, name) {
  if (!si) { el.innerHTML = ""; return; }
  if (si.available) { el.innerHTML = `<h3 style="margin-top:12px">Search interest <span class="mute" style="font-weight:400">· separate signal, ${esc(si.source)}</span></h3><div class="chart" id="si"></div><p class="tiny mute">${esc(si.note)}</p>`; HC.lineChart($("#si", el), si.points); return; }
  el.innerHTML = `<p class="small mute" style="margin:10px 0 0"><b>Search interest:</b> ${esc(si.reason)} ${isAdmin() && S.status?.searchInterest?.configured ? `<button class="btn ghost sm" id="sifetch">Fetch for “${esc(name)}”</button>` : ""}</p>`;
  const b = $("#sifetch", el);
  if (b) b.onclick = async () => { b.disabled = true; try { await post("/api/search-interest", { topic: name }); toast("Search interest fetched"); render(); } catch (e) { toast(e.message); b.disabled = false; } };
}

// JOURNALISTS DISABLED: best-matching journalists for this opportunity (fitPanel, contactLinks). Authored articles replace it: see authoredCard in quality.js.
// // Best-matching journalists for this opportunity. Matched only on what each record states (beat, outlet, place, recent articles).
// async function fitPanel(el, o) {
//   if (!isAdmin()) { el.innerHTML = ""; return; } // the journalist directory (with contact details) is for administrators
//   el.innerHTML = `<p class="small mute">Finding journalists…</p>`;
//   S.jm ??= {};
//   let r;
//   try { r = await api(`/api/journalists/matches?${qs(`&opp=${encodeURIComponent(o.key)}&limit=6`)}`); }
//   catch (e) { el.innerHTML = `<p class="small mute">${esc(e.message)}</p>`; return; }
//   S.jm[o.key] = r.matches;
//   if (!r.directory) { el.innerHTML = `<p class="small mute">The journalist directory isn’t loaded yet. Open <a href="#/journalists">Journalists</a> and press Sync.</p>`; S.briefRedraw?.(); return; }
//   el.innerHTML = `<p class="tiny mute" style="margin:0 0 6px">${n0(r.matched)} of ${n0(r.directory)} journalists have a link to this topic. Fit = beat 35 · recent articles 35 · place 15 · outlet already covering it 15.</p>` +
//     (r.matches.map((a) => `<div class="story"><div style="display:flex;gap:10px;align-items:flex-start"><div>${ring(a.score, 44)}</div><div style="min-width:0"><b>${esc(a.name)}</b> <span class="mute small">${esc([a.designation, a.publication].filter(Boolean).join(" · "))}</span>
//       <div class="small mute">${a.why.map(esc).join(" · ") || "Weak match on the available fields."}</div>
//       ${a.evidence.map((x) => `<div class="small">Wrote: ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(clip(x.title, 90))}</a>` : esc(clip(x.title, 90))}${x.publishDate ? ` <span class="mute tiny">${esc(x.publishDate.slice(0, 10))}</span>` : ""}</div>`).join("")}
//       <div class="tiny" style="margin-top:3px">${contactLinks(a.contact)}</div>${a.missing.length ? `<div class="tiny mute">Record has no: ${a.missing.join(", ")}</div>` : ""}</div></div></div>`).join("") || `<p class="small mute">No journalist in the directory has a recorded link to this topic.</p>`);
//   S.briefRedraw?.();
// }
// const contactLinks = (c) => [c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`, c.linkedin && `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>`, c.profile && `<a href="${esc(c.profile)}" target="_blank" rel="noopener">Profile</a>`, c.phone && esc(c.phone)].filter(Boolean).join(" · ") || `<span class="mute">no contact details on record</span>`;

function briefPanel(el, o, briefs) {
  let cur = briefs;
  const draw = (list) => {
    cur = list;
    el.innerHTML = `<div class="ctl" style="margin-bottom:10px"><button class="btn sm" id="bgo" ${S.status?.llm.ok ? "" : "disabled"}>${list.length ? "Draft another brief" : "Draft brief"}</button><span class="small mute" id="bst">An editor must approve before anything is drafted further or pitched. Nothing is sent anywhere.</span></div>
    ${list.map((b) => briefCard(b)).join("")}`;
    $("#bgo", el).onclick = async () => {
      const btn = $("#bgo", el); btn.disabled = true; $("#bst", el).textContent = "Drafting…";
      try { await post("/api/brief", { oppKey: o.key, company: S.company, date: S.date }); const r = await api(`/api/briefs?opp=${encodeURIComponent(o.key)}`); draw(r.briefs); toast("Brief drafted — pending editor approval"); }
      catch (e) { $("#bst", el).textContent = e.message; btn.disabled = false; }
    };
    $$("[data-decide]", el).forEach((b) => (b.onclick = async () => {
      const note = $(`#note-${b.dataset.id}`, el)?.value ?? "";
      try { await post("/api/brief/decide", { id: +b.dataset.id, status: b.dataset.decide, note }); const r = await api(`/api/briefs?opp=${encodeURIComponent(o.key)}`); draw(r.briefs); toast("Decision recorded"); } catch (e) { toast(e.message); }
    }));
    $$("[data-copy]", el).forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(briefText(list.find((x) => x.id === +b.dataset.copy))); toast("Copied"); }));
  };
  S.briefRedraw = () => draw(cur);
  draw(briefs);
}
const statusPill = (s) => `<span class="pill ${s === "approved" ? "p-ok" : s === "rejected" ? "p-bad" : s === "needs_evidence" ? "p-medium" : "p-muted"}">${s.replace("_", " ")}</span>`;
function briefCard(b) {
  const x = b.brief;
  return `<div class="brief" style="margin-bottom:12px"><div class="flex" style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="tiny mute">${dt(b.createdAt)}${x.generatedFor?.recipient ? ` · pitch to ${esc(x.generatedFor.recipient.name)}${x.generatedFor.recipient.publication ? ", " + esc(x.generatedFor.recipient.publication) : ""}` : ""}</span>${statusPill(b.status)}</div>
    <h4>${esc(x.headline)}</h4><dl style="margin:0">
    <dt>Core argument</dt><dd>${esc(x.core_argument)}</dd><dt>Audience</dt><dd>${esc(x.audience)}</dd><dt>Reason to write now</dt><dd>${esc(x.reason_now)}</dd>
    <dt>Confirmed facts (each tied to a source)</dt><dd><ul>${x.confirmed_facts.map((f) => `<li>${esc(f.fact)} <a href="${esc(f.source_url)}" target="_blank" rel="noopener">source ↗</a></li>`).join("") || "<li class='mute'>None source-backed.</li>"}</ul></dd>
    <dt>Assumptions (not confirmed)</dt><dd><ul>${x.assumptions.map((a) => `<li>${esc(a)}</li>`).join("") || "<li class='mute'>None.</li>"}</ul></dd>
    <dt>Evidence still needed</dt><dd><ul>${x.evidence_needed.map((a) => `<li>${esc(a)}</li>`).join("") || "<li class='mute'>None listed.</li>"}</ul></dd>
    <dt>Recommended publication window</dt><dd>${esc(x.publication_window)}</dd><dt>Review condition</dt><dd>${esc(x.review_condition)}</dd></dl>
    <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input type="text" id="note-${b.id}" placeholder="Editor note (optional)" value="${esc(b.note ?? "")}" style="max-width:260px"><button class="btn good sm" data-id="${b.id}" data-decide="approved">Approve</button><button class="btn ghost sm" data-id="${b.id}" data-decide="needs_evidence">Needs evidence</button><button class="btn bad sm" data-id="${b.id}" data-decide="rejected">Reject</button><button class="btn ghost sm" data-copy="${b.id}">Copy</button></div></div>`;
}
const briefText = (b) => `${b.brief.headline}\n\n${b.brief.core_argument}\n\nAudience: ${b.brief.audience}\nWhy now: ${b.brief.reason_now}\n\nConfirmed facts:\n${b.brief.confirmed_facts.map((f) => `- ${f.fact} (${f.source_url})`).join("\n")}\n\nAssumptions:\n${b.brief.assumptions.map((a) => `- ${a}`).join("\n")}\n\nEvidence needed:\n${b.brief.evidence_needed.map((a) => `- ${a}`).join("\n")}\n\nWindow: ${b.brief.publication_window}\nReview condition: ${b.brief.review_condition}`;

// ---------------------------------------------------------------- run panel
function bindRunPanel() {
  const panel = $("#runpanel");
  $("#runtoggle").onclick = (e) => { e.stopPropagation(); panel.style.display = panel.style.display === "none" ? "" : "none"; };
  document.addEventListener("click", (e) => { if (!panel.contains(e.target) && e.target.id !== "runtoggle") panel.style.display = "none"; });
  $("#rmode").onchange = (e) => { const d = e.target.value === "day"; $("#rday").style.display = d ? "" : "none"; if (d && !$("#rday").value) $("#rday").value = S.date || new Date().toISOString().slice(0, 10); };
  $("#rday").max = new Date().toISOString().slice(0, 10);
  $("#rgo").onclick = async () => {
    const day = $("#rmode").value === "day" ? $("#rday").value : null;
    if ($("#rmode").value === "day" && !day) return toast("Pick a day first");
    if (!confirm(`${day ? `Fetch and read ${fmtDay(day)}` : "Fetch and read the last 24 hours"}?\n\nEvery story not already stored is read by the LLM (a full day is roughly 2,000 calls and takes a while). Stored stories are skipped and nothing existing is changed.${day ? "\n\nA past day is limited to about 100 headlines per publication." : ""}`)) return;
    try { await post("/api/run", { date: day }); panel.style.display = "none"; toast("Collection started"); await loadStatusOnce(); } catch (e) { toast(e.message, 5000); }
  };
  $("#renrich").onclick = async () => {
    const st = S.status, todo = Math.max(0, st.enrich.readings - st.enrich.labelled);
    if (!confirm(`Label topics for ${n0(todo)} stories?\n\nThis makes one small LLM call per story (about ${n0(todo)} calls with the configured model). It only adds topic labels, content type, entities and causal pathways. No story is re-read and no existing data is changed. It can be stopped and resumed; labelled stories are skipped.`)) return;
    try { await post("/api/enrich", {}); panel.style.display = "none"; toast("Labelling started"); await loadStatusOnce(); } catch (e) { toast(e.message, 5000); }
  };
  const triggerSync = async (full = false) => {
    panel.style.display = "none";
    toast(full ? "Starting full export sync..." : "Polling fresh data from export API...");
    try {
      await post("/api/sync/export", { full });
      toast("Sync job started in background");
      await loadStatusOnce();
    } catch (e) {
      toast("Sync failed: " + e.message, 5000);
    }
  };
  if ($("#rsync")) $("#rsync").onclick = () => triggerSync(false);
  if ($("#rsyncfull")) $("#rsyncfull").onclick = () => {
    if (confirm("Re-sync all datasets from export API? This may take 1-2 minutes to re-verify all tables.")) triggerSync(true);
  };
}
async function loadStatusOnce() { S.status = await api("/api/status"); renderTop(); }
// The sync buttons only appear on a copy that is set up to sync from another server (never on the live server itself).
function showSyncBox() { const b = document.getElementById("rsyncbox"); if (b) b.style.display = S.status?.syncConfigured ? "" : "none"; }

// ---------------------------------------------------------------- boot
function init() {
  buildShell();
  xInitNotifs();
  const meReady = loadMe(); // who is signed in decides what a page shows (client logins see less), so the first page waits for it
  $("#csel").onchange = (e) => { apiCache.clear(); S.company = e.target.value; ls.set("company", S.company); S.oppByKey.clear(); render(); };
  $("#dsel").onchange = (e) => {
    apiCache.clear();
    S.date = e.target.value || null;
    toast(S.date ? `Viewing date: ${fmtDay(S.date)}` : "Viewing Live (latest data)");
    render();
  };
  $("#theme").onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"); const nx = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nx; ls.set("theme", nx); render(); };
  $("#print").onclick = () => print();
  $("#scrim").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  const th = ls.get("theme"); if (th) document.documentElement.dataset.theme = th;
  bindRunPanel();
  addEventListener("hashchange", route);
  Promise.all([loadStatus(), meReady.catch(() => {})]).then(route);
}
init();
