// HiveMind dashboard — extras: info tips, origins list, notifications, forecast one-liner, and the newer pages
// (Entities, Sentiment, Logs, Usage, Accuracy). Loaded after pages.js and before app.js; it uses app.js globals
// (S, api, post, esc, …) only when called, never while loading. Every endpoint is optional: a missing one shows
// a friendly empty state instead of breaking the page.

// ---------------------------------------------------------------- info tips
const INFO = {
  stories: { t: "Stories analysed", d: "Distinct news stories in the database. Near-identical headlines from different outlets are merged into one story.", ex: "10 outlets run the same wire report → 1 story." },
  origins: { t: "Independent origins", d: "How many separate reporting sources are behind the coverage. Outlets under one owner, and wire copy such as PTI or ANI, count once.", ex: "8 outlets repeat one PTI report → 1 origin, not 8." },
  sources: { t: "Approved sources", d: "The newsrooms, trade papers and primary sources (regulators, ministries) the app is allowed to collect from." },
  topics: { t: "Topics tracked", d: "Broad areas (like Energy or Finance) plus the specific recurring themes found by reading stories (like “fuel prices”)." },
  triggers: { t: "Verified triggers (72h)", d: "Recent stories that count as confirmed: they come from a primary source, or from at least 3 independent origins." },
  writeNow: { t: "Write now", d: "Every condition is met: strong score, enough evidence, rising topic, room for a fresh angle, a verified trigger and a supported sector link." },
  investigate: { t: "Investigate", d: "Promising, but something is still missing, usually a verified trigger or a sector link judged for this topic." },
  monitor: { t: "Monitor", d: "On the watchlist: the score is low or there is too little evidence so far." },
  skip: { t: "Skip", d: "Coverage is declining, the topic is crowded, or the score is weak." },
  share: { t: "Coverage share", d: "The part of all collected stories that are about this topic. Using a share (not a raw count) means a busy news day doesn't look like a surge.", ex: "0.8% = 8 of every 1,000 stories." },
  momentum: { t: "Momentum", d: "Recent coverage share divided by its normal (baseline) share. 1.0× means business as usual; above 1.0× means the topic is gaining attention.", ex: "×7.6 → the topic gets 7.6 times its usual share." },
  accel: { t: "Acceleration", d: "Whether momentum is speeding up or slowing down compared with the previous step (change in log₂ momentum). Positive = speeding up.", ex: "+1 means momentum doubled since the last step." },
  breadth: { t: "Impact breadth", d: "How many different areas the stories touch (markets, economy, governance…). Wide breadth means the topic spreads beyond one beat." },
  verified: { t: "Verified stories", d: "Stories confirmed by a primary source or by at least 3 independent origins." },
  fulltext: { t: "Read from article text", d: "Stories are normally read from the headline and snippet, which keeps cost low. Where the article body was also read, it is counted here. A headline-only reading is not weak by itself; the evidence rules rely on independent origins." },
  baseline: { t: "Baseline", d: "How much history the “normal” level is built from. The target is 7 days (168h); with less, momentum is rougher.", ex: "39h of 168h → about a quarter of the target." },
  c_momentum: { t: "Momentum (25 of 100 points)", d: "How much bigger the topic's share of coverage is than its normal share. The bar fills at about 4× normal; at 1× (normal) or below it scores nothing.", ex: "×7.1 vs baseline → full 25 points." },
  c_acceleration: { t: "Acceleration (15 points)", d: "Whether the attention is still speeding up. A steady topic scores about half; it fills when momentum is rising quickly (nearly tripling per 12-hour step) and drops when attention is slowing.", ex: "+4.3 → full 15 points." },
  c_sourceBreadth: { t: "Independent sources (15 points)", d: "How many separate origins report the topic. Outlets under one owner, and copies of a wire report, count once. The bar fills at 8 or more.", ex: "7 independent origins → about 13 of 15." },
  c_sectorEvidence: { t: "Sector evidence (20 points)", d: "How much the topic really matters to this client sector, from 0 to 1, judged from the topic's own stories. A little lower when the link is only inherited from the broader area.", ex: "Relevance 0.75 → 15 of 20." },
  c_triggerTiming: { t: "Trigger timing (15 points)", d: "How fresh the event that gives a reason to act is. A trigger is a story confirmed by an official source or at least three independent origins. Full marks within 24 hours, fading over a week, and halved if it is not yet verified.", ex: "Unverified, 1 origin → 7.5 of 15." },
  c_headroom: { t: "Editorial headroom (10 points)", d: "Counted from opinion and analysis pieces in the print editions that take up this angle (last 7 days). Two views of the same count: <b>Nobody has written it</b> scores higher when fewer pieces exist (open ground); <b>Others have written it</b> scores higher when more exist (several writers already made the case). Without print data it falls back to coverage share.", ex: "Share percentile 88 (crowded) → 1.2 of 10." },
  score: { t: "Opportunity score", d: "A 0–100 ranking that combines six factors (momentum, acceleration, source breadth, sector evidence, trigger timing and editorial headroom). It ranks opportunities; it is not a probability." },
  forecast: { t: "Forecast", d: "A simple extrapolation of recent share with an 80% uncertainty band. It is a pilot estimate and has not been validated against outcomes." },
  momentumChart: { t: "Momentum chart", d: "Bars are the story count, the blue line is coverage share and the green line a rolling average. Diamonds mark verified triggers; the dashed orange area is the unvalidated forecast." },
  lifecycle: { t: "Topic lifecycle", d: "Where each broad topic sits: watchlist, emerging, rising, steady, crowded or declining. Each stage follows a written rule (see Method)." },
  funnel: { t: "From headlines to decisions", d: "How many items survive each step, from raw headlines down to the opportunities marked Write now." },
  confidence: { t: "Data confidence", d: "Why scores should be read with care: baseline depth, timeliness of collection and the data-quality status. Stories are read from headlines and snippets to keep cost down; the evidence rules rely on independent origins instead." },
  quality: { t: "Data quality", d: "Automatic checks on the data behind the numbers: duplicate stories, unplaced outlets, silent sources and the like. If the status turns red, “write now” is held back." },
  audit: { t: "Reading audit", d: "A person checks a sample of stories to see whether the AI read them fairly. The share marked correct is the reading accuracy.", ex: "45 of 50 marked correct → 90%." },
  forecastAcc: { t: "Forecast accuracy", d: "Each forecast is compared with what really happened. If the 80% band is honest, the real value falls inside it about 80% of the time, and the forecast should beat simply repeating the latest value." },
  risers: { t: "Momentum leaders", d: "Topics whose coverage share grew fastest against their baseline." },
  searchInterest: { t: "Search interest", d: "How much people are searching for the topic on Google (relative 0–100). Kept separate from news coverage and never filled with zeros." },
  social: { t: "X (Twitter) pulse", d: "Hourly post volume for the topic from X. A separate signal; it is not mixed into news coverage." },
  entities: { t: "Entities", d: "Named organisations, places and people that stories are about. An entity surging in coverage is an early signal that its topics may follow." },
  entityShare: { t: "Entity share", d: "The part of all stories that mention the entity, against its own baseline." },
  sentimentNet: { t: "Net sentiment", d: "Positive stories minus negative stories, as a share of all labelled stories. +1 is all positive, −1 all negative, 0 balanced.", ex: "+0.20 → positive coverage outweighs negative by 20 points." },
  hitRate: { t: "Live hit rate", d: "Of past recommendations that are old enough to judge (72 hours), the share whose topic later met the trend definition." },
  tuning: { t: "Weight tuning", d: "Tries other score weights against the recorded outcomes and shows whether the hit rate would improve. Nothing changes until you apply it." },
  seasonality: { t: "Weekday adjustment", d: "Compares each day with the usual level for that weekday, so a normal Monday peak isn't mistaken for a rising topic. Needs 4+ weeks of history." },
  logs: { t: "Run log", d: "Every automated and manual run: when it ran, what it collected and whether it succeeded." },
  usage: { t: "API usage", d: "How much of each paid service has been used today and this month, and what is left where the provider reports it." },
};
const info = (k) => (INFO[k] ? `<button type="button" class="ib" data-info="${k}" aria-label="What is ${esc(INFO[k].t)}?">i</button>` : "");
const lbl = (text, k) => `${esc(text)}${info(k)}`;

(function wireInfo() {
  let pinned = null;
  const pop = () => document.getElementById("infopop");
  const show = (b) => {
    const d = INFO[b.dataset.info], p = pop();
    if (!d || !p) return;
    p.innerHTML = `<b>${esc(d.t)}</b>${esc(d.d)}${d.ex ? `<div class="ex">e.g. ${esc(d.ex)}</div>` : ""}`;
    p.classList.add("on");
    const r = b.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8), y = r.bottom + 8;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 8);
    p.style.left = x + "px"; p.style.top = y + "px";
    b.classList.add("on");
  };
  const hide = () => { pop()?.classList.remove("on"); document.querySelectorAll(".ib.on").forEach((b) => b.classList.remove("on")); pinned = null; };
  document.addEventListener("mouseover", (e) => { const b = e.target.closest?.("[data-info]"); if (b && !pinned) show(b); });
  document.addEventListener("mouseout", (e) => { const b = e.target.closest?.("[data-info]"); if (b && !pinned) hide(); });
  document.addEventListener("focusin", (e) => { const b = e.target.closest?.("[data-info]"); if (b) show(b); });
  document.addEventListener("focusout", (e) => { if (e.target.closest?.("[data-info]") && !pinned) hide(); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-info]");
    if (b) { e.preventDefault(); e.stopPropagation(); if (pinned === b) hide(); else { hide(); pinned = b; show(b); } return; }
    if (pinned) hide();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
})();

// ---------------------------------------------------------------- generic click targets (KPI cards, origins)
document.addEventListener("click", (e) => {
  const o = e.target.closest?.("[data-origins]");
  if (o) { e.preventDefault(); e.stopPropagation(); xOrigins(o.dataset.origins, o.dataset.oname || ""); return; }
  const g = e.target.closest?.("[data-go]");
  if (g && !e.target.closest("a,button,input,select")) { e.preventDefault(); xGo(g.dataset.go); }
}, true);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-go]")) { e.preventDefault(); xGo(e.target.dataset.go); }
});
function xGo(spec) {
  if (spec.startsWith("origins:")) return xOrigins(spec.slice(8), "All collected stories");
  location.hash = spec;
}
const originsLink = (n, key, name = "") => (key ? `<button type="button" class="lnk" data-origins="${esc(key)}" data-oname="${esc(name)}" title="Show the independent origins">${n}</button>` : String(n));

// ---------------------------------------------------------------- modal + origins list
function xModal(title, bodyHtml) {
  const m = document.getElementById("modal");
  m.innerHTML = `<div class="box"><div class="mh"><h3 style="font-size:16px">${title}</h3><button class="x" aria-label="Close">✕</button></div><div class="mb">${bodyHtml}</div></div>`;
  m.classList.add("on");
  const close = () => m.classList.remove("on");
  m.querySelector(".x").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  document.addEventListener("keydown", function esc1(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc1); } });
  return m.querySelector(".mb");
}
async function xOrigins(key, name) {
  const body = xModal(`Independent origins${name ? ` · ${esc(name)}` : ""}`, `<div class="skel" style="height:120px;margin-top:12px"></div>`);
  try {
    const r = await api(`/api/origins?${key && key !== "all" ? `key=${encodeURIComponent(key)}&` : ""}${S.date ? `date=${S.date}` : ""}`);
    const list = r.origins ?? [], total = r.total ?? list.length;
    const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const link = (x) => `<div class="small" style="margin:3px 0"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a> <span class="mute">${esc(when(x.at))}</span></div>`;
    body.innerHTML = `<p class="small mute" style="margin:10px 0">${list.length ? `${esc(String(total))} independent origin${total === 1 ? "" : "s"}. Outlets under one owner, and wire copy, count once. Click a story count to see all of that origin's stories.` : "No origins found for this window."}</p>` +
      (r.removedOffTopic ? `<p class="small" style="margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--soft,#eef3fc)">${esc(String(r.removedOffTopic))} stories tagged with this topic were checked and left out because they are not really about it.</p>` : "") +
      list.map((o, i) => {
        const all = o.items?.length ? o.items : o.sample ?? [];
        return `<div class="story" data-o="${i}"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(o.name)}</b>${o.group && o.group !== o.name ? `<span class="tiny mute">${esc(o.group)}</span>` : ""}${o.type ? `<span class="pill p-muted">${esc(o.type)}</span>` : ""}<span style="flex:1"></span>${o.stories > 3 ? `<button type="button" class="chip" data-more="${i}" aria-expanded="false">${esc(String(o.stories))} stories ▾</button>` : `<span class="tiny mute">${esc(String(o.stories))} stor${o.stories === 1 ? "y" : "ies"}</span>`}</div>
          <div class="o-sample">${(o.sample ?? []).map(link).join("")}</div><div class="o-all" style="display:none;max-height:260px;overflow:auto;border-top:1px solid var(--line,#dce3f0);margin-top:6px;padding-top:6px">${all.map(link).join("")}</div></div>`;
      }).join("");
    body.querySelectorAll("button[data-more]").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest(".story"), open = b.getAttribute("aria-expanded") === "true", o = list[+b.dataset.more];
      card.querySelector(".o-all").style.display = open ? "none" : "";
      card.querySelector(".o-sample").style.display = open ? "" : "none";
      b.setAttribute("aria-expanded", String(!open)); b.textContent = `${o.stories} stories ${open ? "▾" : "▴"}`;
    }));
  } catch (e) { body.innerHTML = `<div class="empty" style="margin-top:12px">The origin list isn’t available yet.<div class="small" style="margin-top:4px">${esc(e.message)}</div></div>`; }
}

// ---------------------------------------------------------------- small formatters
const sgn = (v, d = 2) => (v == null ? "–" : (v >= 0 ? "+" : "") + Number(v).toFixed(d));
function xSentChip(s) {
  const net = typeof s === "number" ? s : s?.net;
  if (net == null) return "";
  const c = net >= 0.15 ? "p-pos" : net <= -0.15 ? "p-neg" : "p-muted";
  return `<span class="pill ${c}" title="Net sentiment: positive minus negative stories">tone ${sgn(net)}</span>`;
}
function xSentStrip(s) {
  if (!s) return "";
  const t = (s.pos || 0) + (s.neg || 0) + (s.neu || 0) + (s.mixed || 0) || 1, w = (v) => ((100 * (v || 0)) / t).toFixed(1);
  return `<div class="sentbar" title="positive / neutral / mixed / negative"><i class="s-pos" style="width:${w(s.pos)}%"></i><i class="s-neu" style="width:${w(s.neu)}%"></i><i class="s-mix" style="width:${w(s.mixed)}%"></i><i class="s-neg" style="width:${w(s.neg)}%"></i></div>
    <div class="tiny mute" style="margin-top:4px">${w(s.pos)}% positive · ${w(s.neg)}% negative · ${w((s.neu || 0) + (s.mixed || 0))}% neutral/mixed${s.net != null ? ` · net ${sgn(s.net)}` : ""}</div>`;
}
function xSeasonChip(s) {
  if (!s) return "";
  return s.active ? `<span class="pill p-ok" title="Each day is compared with the usual level for its weekday">Weekday adjustment: on</span>` : `<span class="pill p-muted" title="Needs enough history to learn weekday patterns">Weekday adjustment: off — needs ${s.needDays ?? 28} days (have ${s.haveDays ?? 0})</span>`;
}
// One plain sentence under the momentum chart, built only from the numbers on the page.
function xForecastLine(series, m = {}) {
  const ratio = m.ratio, accel = m.accel, f = series?.forecast, target = S.cfg?.intervals?.baselineHours ?? 168;
  let a;
  if (ratio == null) a = "There isn’t enough history yet to compare this topic with a baseline";
  else if (ratio >= 1.25) a = `Coverage is <b>×${ratio.toFixed(1)}</b> its baseline`;
  else if (ratio <= 0.8) a = `Coverage is running <b>below</b> its baseline (×${ratio.toFixed(1)})`;
  else a = `Coverage is <b>close to its baseline</b> (×${ratio.toFixed(1)})`;
  if (ratio != null) a += accel == null ? "" : accel > 0.3 ? " and still accelerating" : accel < -0.3 ? " but momentum is easing" : " at a steady pace";
  let b = "";
  if (f?.available && f.points?.length) {
    const cur = [...(series.avg ?? [])].reverse().find((v) => v != null) ?? [...(series.share ?? [])].reverse().find((v) => v != null), end = f.points.at(-1).value;
    const rel = cur > 0 ? end / cur : 1, verb = rel > 1.15 ? "rises towards" : rel < 0.87 ? "falls towards" : "stays near";
    b = `; the forecast ${verb} <b>${pct(end)}</b> share`;
  } else if (f?.reason) b = `; no forecast yet (${esc(String(f.reason).replace(/\.$/, ""))})`;
  const short = m.baselineHours != null && m.baselineHours < target ? ` Only ${m.baselineHours}h of the ${target}h baseline exists, so this is rough.` : "";
  return `<div class="oneline"><span aria-hidden="true">→</span><div>${a}${b} — treat as unvalidated.${short}</div></div>`;
}

// ---------------------------------------------------------------- notifications (bell)
function xInitNotifs() { S.notifs = []; S.notifSeen = +(ls.get("notifSeen") || 0); document.getElementById("bell").onclick = xToggleNotifs; }
function xDerivedNotifs(st) {
  const out = [], r = st.runner;
  if (r.lastMessage) out.push({ id: `run-${r.startedAt}-${r.lastExit}`, ts: r.startedAt || st.serverTime, level: r.lastExit === 0 ? "ok" : "bad", title: r.lastExit === 0 ? "Collection finished" : "Collection failed", text: r.lastMessage, kind: "run" });
  if (st.enrich?.lastMessage) out.push({ id: `enr-${st.enrich.startedAt}-${st.enrich.lastExit}`, ts: st.enrich.startedAt || st.serverTime, level: st.enrich.lastExit === 0 ? "ok" : "bad", title: st.enrich.lastExit === 0 ? "Labelling finished" : "Labelling failed", text: st.enrich.lastMessage, kind: "enrich" });
  for (const i of st.integrations ?? []) if (i.health === "exhausted") out.push({ id: `ex-${i.name}`, ts: i.state?.exhaustedAt || st.serverTime, level: "bad", title: `${i.label}: credit exhausted`, text: i.state?.lastError || "Add credit or switch the service off in Settings.", kind: "credit" });
  return out;
}
async function loadNotifs() {
  let items = null;
  try { items = (await api("/api/notifications")).items; } catch { /* endpoint not available: fall back to what the status already says */ }
  if (!Array.isArray(items)) items = S.status ? xDerivedNotifs(S.status) : [];
  S.notifs = items.slice().sort((a, b) => b.ts - a.ts).slice(0, 100);
  xRenderBell();
  if (document.getElementById("notif").classList.contains("on")) xRenderNotifPanel();
}
function xRenderBell() {
  const unread = S.notifs.filter((n) => n.ts > S.notifSeen).length, b = document.getElementById("bellb");
  b.style.display = unread ? "" : "none"; b.textContent = unread > 9 ? "9+" : unread;
}
function xRenderNotifPanel() {
  const el = document.getElementById("notif"), seen = S.notifSeen;
  el.innerHTML = `<div class="nh"><h3 style="font-size:16px">Notifications</h3><button class="x" id="nx" aria-label="Close">✕</button></div><div class="nb">${S.notifs.length ? S.notifs.map((n) => `<div class="nitem${n.ts > seen ? " new" : ""}"><span class="d ${esc(n.level || "info")}"></span><div><div class="b">${esc(n.title)}</div>${n.text ? `<div class="small mute">${esc(clip(n.text, 260))}</div>` : ""}<div class="tiny mute" style="margin-top:2px">${n.ts ? esc(ago(n.ts)) : ""}</div></div></div>`).join("") : `<div class="empty" style="margin:16px">Nothing new. Run results, labelling and credit warnings will appear here.</div>`}</div>`;
  document.getElementById("nx").onclick = xCloseNotifs;
}
function xCloseNotifs() { document.getElementById("notif").classList.remove("on"); document.getElementById("scrim").classList.remove("on"); }
function xToggleNotifs() {
  const el = document.getElementById("notif");
  if (el.classList.contains("on")) return xCloseNotifs();
  xRenderNotifPanel(); el.classList.add("on"); document.getElementById("scrim").classList.add("on");
  const newest = S.notifs.reduce((m, n) => Math.max(m, n.ts || 0), 0);
  S.notifSeen = Math.max(S.notifSeen, newest); ls.set("notifSeen", String(S.notifSeen)); xRenderBell();
}

// ---------------------------------------------------------------- pager
function xPages(page, pages) {
  const set = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b), out = [];
  list.forEach((p, i) => { if (i && p - list[i - 1] > 1) out.push("…"); out.push(p); });
  return out;
}
function xPager(total, page, size, sizes = [10, 25, 50, 100]) {
  const pages = Math.max(1, Math.ceil(total / size)), from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
  return `<div class="pager"><span class="small mute">${from}–${to} of ${n0(total)}</span>
    <span class="pg"><button data-pg="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>${xPages(page, pages).map((p) => (p === "…" ? `<button disabled>…</button>` : `<button data-pg="${p}" class="${p === page ? "on" : ""}">${p}</button>`)).join("")}<button data-pg="${page + 1}" ${page >= pages ? "disabled" : ""} aria-label="Next page">›</button></span>
    <label class="small mute">Rows <select data-size>${sizes.map((s) => `<option${s === size ? " selected" : ""}>${s}</option>`).join("")}</select></label></div>`;
}

// ---------------------------------------------------------------- Entities
async function pgEntities(el) {
  const f = (S.ent ??= { q: "", sort: "count", dir: -1, page: 1, size: 25, sel: null });
  let d;
  try { d = await api(`/api/entities?${S.date ? `date=${S.date}` : ""}`); }
  catch (e) { el.innerHTML = `<div class="empty"><h3>Entities aren’t available yet</h3><p>${esc(e.message)}</p></div>`; return; }
  const all = d.entities ?? [];
  if (!all.length) { el.innerHTML = `<div class="empty"><h3>No entities yet</h3><p>Entities (organisations, places and people) are collected as stories are read or labelled.</p></div>`; return; }
  const keyf = { count: (e) => e.count, share: (e) => e.share ?? 0, momentum: (e) => e.momentum ?? -1, name: (e) => e.name.toLowerCase(), sentiment: (e) => e.sentiment?.net ?? -9 }[f.sort];
  el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="ctl"><input type="text" id="eq" placeholder="Search organisations, places or people…" value="${esc(f.q)}" style="max-width:300px"><span class="small mute" id="ecount"></span>${info("entities")}</div></div>
    <div id="edetail"></div>
    <div class="card flush"><div class="tw" style="max-height:none"><table class="t"><thead><tr><th class="s" data-s="name">Entity</th><th class="r s" data-s="count">Stories</th><th class="r s" data-s="share">Share${info("entityShare")}</th><th class="r s" data-s="momentum">Momentum${info("momentum")}</th><th>Stage</th><th class="r s" data-s="sentiment">Tone${info("sentimentNet")}</th><th>Trend</th></tr></thead><tbody id="ebody"></tbody></table></div><div id="epager"></div></div>`;
  const draw = () => {
    let rows = all.filter((e) => !f.q || e.name.toLowerCase().includes(f.q.toLowerCase()));
    rows = rows.sort((a, b) => { const x = keyf(a), y = keyf(b); return f.dir * (typeof x === "string" ? x.localeCompare(y) : x - y); });
    $("#ecount").textContent = `${n0(rows.length)} of ${n0(d.total ?? all.length)}`;
    const pages = Math.max(1, Math.ceil(rows.length / f.size)); if (f.page > pages) f.page = pages;
    $("#ebody").innerHTML = rows.slice((f.page - 1) * f.size, f.page * f.size).map((e) => `<tr class="click${e.id === f.sel ? " sel" : ""}" data-e="${esc(e.id)}"><td class="b">${esc(e.name)}</td><td class="r num">${n0(e.count)}</td><td class="r num">${pct(e.share)}</td><td class="r num b">${x2(e.momentum)}</td><td>${e.stage ? stagePill(e.stage) : ""}</td><td class="r">${xSentChip(e.sentiment) || '<span class="mute">–</span>'}</td><td>${spark(e.spark ?? [])}</td></tr>`).join("") || `<tr><td colspan="7" class="mute">No entity matches.</td></tr>`;
    $("#epager").innerHTML = xPager(rows.length, f.page, f.size);
    $$("#ebody tr[data-e]").forEach((r) => (r.onclick = () => { f.sel = r.dataset.e; loadDetail(); draw(); }));
    $$("#epager [data-pg]").forEach((b) => (b.onclick = () => { f.page = +b.dataset.pg; draw(); }));
    const sz = $("#epager [data-size]"); if (sz) sz.onchange = () => { f.size = +sz.value; f.page = 1; draw(); };
  };
  async function loadDetail() {
    const box = $("#edetail"); if (!f.sel) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="skel" style="height:200px"></div></div>`;
    try {
      const r = await api(`/api/entity?id=${encodeURIComponent(f.sel)}${S.date ? `&date=${S.date}` : ""}`);
      const ser = Array.isArray(r.series) ? r.series[0] : r.series;
      box.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="sec-h" style="margin:0"><div><h3 style="font-size:16px">${esc(r.entity?.name ?? f.sel)}</h3><p class="hint" style="margin:0">Coverage of this entity over time</p></div><button class="btn ghost sm" id="eclose">Close</button></div>
        <div class="chart" id="ech" style="margin-top:8px"></div>
        <div class="grid g-7-5" style="margin-top:12px"><div><h4 style="font-size:13px;margin-bottom:6px">Recent stories</h4>${(r.stories ?? []).slice(0, 8).map((s) => `<div class="story"><a class="h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><div class="tiny mute">${s.outlets ? `${s.outlets} outlet${s.outlets > 1 ? "s" : ""} · ` : ""}${s.at ? esc(dt(s.at)) : ""}</div></div>`).join("") || `<span class="mute small">None in the window.</span>`}</div>
        <div><h4 style="font-size:13px;margin-bottom:6px">Topics it appears in</h4><div class="chips">${(r.topics ?? []).slice(0, 14).map((t) => `<span class="chip" data-topic-go="${esc(t.key)}">${esc(t.name)} <span class="mute">${n0(t.count)}</span></span>`).join("") || `<span class="mute small">None yet.</span>`}</div>
        ${r.sentiment ? `<h4 style="font-size:13px;margin:14px 0 6px">Sentiment${info("sentimentNet")}</h4>${xSentStrip(r.sentiment)}` : ""}</div></div></div>`;
      if (ser?.bins) { HC.momentum($("#ech"), ser); $("#ech").insertAdjacentHTML("afterend", xForecastLine(ser, r.entity ?? {})); }
      else if (Array.isArray(ser) && ser.length > 1) HC.lineChart($("#ech"), ser, { label: "Stories per period", color: "var(--line-share)" });
      else $("#ech").innerHTML = `<div class="empty">No time series for this entity.</div>`;
      $("#eclose").onclick = () => { f.sel = null; box.innerHTML = ""; draw(); };
      $$("[data-topic-go]", box).forEach((c) => (c.onclick = () => { S.sel = c.dataset.topicGo; location.hash = c.dataset.topicGo.startsWith("t:") ? "#/trends/topics" : "#/trends/sectors"; }));
    } catch (e) { box.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
  }
  $("#eq").oninput = (e) => { f.q = e.target.value; f.page = 1; draw(); };
  $$("th.s", el).forEach((th) => (th.onclick = () => { f.dir = f.sort === th.dataset.s ? -f.dir : -1; f.sort = th.dataset.s; draw(); }));
  draw(); if (f.sel) loadDetail();
}

// ---------------------------------------------------------------- Sentiment
async function pgSentiment(el) {
  const f = (S.sent ??= { q: "", level: "all", page: 1, size: 25 });
  let d;
  try { d = await api(`/api/sentiment?${S.date ? `date=${S.date}` : ""}`); }
  catch (e) { el.innerHTML = `<div class="empty"><h3>Sentiment isn’t available yet</h3><p>${esc(e.message)}</p></div>`; return; }
  const o = d.overall ?? {}, cv = d.coverage ?? {}, tot = (o.pos || 0) + (o.neg || 0) + (o.neu || 0) + (o.mixed || 0) || 1, p = (v) => ((100 * (v || 0)) / tot).toFixed(0) + "%";
  const prog = cv.total && cv.labelled / cv.total < 0.6;
  el.innerHTML = `${prog ? banner("info", `<b>Sentiment labelling is in progress.</b> ${n0(cv.labelled)} of ${n0(cv.total)} stories are labelled so far; figures firm up as it completes.`) : ""}
  <div class="kpis"><div class="kpi"><div class="v num">${sgn(o.net)}</div><div class="l">${lbl("Net sentiment", "sentimentNet")}</div><div class="s">positive minus negative</div></div>
    <div class="kpi"><div class="v num" style="color:var(--good)">${p(o.pos)}</div><div class="l">Positive</div><div class="s">${n0(o.pos)} stories</div></div>
    <div class="kpi"><div class="v num" style="color:var(--bad)">${p(o.neg)}</div><div class="l">Negative</div><div class="s">${n0(o.neg)} stories</div></div>
    <div class="kpi"><div class="v num">${p((o.neu || 0) + (o.mixed || 0))}</div><div class="l">Neutral / mixed</div><div class="s">${n0((o.neu || 0) + (o.mixed || 0))} stories</div></div>
    <div class="kpi"><div class="v num">${n0(cv.labelled)}</div><div class="l">Stories labelled</div><div class="s">of ${n0(cv.total)}</div></div></div>
  <section class="card"><div class="sec-h" style="margin:0"><div><h3>Daily sentiment</h3><p class="hint" style="margin:0">Green up = positive, red down = negative, grey = neutral or mixed.</p></div></div><div class="chart" id="sch" style="margin-top:8px"></div></section>
  <section class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h3>Biggest swings by sector and topic</h3><p class="hint">Net sentiment now against the previous period. Rising negative coverage of a sector means something different from rising positive coverage.</p>
    <div class="ctl" style="margin-bottom:12px"><input type="text" id="sq" placeholder="Search…" value="${esc(f.q)}" style="max-width:240px"><div class="seg" id="slv">${[["all", "All"], ["bracket", "Sectors"], ["topic", "Topics"]].map(([k, l]) => `<button data-l="${k}" class="${f.level === k ? "on" : ""}">${l}</button>`).join("")}</div></div></div>
    <div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Name</th><th class="r">Stories</th><th class="r">Net now</th><th class="r">Previous</th><th class="r">Change</th></tr></thead><tbody id="sbody"></tbody></table></div><div id="spager"></div></section>`;
  HC.sentimentChart($("#sch"), d.daily ?? []);
  const rows0 = (d.byLabel ?? []).slice().sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const draw = () => {
    const rows = rows0.filter((r) => (f.level === "all" || r.level === f.level) && (!f.q || r.name.toLowerCase().includes(f.q.toLowerCase())));
    const pages = Math.max(1, Math.ceil(rows.length / f.size)); if (f.page > pages) f.page = pages;
    $("#sbody").innerHTML = rows.slice((f.page - 1) * f.size, f.page * f.size).map((r) => `<tr class="click" data-k="${esc(r.key)}"><td class="b">${esc(r.name)} <span class="tag">${r.level === "topic" ? "topic" : "sector"}</span></td><td class="r num">${n0(r.count)}</td><td class="r num b">${sgn(r.net)}</td><td class="r num">${sgn(r.netPrev)}</td><td class="r"><span class="pill ${(r.delta ?? 0) > 0.05 ? "p-pos" : (r.delta ?? 0) < -0.05 ? "p-neg" : "p-muted"}">${(r.delta ?? 0) > 0.05 ? "▲" : (r.delta ?? 0) < -0.05 ? "▼" : "•"} ${sgn(r.delta)}</span></td></tr>`).join("") || `<tr><td colspan="5" class="mute">Nothing to show yet.</td></tr>`;
    $("#spager").innerHTML = xPager(rows.length, f.page, f.size);
    $$("#sbody tr[data-k]").forEach((r) => (r.onclick = () => { S.sel = r.dataset.k; location.hash = r.dataset.k.startsWith("t:") ? "#/trends/topics" : "#/trends/sectors"; }));
    $$("#spager [data-pg]").forEach((b) => (b.onclick = () => { f.page = +b.dataset.pg; draw(); }));
    const sz = $("#spager [data-size]"); if (sz) sz.onchange = () => { f.size = +sz.value; f.page = 1; draw(); };
  };
  $("#sq").oninput = (e) => { f.q = e.target.value; f.page = 1; draw(); };
  $$("#slv button").forEach((b) => (b.onclick = () => { f.level = b.dataset.l; f.page = 1; $$("#slv button").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  draw();
}

// ---------------------------------------------------------------- Logs
const LOG_KIND = { run: "Collection", enrich: "Topic labelling", sentiment: "Sentiment", "topic-merge": "Topic merge", fulltext: "Full-text retry", ocr: "Print editions", online: "Online opinion pieces", "second-opinion": "Second opinion", "entities-merge": "Entity merge", "topic-match": "Pairing check", "hot-topics": "Hot-topic signals", journalists: "Journalist sync" };
const dur = (ms) => (ms == null ? "–" : ms < 1000 ? "<1 s" : ms < 90e3 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`);
async function pgLogs(el) {
  const f = (S.logf ??= { kind: "", trigger: "", status: "" });
  let d;
  try { d = await api(`/api/logs?limit=200${f.kind ? `&kind=${f.kind}` : ""}${f.status ? `&status=${f.status}` : ""}`); }
  catch (e) { el.innerHTML = `<div class="empty"><h3>The run log isn’t available yet</h3><p>${esc(e.message)}</p></div>`; return; }
  const all = d.entries ?? [], rows = all.filter((e) => !f.trigger || (f.trigger === "automated" ? e.trigger !== "manual" : e.trigger === "manual"));
  const sm = d.summary?.last24h ?? {}, sc = d.schedule ?? S.status?.schedule ?? {};
  const every = sc.minutes ? (sc.minutes === 60 ? "hourly" : `every ${sc.minutes} min`) : null;
  const trig = (e) => (e.trigger === "manual" ? `<span class="tagpill t-manual">Manual</span>` : `<span class="tagpill t-auto">Automated${every && e.kind === "run" ? ` (${every})` : ""}</span>`);
  const stat = (e) => `<span class="pill ${e.status === "ok" ? "p-ok" : e.status === "failed" ? "p-bad" : e.status === "running" ? "p-info" : "p-muted"}">${e.status === "ok" ? "Succeeded" : e.status === "failed" ? "Failed" : e.status === "running" ? "Running…" : esc(e.status)}</span>`;
  const sel = (id, label, opts, v) => `<label>${label} <select id="${id}">${opts.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>`;
  const keyNames = { newStories: "New stories", failed: "Failed", existing: "Already stored", headlines: "Headlines", total: "Stories found", labelled: "Labelled", merged: "Merged", calls: "API calls", tokensIn: "Tokens in", tokensOut: "Tokens out", bytes: "Data used" };
  const detail = (e) => {
    const s = e.stats ?? {}, pp = Array.isArray(s.perPublication) ? s.perPublication : null;
    const kv = Object.entries(s).filter(([, v]) => typeof v === "number").map(([k, v]) => `<div class="compo" style="grid-template-columns:150px 1fr"><span>${esc(keyNames[k] ?? k.replace(/([A-Z])/g, " $1").toLowerCase())}</span><b class="num">${n0(v)}</b></div>`).join("");
    return `<div class="grid g2"><div>${e.summary ? `<p class="small" style="margin:0 0 8px">${esc(e.summary)}</p>` : ""}${kv || `<span class="mute small">No counts recorded.</span>`}${e.error ? `<div class="pwarn" style="margin-top:8px">${esc(e.error)}</div>` : ""}<div class="tiny mute" style="margin-top:8px">Started ${esc(dt(e.startedAt))}${e.finishedAt ? ` · finished ${esc(dt(e.finishedAt))}` : ""}</div></div>
      ${pp ? `<div><div class="tiny mute b" style="margin-bottom:4px">PER SOURCE</div><table class="t"><thead><tr><th>Source</th><th class="r">Available</th><th class="r">Collected</th></tr></thead><tbody>${pp.map((x) => `<tr><td>${esc(x.name)}</td><td class="r num">${x.available == null ? "–" : n0(x.available)}</td><td class="r num ${x.polled ? "" : "mute"}">${n0(x.polled)}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
  };
  el.innerHTML = `<div class="kpis"><div class="kpi"><div class="v" style="font-size:20px">${every ? `Automated ${every}` : "Manual only"}</div><div class="l">Collection schedule${info("logs")}</div><div class="s">${sc.nextRunAt ? `next run ~${esc(new Date(Math.max(sc.nextRunAt, Date.now())).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}` : "no schedule set"}${sc.lastRunAt ? ` · last ${esc(ago(sc.lastRunAt))}` : ""}</div></div>
    <div class="kpi"><div class="v num">${n0(sm.runs ?? 0)}</div><div class="l">Runs, last 24h</div><div class="s">${n0(sm.ok ?? 0)} succeeded · ${n0(sm.failed ?? 0)} failed</div></div>
    <div class="kpi"><div class="v num">${n0(sm.newStories ?? 0)}</div><div class="l">New stories, last 24h</div><div class="s">collected by runs</div></div></div>
  <div class="card flush"><div style="padding:14px 16px;border-bottom:1px solid var(--line)"><div class="ctl">
    ${sel("lk", "Type", [["", "All"], ...Object.entries(LOG_KIND)], f.kind)}${sel("lt", "Started by", [["", "All"], ["automated", "Automated"], ["manual", "Manual"]], f.trigger)}${sel("ls", "Result", [["", "All"], ["ok", "Succeeded"], ["failed", "Failed"], ["running", "Running"]], f.status)}<span class="mute small">${n0(rows.length)} shown</span></div></div>
    <div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Started</th><th>Type</th><th>Started by</th><th>Result</th><th class="r">New stories</th><th class="r">Failed</th><th class="r">Duration</th></tr></thead><tbody>
    ${rows.map((e) => `<tr class="click" data-l="${esc(String(e.id))}"><td class="small">${esc(dt(e.startedAt))}</td><td class="b">${esc(LOG_KIND[e.kind] ?? e.kind)}</td><td>${trig(e)}</td><td>${stat(e)}</td><td class="r num">${e.stats?.newStories != null ? n0(e.stats.newStories) : e.stats?.labelled != null ? `${n0(e.stats.labelled)} <span class="mute tiny">labelled</span>` : "–"}</td><td class="r num ${e.stats?.failed ? "" : "mute"}">${e.stats?.failed != null ? n0(e.stats.failed) : "–"}</td><td class="r num">${dur(e.durationMs ?? (e.finishedAt ? e.finishedAt - e.startedAt : null))}</td></tr><tr class="sub" id="ld-${esc(String(e.id))}" style="display:none"><td colspan="7">${detail(e)}</td></tr>`).join("") || `<tr><td colspan="7" class="mute">No runs recorded yet. Collections and labelling jobs will be listed here.</td></tr>`}</tbody></table></div></div>`;
  $("#lk").onchange = (e) => { f.kind = e.target.value; render(); };
  $("#lt").onchange = (e) => { f.trigger = e.target.value; render(); };
  $("#ls").onchange = (e) => { f.status = e.target.value; render(); };
  $$("tr[data-l]", el).forEach((r) => (r.onclick = () => { const x = $(`#ld-${CSS.escape(r.dataset.l)}`); if (x) x.style.display = x.style.display === "none" ? "" : "none"; }));
  if (all.some((e) => e.status === "running")) setTimeout(() => { if (S.tab === "logs" && !document.activeElement?.matches("input,select,textarea")) render(); }, 8000);
}

// ---------------------------------------------------------------- Usage
async function pgUsage(el) {
  let d;
  try { d = await api("/api/usage"); }
  catch (e) { el.innerHTML = `<div class="empty"><h3>Usage isn’t available yet</h3><p>${esc(e.message)}</p></div>`; return; }
  const svc = d.services ?? [], bud = d.budgets ?? {};
  const bal = (s) => {
    const b = s.balance;
    if (!b) return `<div class="small mute">Remaining balance: not reported by this provider.</div>`;
    const known = b.total != null && b.remaining != null, left = known && b.total ? b.remaining / b.total : null;
    return `<div class="compo" style="grid-template-columns:90px 1fr auto"><span>Remaining</span>${known ? `<div class="bar ${left < 0.1 ? "bad" : left < 0.25 ? "warn" : "good"}"><i style="width:${Math.max(2, 100 * left)}%"></i></div>` : `<span></span>`}<b class="num">${b.remaining != null ? n0(b.remaining) : "–"}${b.total != null ? ` <span class="mute tiny">/ ${n0(b.total)}</span>` : ""} ${esc(b.unit ?? "")}</b></div>${b.resetAt ? `<div class="tiny mute">Resets ${esc(dt(b.resetAt))}</div>` : ""}${b.note ? `<div class="tiny mute">${esc(b.note)}</div>` : ""}${left != null && left < 0.2 ? `<div class="pwarn" style="margin-top:6px">Running low: ${Math.round(left * 100)}% left.</div>` : ""}`;
  };
  const row = (l, a, b2) => `<tr><td>${l}</td><td class="r num">${a}</td><td class="r num">${b2}</td></tr>`;
  const bRow = (name, b) => (b ? `<div class="compo" style="grid-template-columns:150px 1fr 90px"><span>${esc(name)}</span><div class="bar ${b.limit && b.used / b.limit > 0.85 ? "warn" : ""}"><i style="width:${b.limit ? Math.min(100, (100 * b.used) / b.limit) : 0}%"></i></div><span class="num small" style="text-align:right">${n0(b.used)} / ${b.limit == null ? "∞" : n0(b.limit)}</span></div>` : "");
  el.innerHTML = `<div class="sec-h"><div><h2>API usage and balances${info("usage")}</h2><p>Calls and tokens used by each service. Balances are shown where the provider reports them.</p></div><button class="btn sm" id="urefresh">Refresh balances</button></div>
    <div class="grid g2">${svc.map((s) => `<div class="card"><div class="sec-h" style="margin:0 0 8px"><div><h3 style="font-size:15px">${esc(s.label)}</h3></div><span class="pill ${!s.configured ? "p-muted" : s.enabled ? "p-ok" : "p-muted"}">${!s.configured ? "Not configured" : s.enabled ? "On" : "Off"}</span></div>
      <table class="t"><thead><tr><th></th><th class="r">Today</th><th class="r">This month</th></tr></thead><tbody>${row("Calls", n0(s.today?.calls ?? 0), n0(s.month?.calls ?? 0))}${row("Errors", n0(s.today?.errors ?? 0), n0(s.month?.errors ?? 0))}${s.today?.tokensIn != null || s.month?.tokensIn != null ? row("Tokens in", n0(s.today?.tokensIn ?? 0), n0(s.month?.tokensIn ?? 0)) + row("Tokens out", n0(s.today?.tokensOut ?? 0), n0(s.month?.tokensOut ?? 0)) : ""}</tbody></table>
      <div style="margin-top:10px">${bal(s)}</div>${s.estCostMonth != null ? `<div class="small" style="margin-top:6px">Estimated spend this month: <b class="num">$${Number(s.estCostMonth).toFixed(2)}</b> <span class="mute tiny">(from our own logs)</span></div>` : ""}${s.note ? `<div class="tiny mute" style="margin-top:6px">${esc(s.note)}</div>` : ""}${s.checkedAt ? `<div class="tiny mute">Checked ${esc(ago(s.checkedAt))}</div>` : ""}</div>`).join("") || `<div class="empty">No services reported.</div>`}</div>
    <section class="card" style="margin-top:16px"><h3>Daily budgets</h3><p class="hint">Caps that stop paid services being used up on hot-topic lookups and full-text retries.</p>${bRow("Serper (hot topics)", bud.serper)}${bRow("SerpApi (search interest)", bud.serpapi)}${bRow("Full-text retries (proxy)", bud.fulltextRetry)}${!bud.serper && !bud.serpapi && !bud.fulltextRetry ? `<span class="mute small">No budgets are set.</span>` : ""}</section>`;
  $("#urefresh").onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; b.textContent = "Refreshing…"; try { await post("/api/usage/refresh", {}); toast("Balances refreshed"); } catch (e) { toast(e.message, 5000); } render(); };
}

// ---------------------------------------------------------------- Accuracy: live hit rate + tuning + the existing backtest
async function pgAccuracy(el) {
  el.innerHTML = `<div id="acc-live"></div><div id="acc-fc" style="margin-top:20px"></div><div id="acc-bt" style="margin-top:20px"></div>`;
  await Promise.all([xLiveAccuracy($("#acc-live")).catch(() => {}), xForecastAccuracy($("#acc-fc")).catch(() => {}), pgValidation($("#acc-bt"))]);
}
async function xLiveAccuracy(box) {
  const [o, t] = await Promise.all([api("/api/outcomes").catch(() => null), api("/api/tuning").catch(() => null)]);
  if (!o && !t) { box.innerHTML = ""; return; }
  const pr = (v) => (v == null ? "–" : Math.round(v * 100) + "%"), h = o?.hitRate ?? {};
  const grp = (m) => Object.entries(m ?? {}).map(([k, v]) => `<div class="compo" style="grid-template-columns:110px 1fr 50px"><span>${esc(k)}</span><div class="bar good"><i style="width:${Math.round(100 * (v?.rate ?? v ?? 0))}%"></i></div><span class="num small">${pr(v?.rate ?? v)}</span></div>`).join("");
  let html = "";
  if (o) html += `<section class="card"><div class="sec-h" style="margin:0"><div><h2 style="font-size:15px">Live hit rate${info("hitRate")}</h2><p>Each logged recommendation is checked 72 hours later: did it surge or not?</p></div>${xSeasonChip(o.seasonality)}</div>
    <div class="kpis" style="margin:12px 0"><div class="kpi"><div class="v num">${pr(h.overall)}</div><div class="l">Hit rate</div><div class="s">of ${n0(o.evaluated ?? 0)} judged</div></div><div class="kpi"><div class="v num">${n0(o.evaluated ?? 0)}</div><div class="l">Judged</div><div class="s">older than 72 hours</div></div><div class="kpi"><div class="v num">${n0(o.pending ?? 0)}</div><div class="l">Waiting</div><div class="s">need 72 hours to mature</div></div></div>
    ${o.evaluated ? `<div class="grid g2"><div><div class="tiny mute b" style="margin-bottom:4px">BY ACTION</div>${grp(h.byAction) || '<span class="mute small">–</span>'}</div><div><div class="tiny mute b" style="margin-bottom:4px">BY SCORE BAND</div>${grp(h.byBand) || '<span class="mute small">–</span>'}</div></div>` : `<div class="empty">No recommendation is old enough to judge yet. The first results appear 72 hours after the first logged recommendation.</div>`}
    ${(o.items ?? []).length ? `<div class="tw" style="max-height:300px;margin-top:12px"><table class="t"><thead><tr><th>Recommended</th><th>Opportunity</th><th>Action</th><th class="r">Score</th><th class="r">Peak</th><th>Outcome</th></tr></thead><tbody>${o.items.slice(0, 60).map((i) => `<tr><td class="small">${esc(dt(i.ts))}</td><td class="b">${esc(i.label)}</td><td>${actionPill(i.action)}</td><td class="r num">${Math.round(i.score)}</td><td class="r num">${i.peakRatio != null ? x2(i.peakRatio) : "–"}</td><td>${i.hit == null ? `<span class="pill p-muted">pending</span>` : i.hit ? `<span class="pill p-ok">✔ surged</span>` : `<span class="pill p-bad">didn’t surge</span>`}</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
  if (t) {
    const w = (x) => Object.entries(x ?? {}).map(([k, v]) => `<div class="compo" style="grid-template-columns:130px 1fr 40px"><span>${esc(COMP[k] ?? k)}</span><div class="bar"><i style="width:${Math.min(100, v * 4)}%"></i></div><span class="num small">${v}</span></div>`).join("");
    html += `<section class="card" style="margin-top:16px"><div class="sec-h" style="margin:0"><div><h2 style="font-size:15px">Weight tuning${info("tuning")}</h2><p>Tests other score weights against the recorded outcomes. Nothing changes until you apply it.</p></div></div>
      ${t.ready ? `<div class="grid g2" style="margin-top:10px"><div><div class="tiny mute b">CURRENT WEIGHTS · hit rate ${pr(t.hitRateCurrent)}</div>${w(t.current?.weights)}</div><div><div class="tiny mute b">SUGGESTED${t.suggested ? ` · hit rate ${pr(t.hitRateSuggested)}` : ""}</div>${t.suggested ? w(t.suggested.weights ?? t.suggested) : `<span class="mute small">The current weights are already the best of those tested.</span>`}</div></div><div class="small mute" style="margin-top:8px">Based on ${n0(t.sample ?? 0)} judged recommendations.</div>` : `<div class="empty" style="margin-top:10px">${esc(t.needs ?? "Not enough judged recommendations yet to tune the weights.")}</div>`}
      <div style="margin-top:12px"><button class="btn" id="tapply" ${t.ready && t.suggested ? "" : "disabled"}>Apply suggested weights</button> <span class="small mute">The previous weights are kept so this can be undone.</span></div></section>`;
  }
  box.innerHTML = html;
  const ap = $("#tapply", box);
  if (ap) ap.onclick = async () => { if (!confirm("Apply the suggested weights to the opportunity score?")) return; ap.disabled = true; try { await post("/api/tuning/apply", { confirm: true }); toast("Weights applied"); S.cfg = null; render(); } catch (e) { toast(e.message, 5000); ap.disabled = false; } };
}
