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
// Print-edition opinion / analysis pieces matched to this angle. Two readings of the same count, chosen with the switch on the Opportunities page.
const authChip = (o) => {
  const a = o?.authored;
  if (!a) return "";
  return a.count
    ? `<span class="pill ${a.mode === "validated" ? "p-ok" : "p-medium"}" data-pieces="${esc(o.key)}" style="cursor:pointer" title="Click to see the ${a.count} opinion and analysis pieces (print editions and online) that take up this angle, last ${a.windowDays} days">${a.online ? `${a.print} print · ${a.online} online` : `${a.count} authored piece${a.count === 1 ? "" : "s"}`}</span>`
    : `<span class="pill ${a.mode === "validated" ? "p-muted" : "p-ok"}" title="No opinion or analysis piece in the print editions or online takes up this angle, last ${a.windowDays} days">${a.mode === "validated" ? "No authored pieces yet" : "Nobody has written this"}</span>`;
};
// Online pieces on this angle: the exact angle is known only once the piece has been read ("matched"); until then it counts for the topic as a whole.
const onlineList = (a) => (a?.onlineArticles?.length ? `<div style="margin-top:8px"><div class="small b">Online</div>${a.onlineArticles.map((x) => `<div class="story"><div class="h"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></div><div class="small mute">${x.author ? `<b>${esc(x.author)}</b> · ` : ""}${esc(x.outlet || "online")} · ${esc(new Date(x.at).toLocaleDateString([], { day: "numeric", month: "short" }))} · ${esc(x.kind)} <span class="pill p-muted" title="${x.exact ? "Read and matched to this exact angle" : "Counted for the topic as a whole: not yet read and matched to an exact angle"}">${x.exact ? "matched" : x.by === "section" ? "opinion page" : x.by === "cue" ? "headline says so" : x.by === "text" ? "text read" : "labelled"}</span></div></div>`).join("")}</div>` : "");
// The "N print · M online" chip opens the whole list of pieces behind that count (capture phase, so a table row under it does not also open).
async function showPieces(key) {
  const body = xModal("Opinion and analysis pieces", `<div class="skel" style="height:160px;margin-top:12px"></div>`);
  try {
    const d = await api("/api/leadership/pieces?key=" + encodeURIComponent(key)), when = (ms) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
    body.parentElement.parentElement.querySelector("h3").textContent = d.topic ? `${d.topic} · ${d.sector}` : "Opinion and analysis pieces";
    const row = (title, meta, act) => `<div style="padding:11px 0;border-top:1px solid var(--line)"><div style="font-weight:600;line-height:1.35">${title}</div><div class="small mute" style="margin-top:3px">${meta}</div>${act ?? ""}</div>`;
    const who = (x) => (x.author ? `${esc(x.author)} · ` : "");
    const group = (t, n, rows) => `<h4 style="margin:18px 0 2px;font-size:13px">${t} <span class="mute" style="font-weight:400">(${n})</span></h4>${rows || '<p class="small mute" style="margin:6px 0">None in the last ' + d.windowDays + " days.</p>"}`;
    body.innerHTML = `<p class="small mute" style="margin:0">Opinion and analysis pieces in the last ${d.windowDays} days, newest first. Reported news is not counted.</p>` +
      group("Online", d.online.length, d.online.map((x) => row(`<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`, `${who(x)}${esc(x.outlet || "online")} · ${when(x.at)} · ${esc(x.kind)}${x.exact ? " · matched to this angle" : ""}`)).join("")) +
      group("Print editions", d.print.length, d.print.map((x) => row(esc(x.headline) + titleTag(x), `${who(x)}${esc(x.source)} · ${esc(x.date)} · ${esc(x.kind)}`, `<button class="btn ghost sm" style="margin-top:6px" data-read="${esc(x.id)}">Read full article</button>`)).join(""));
    body.style.maxHeight = "70vh"; body.style.overflow = "auto";
  } catch (e) { body.innerHTML = `<p class="small mute">${esc(e.message)}</p>`; }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-pieces]"); if (b) { e.preventDefault(); e.stopPropagation(); showPieces(b.dataset.pieces); } }, true);
// The whole article as the print edition gave it. The OCR text is tidied for reading only: words split across lines are joined and line wraps become spaces.
const tidyArticle = (t) => String(t ?? "").replace(/(\w)-\s*\n\s*(?=[a-z])/g, "$1").replace(/(\w)- (?=[a-z])/g, "$1").replace(/(^|\n\s*)([B-HJ-Z])\s+(?=[a-z]{2,})/g, "$1$2").replace(/\n(?!\n)/g, " ").replace(/[ \t]{2,}/g, " ").trim();
async function readArticle(id) {
  const body = xModal("Article", `<div class="skel" style="height:160px;margin-top:12px"></div>`);
  try {
    const a = await api("/api/authored/article?id=" + encodeURIComponent(id));
    const paras = tidyArticle(a.body).split(/\n{2,}/).filter(Boolean).map((p) => `<p style="margin:0 0 10px;line-height:1.55">${esc(p)}</p>`).join("");
    const fixed = a.original && a.original !== a.headline;
    body.parentElement.parentElement.querySelector("h3").textContent = a.headline.length > 90 ? a.headline.slice(0, 90) + "…" : a.headline;
    body.innerHTML = `${fixed ? `<p class="tiny mute" style="margin:0 0 8px">${a.titleSource === "printed" ? "Real title found in the text." : "Title written from the text."} The OCR read the headline as “${esc(a.original)}”.</p>` : ""}<div class="small mute" style="margin-bottom:10px">${a.author ? `<b>${esc(a.author)}</b>` : "unsigned"} · ${esc(a.source)} · ${esc(a.date)}${a.page ? ` · page ${a.page}` : ""} · <span class="pill ${a.kind === "opinion" ? "p-ok" : a.kind === "analysis" ? "p-medium" : "p-muted"}">${esc(a.kind || "not judged")}</span> · ${n0(a.words)} words</div>
      ${a.why ? `<p class="small" style="margin:0 0 10px"><b>Why it was judged ${esc(a.kind)}:</b> ${esc(a.why)}</p>` : ""}
      ${a.matches?.length ? `<p class="small" style="margin:0 0 12px"><b>Suggested angle it takes up:</b> ${a.matches.slice(0, 3).map((m) => `${esc(m.sector)}: ${esc(m.angle || "")} <span class="mute">(fit ${Number(m.fit).toFixed(2)})</span>`).join("<br>")}</p>` : ""}
      <div style="max-height:62vh;overflow:auto;padding-right:6px;border-top:1px solid var(--line);padding-top:12px">${paras || '<span class="mute">No text.</span>'}</div>
      <p class="tiny mute" style="margin:10px 0 0">Text read from the print edition by OCR, so it can contain recognition errors and parts of neighbouring articles.</p>`;
  } catch (e) { body.innerHTML = `<p class="small mute">${esc(e.message)}</p>`; }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-read]"); if (b) { e.preventDefault(); e.stopPropagation(); readArticle(b.dataset.read); } });

// When the OCR picked up the wrong headline it was replaced by the article's real title (printed) or one written from the text (generated).
const titleTag = (x) => (x?.original && x.original !== x.headline ? ` <span class="pill p-muted" title="${esc("Headline as read by OCR: " + x.original)}">${x.titleSource === "printed" ? "headline repaired" : "headline written from text"}</span>` : "");
const authoredCard = (o) => {
  const a = o?.authored;
  if (!a) return `<div class="card"><h3>Who has written about this</h3><p class="small mute" style="margin:6px 0 0">No print-edition articles have been read for this period yet, so the headroom still uses coverage share. Run <b>node src/cli.mjs ocr</b>.</p></div>`;
  const v = a.mode === "validated";
  const ask = a.count
    ? (v ? `<b>${a.count} authored piece${a.count === 1 ? "" : "s"}</b> in the last ${a.windowDays} days already make this case. Do you want to write about it?` : `<b>${a.count} authored piece${a.count === 1 ? "" : "s"}</b> in the last ${a.windowDays} days already take this angle, so there is less room. Is there something new to add?`)
    : (v ? `No authored piece in the last ${a.windowDays} days takes this angle yet, so nothing validates it.` : `<b>Nobody has written this angle</b> in the last ${a.windowDays} days, as per the current news trend. Do you want to write about it?`);
  return `<div class="card"><h3>Who has written about this</h3><p style="margin:6px 0">${ask}</p>
    ${a.articles.length ? `<div style="margin-top:6px">${a.online ? '<div class="small b">Print editions</div>' : ""}${a.articles.map((x) => `<div class="story"><div class="h">${esc(x.headline)}${titleTag(x)}</div><div class="small mute">${x.author ? `<b>${esc(x.author)}</b>` : "unsigned"} · ${esc(x.source)} · ${esc(x.date)}${x.page ? ` · page ${x.page}` : ""} · ${x.kind === "opinion" ? "opinion" : "analysis"} · fit ${Number(x.fit).toFixed(2)}</div><button class="btn ghost sm" style="margin-top:6px" data-read="${esc(x.id)}">Read full article</button></div>`).join("")}</div>` : ""}
    ${onlineList(a)}
    <p class="small mute" style="margin:8px 0 0">${v ? "Validated view: more authored pieces score higher." : "Whitespace view: fewer authored pieces score higher."} Counted from the print editions and from online opinion and analysis pieces (not reported news).</p></div>`;
};
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
    if (n === a) { b.querySelector("#pwe").textContent = "The new password must be different from the current one."; return; }
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
  const companies = S.status?.companies || [{ id: "bcg", name: "BCG" }];
  // a client typed at sign-up that is not set up yet is still shown (and selected), so it is never silently replaced by BCG
  const coOpts = (cur) => (cur && !companies.some((c) => c.id === cur) ? `<option value="${esc(cur)}" selected>${esc(cur.toUpperCase())} (not set up yet)</option>` : "") +
    companies.map(c => `<option value="${esc(c.id)}"${c.id === (cur || "bcg") ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  const row = (u) => `<tr>
    <td class="b">${esc(u.name || "–")}<div class="small mute">${esc(u.email)}</div>${u.clientRequested ? `<div class="tiny mute">Client typed: ${esc(u.clientRequested)}</div>` : ""}</td>
    <td>${st(u.status)}</td>
    <td>${esc(u.role)}</td>
    <td><select data-user-co="${esc(String(u.id))}" class="sel-co" style="font-size:12px;padding:3px 6px;border-radius:4px;border:1px solid var(--line2);background:var(--surface)">${coOpts(u.company)}</select></td>
    <td class="small">${u.lastLoginAt ? esc(dt(u.lastLoginAt)) : "never"}</td>
    <td class="r" style="white-space:nowrap">
      ${u.status === "pending" ? `<button class="btn sm" data-a="approve" data-id="${esc(String(u.id))}">Approve</button> ` : ""}
      ${u.status === "active" ? `<button class="btn ghost sm" data-a="${u.role === "admin" ? "member" : "admin"}" data-id="${esc(String(u.id))}">${u.role === "admin" ? "Make member" : "Make admin"}</button> <button class="btn ghost sm" data-a="reset" data-id="${esc(String(u.id))}">Reset password</button> ` : ""}
      ${u.status === "disabled" ? `<button class="btn ghost sm" data-a="enable" data-id="${esc(String(u.id))}">Enable</button> ` : u.status !== "pending" ? `<button class="btn ghost sm" data-a="disable" data-id="${esc(String(u.id))}">Disable</button>` : `<button class="btn ghost sm" data-a="disable" data-id="${esc(String(u.id))}">Decline</button>`}
    </td>
  </tr>`;
  el.innerHTML = `<div class="sec-h"><div><h2>Users & Client Scoping</h2><p>Control user accounts, permissions, and restrict each member strictly to their assigned client organisation.</p></div></div>
    ${pending.length ? `<section class="card" style="border-color:var(--warn);margin-bottom:16px"><h3>Waiting for approval (${pending.length})</h3><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Assign Client</th><th>Last sign-in</th><th></th></tr></thead><tbody>${pending.map(row).join("")}</tbody></table></div></section>` : ""}
    <section class="card"><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Person</th><th>Status</th><th>Role</th><th>Assigned Client</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>${rest.map(row).join("") || `<tr><td colspan="6" class="mute">No other users.</td></tr>`}</tbody></table></div></section>`;
  
  $$(".sel-co", el).forEach((sel) => {
    sel.onchange = async () => {
      const id = sel.dataset.userCo, company = sel.value;
      sel.disabled = true;
      try {
        await post("/api/users/company", { id, company });
        toast(`Assigned user to client ${company.toUpperCase()}`);
      } catch (err) {
        toast(`Error: ${err.message}`, 5000);
      } finally {
        sel.disabled = false;
      }
    };
  });

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

// ---------------------------------------------------------------- audit trail & tracking (admins only)
async function pgAuditLogs(el) {
  if (!isAdmin()) { el.innerHTML = `<div class="empty"><h3>Only administrators can view audit logs</h3></div>`; return; }
  const f = S.auditFilter || (S.auditFilter = { q: "", errors: false, offset: 0, limit: 50 });
  const d = await api(`/api/admin/audit-logs?limit=${f.limit}&offset=${f.offset}&user=${encodeURIComponent(f.q)}&errors=${f.errors ? "1" : "0"}`).catch((e) => ({ error: e.message }));
  if (d.error) { el.innerHTML = banner("bad", `<b>Could not load audit logs.</b> ${esc(d.error)}`); return; }
  const logs = d.logs ?? [], total = d.total ?? 0;

  const stBadge = (code, err) => {
    if (err || code >= 400) return `<span class="pill p-bad" title="${esc(err || `HTTP ${code}`)}">${code} Error</span>`;
    return `<span class="pill p-ok">OK (${code})</span>`;
  };

  const gpsBadge = (lat, lon, acc) => (lat != null && lon != null
    ? `<div style="margin-top:3px"><a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener" class="pill p-ok" style="font-size:11px;padding:2px 6px;text-decoration:none" title="HTML5 Precise Location (accuracy ±${Math.round(acc || 0)}m)">📍 GPS: ${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}</a></div>`
    : "");

  const row = (l) => `<tr>
    <td class="small" style="white-space:nowrap">${esc(dt(l.ts))}<div class="tiny mute">${esc(ago(l.ts))}</div></td>
    <td><div class="b">${esc(l.name || l.email || "Anonymous")}</div><div class="tiny mute">${esc(l.email || "–")}</div></td>
    <td><span class="pill p-muted" style="text-transform:uppercase;font-weight:600">${esc(l.company_id || "bcg")}</span></td>
    <td><div class="b" style="color:var(--text)">${esc(l.action)}</div><div class="tiny code mute">${esc(l.method)} ${esc(l.path)} · ${l.duration_ms}ms</div>${l.error ? `<div class="tiny" style="color:var(--bad)">${esc(l.error)}</div>` : ""}</td>
    <td>${stBadge(l.status_code, l.error)}</td>
    <td><div class="small">${esc(l.location || "–")}</div><div class="tiny mute">${esc(l.ip)}</div>${gpsBadge(l.lat, l.lon, l.geo_accuracy)}</td>
    <td><div class="small">${esc(l.network || "–")}</div><div class="tiny mute" title="${esc(l.ua || "")}">${esc((l.ua || "").slice(0, 30))}…</div></td>
  </tr>`;

  el.innerHTML = `<div class="sec-h"><div><h2>User Activity & Security Audit Trail</h2><p>Track which user accessed what, when, IP address, Wi-Fi / ISP network, geographic location, and whether errors occurred.</p></div>
    <div style="display:flex;gap:8px;align-items:center">
      <input type="text" id="audit-q" placeholder="Filter by user, email, IP, client…" value="${esc(f.q)}" style="max-width:260px;font-size:13px;padding:6px 10px">
      <label class="chk" style="font-size:13px"><input type="checkbox" id="audit-err" ${f.errors ? "checked" : ""}> Errors only</label>
      <button class="btn ghost sm" id="audit-refresh">Refresh</button>
    </div></div>
    <section class="card"><div class="tw" style="max-height:none"><table class="t"><thead><tr>
      <th>Timestamp</th><th>User</th><th>Client Scoping</th><th>Action & Path</th><th>Status</th><th>Location & IP</th><th>Wi-Fi / ISP Network</th>
    </tr></thead><tbody>${logs.map(row).join("") || `<tr><td colspan="7" class="mute">No activity records found matching filter.</td></tr>`}</tbody></table></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px" class="mute">
      <span>Showing ${logs.length} of ${total} records</span>
      <div style="display:flex;gap:6px">
        ${f.offset > 0 ? `<button class="btn ghost sm" id="audit-prev">← Previous</button>` : ""}
        ${f.offset + f.limit < total ? `<button class="btn ghost sm" id="audit-next">Next →</button>` : ""}
      </div>
    </div></section>`;

  const qIn = el.querySelector("#audit-q");
  qIn?.addEventListener("keydown", (e) => { if (e.key === "Enter") { f.q = qIn.value.trim(); f.offset = 0; pgAuditLogs(el); } });
  el.querySelector("#audit-err")?.addEventListener("change", (e) => { f.errors = e.target.checked; f.offset = 0; pgAuditLogs(el); });
  el.querySelector("#audit-refresh")?.addEventListener("click", () => { f.q = qIn.value.trim(); pgAuditLogs(el); });
  el.querySelector("#audit-prev")?.addEventListener("click", () => { f.offset = Math.max(0, f.offset - f.limit); pgAuditLogs(el); });
  el.querySelector("#audit-next")?.addEventListener("click", () => { f.offset += f.limit; pgAuditLogs(el); });
}

// Small status chip linking to the data-quality tab (used in the Overview's Data confidence panel).
function qualityChip(q) {
  if (!q || !q.status) return "";
  const cls = { green: "p-ok", amber: "p-medium", red: "p-bad" }[q.status] ?? "p-muted", word = { green: "healthy", amber: "needs attention", red: "below threshold" }[q.status] ?? q.status;
  const flags = (q.flags ?? []).join(" · ");
  return `<a class="pill ${cls} dot" href="#/accuracy/quality" title="${esc(flags || "Open the data-quality checks")}" style="margin-left:6px;font-weight:600;text-decoration:none">Data quality: ${esc(word)}</a>`;
}

// ---------------------------------------------------------------- Issue Reporting & Support Tickets (For All Users)
async function pgSupport(el) {
  el.innerHTML = loading();
  const d = await api("/api/tickets").catch((e) => ({ error: e.message }));
  const tickets = d.tickets ?? [];

  const kindBadge = (k) => {
    const map = { bug: ["p-bad", "Bug Report"], feature: ["p-pos", "Feature Request"], data_issue: ["p-medium", "Data Question"], other: ["p-muted", "Support"] };
    const [cls, txt] = map[k] || ["p-muted", k];
    return `<span class="pill ${cls}">${esc(txt)}</span>`;
  };

  const statusBadge = (s) => {
    const map = { open: ["p-medium", "Open"], in_progress: ["p-pos", "In Progress"], resolved: ["p-ok", "Resolved"], closed: ["p-muted", "Closed"] };
    const [cls, txt] = map[s] || ["p-muted", s];
    return `<span class="pill ${cls} dot">${esc(txt)}</span>`;
  };

  const ticketRows = tickets.map((t) => `<tr>
    <td class="small" style="white-space:nowrap">${esc(dt(t.created_at))}<div class="tiny mute">${esc(ago(t.created_at))}</div></td>
    <td>${kindBadge(t.kind)}</td>
    <td>
      <div class="b" style="color:var(--text)">${esc(t.subject)}</div>
      <div class="small mute" style="margin-top:4px;white-space:pre-wrap">${esc(t.description)}</div>
      ${t.admin_notes ? `<div style="margin-top:6px;padding:6px 10px;background:var(--ok-bg);border-left:3px solid var(--ok);border-radius:4px" class="tiny"><b>Admin response:</b> ${esc(t.admin_notes)}</div>` : ""}
    </td>
    <td>${statusBadge(t.status)}</td>
  </tr>`).join("");

  el.innerHTML = `
    <div class="sec-h">
      <div>
        <h2>Help, Support & Feedback</h2>
        <p>Found a problem or need a new capability? Submit a ticket below. The administrator will be notified instantly via email.</p>
      </div>
    </div>

    <div class="grid g2" style="gap:20px;margin-bottom:24px">
      <section class="card" style="padding:22px">
        <h3 style="margin:0 0 6px">Raise a Ticket / Request</h3>
        <p class="small mute" style="margin:0 0 16px">Describe the issue or feature request. We track and respond to every ticket.</p>

        <form id="ticket-form" style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="small b" style="display:block;margin-bottom:4px">Category</label>
            <select id="tk-kind" class="f" style="width:100%">
              <option value="bug">Bug Report (Something is broken or showing an error)</option>
              <option value="feature">Feature Request (I would like a new tool or capability)</option>
              <option value="data_issue">Data or Forecast Question (Query regarding accuracy or coverage)</option>
              <option value="other">General Feedback / Support</option>
            </select>
          </div>

          <div>
            <label class="small b" style="display:block;margin-bottom:4px">Subject</label>
            <input type="text" id="tk-subject" class="f" placeholder="Brief summary of the issue or feature" maxlength="200" required style="width:100%">
          </div>

          <div>
            <label class="small b" style="display:block;margin-bottom:4px">Details</label>
            <textarea id="tk-desc" class="f" rows="5" placeholder="Explain what happened, steps to reproduce, or details of the feature you need…" maxlength="5000" required style="width:100%;font-family:inherit"></textarea>
          </div>

          <div style="display:flex;justify-content:flex-end">
            <button type="submit" class="btn" id="tk-submit" style="min-width:140px">Submit Ticket</button>
          </div>
        </form>
      </section>

      <section class="card" style="padding:22px">
        <h3 style="margin:0 0 6px">Direct Support & Administrator Info</h3>
        <p class="small mute" style="margin:0 0 16px">Need urgent assistance or have architectural questions?</p>
        <div style="display:flex;flex-direction:column;gap:12px;font-size:14px">
          <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
            <div class="b">Admin Contact</div>
            <div class="mute small" style="margin-top:2px">developerteam@themavericksindia.com</div>
          </div>
          <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
            <div class="b">Client Scoping Active</div>
            <div class="mute small" style="margin-top:2px">Your session is isolated to <b>${esc((S.me?.company || "BCG").toUpperCase())}</b> practice areas and data lenses.</div>
          </div>
          <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
            <div class="b">Notification Delivery</div>
            <div class="mute small" style="margin-top:2px">When you click Submit, an automated email dispatch is routed immediately to the administration team.</div>
          </div>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="sec-h" style="padding:14px 18px 8px">
        <h3 style="margin:0">Your Submitted Tickets (${tickets.length})</h3>
      </div>
      <div class="tw" style="max-height:none">
        <table class="t">
          <thead>
            <tr><th style="width:130px">Created</th><th style="width:130px">Type</th><th>Subject & Details</th><th style="width:120px">Status</th></tr>
          </thead>
          <tbody id="tk-tbody">
            ${ticketRows || `<tr><td colspan="4" class="mute" style="text-align:center;padding:24px">You haven't submitted any tickets yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const tf = el.querySelector("#ticket-form");
  tf?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el.querySelector("#tk-submit");
    const kind = el.querySelector("#tk-kind").value;
    const subject = el.querySelector("#tk-subject").value.trim();
    const description = el.querySelector("#tk-desc").value.trim();
    if (!subject || !description) return;

    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
      const res = await post("/api/tickets", {
        kind,
        subject,
        description,
        pageUrl: window.location.href
      });
      if (res.ok) {
        toast("Ticket submitted successfully! Admin has been notified.");
        pgSupport(el);
      } else {
        toast(res.error || "Could not submit ticket.");
      }
    } catch (err) {
      toast("Error sending ticket: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit Ticket";
    }
  });
}

// ---------------------------------------------------------------- Admin Ticket Management
async function pgAdminTickets(el) {
  if (!isAdmin()) { el.innerHTML = `<div class="empty"><h3>Only administrators can manage support tickets</h3></div>`; return; }
  el.innerHTML = loading();
  const d = await api("/api/tickets").catch((e) => ({ error: e.message }));
  if (d.error) { el.innerHTML = banner("bad", `<b>Could not load tickets.</b> ${esc(d.error)}`); return; }
  const tickets = d.tickets ?? [];

  const kindBadge = (k) => {
    const map = { bug: ["p-bad", "Bug Report"], feature: ["p-pos", "Feature Request"], data_issue: ["p-medium", "Data Question"], other: ["p-muted", "Support"] };
    const [cls, txt] = map[k] || ["p-muted", k];
    return `<span class="pill ${cls}">${esc(txt)}</span>`;
  };

  const statusBadge = (s) => {
    const map = { open: ["p-medium", "Open"], in_progress: ["p-pos", "In Progress"], resolved: ["p-ok", "Resolved"], closed: ["p-muted", "Closed"] };
    const [cls, txt] = map[s] || ["p-muted", s];
    return `<span class="pill ${cls} dot">${esc(txt)}</span>`;
  };

  const ticketRow = (t) => `
    <tr data-tid="${esc(t.id)}">
      <td class="small" style="white-space:nowrap">${esc(dt(t.created_at))}<div class="tiny mute">${esc(ago(t.created_at))}</div></td>
      <td>
        <div class="b">${esc(t.name || t.email)}</div>
        <div class="tiny mute">${esc(t.email)}</div>
        <div style="margin-top:2px"><span class="pill p-muted" style="text-transform:uppercase;font-size:10px">${esc(t.company_id || "bcg")}</span></div>
      </td>
      <td>${kindBadge(t.kind)}</td>
      <td>
        <div class="b" style="color:var(--text)">${esc(t.subject)}</div>
        <div class="small mute" style="margin-top:4px;white-space:pre-wrap">${esc(t.description)}</div>
        ${t.page_url ? `<div class="tiny" style="margin-top:4px"><a href="${esc(t.page_url)}" class="mute" target="_blank">View reported page</a></div>` : ""}
      </td>
      <td>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div>${statusBadge(t.status)}</div>
          <select class="f sm tk-status-sel" style="font-size:12px;padding:2px 6px">
            <option value="open"${t.status === "open" ? " selected" : ""}>Open</option>
            <option value="in_progress"${t.status === "in_progress" ? " selected" : ""}>In Progress</option>
            <option value="resolved"${t.status === "resolved" ? " selected" : ""}>Resolved</option>
            <option value="closed"${t.status === "closed" ? " selected" : ""}>Closed</option>
          </select>
        </div>
      </td>
      <td>
        <textarea class="f sm tk-notes" rows="2" placeholder="Resolution notes…" style="width:100%;font-size:12px;resize:vertical">${esc(t.admin_notes || "")}</textarea>
        <button class="btn sm ghost tk-save" style="margin-top:4px;width:100%">Update</button>
      </td>
    </tr>
  `;

  el.innerHTML = `
    <div class="sec-h">
      <div>
        <h2>User Issues & Support Tickets</h2>
        <p>Review and resolve issue tickets, bug reports, and feature requests submitted by client users.</p>
      </div>
      <div>
        <button class="btn ghost sm" id="tickets-refresh">Refresh</button>
      </div>
    </div>

    <section class="card">
      <div class="sec-h" style="padding:14px 18px 8px">
        <h3 style="margin:0">All Tickets (${tickets.length})</h3>
      </div>
      <div class="tw" style="max-height:none">
        <table class="t">
          <thead>
            <tr><th style="width:120px">Date</th><th style="width:160px">User / Client</th><th style="width:120px">Type</th><th>Subject & Details</th><th style="width:130px">Status</th><th style="width:200px">Admin Response</th></tr>
          </thead>
          <tbody>
            ${tickets.map(ticketRow).join("") || `<tr><td colspan="6" class="mute" style="text-align:center;padding:24px">No support tickets found.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;

  el.querySelector("#tickets-refresh")?.addEventListener("click", () => pgAdminTickets(el));

  el.querySelectorAll("tr[data-tid]").forEach((row) => {
    const id = row.dataset.tid;
    const saveBtn = row.querySelector(".tk-save");
    const statusSel = row.querySelector(".tk-status-sel");
    const notesIn = row.querySelector(".tk-notes");

    saveBtn?.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const res = await post("/api/tickets/update", {
          id,
          status: statusSel.value,
          notes: notesIn.value.trim()
        });
        if (res.ok) {
          toast("Ticket updated successfully.");
          pgAdminTickets(el);
        } else {
          toast(res.error || "Update failed.");
        }
      } catch (err) {
        toast("Error updating ticket: " + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Update";
      }
    });
  });
}
