// HiveMind dashboard — pages: Topic momentum, Company lens, Sources, Authors & briefs, Validation, Method.
// Loaded before app.js; uses its globals (S, api, post, esc, …) at call time.

// ---------------------------------------------------------------- Topic momentum
async function pgMomentum(el) {
  const L = await api(`/api/labels?level=${S.level}&limit=300${S.date ? `&date=${S.date}` : ""}`);
  if (L.empty) { el.innerHTML = `<div class="empty">No data yet.</div>`; return; }
  const rows = L.rows;
  if (!rows.length) {
    el.innerHTML = `<div class="ctl" style="margin-bottom:14px">${levelSeg()}</div><div class="empty"><h3>No ${S.level === "topic" ? "specific topics" : "areas"} yet</h3>${S.level === "topic" ? `<p><a href="#/trends/sectors">See the broad areas under Sectors</a> in the meantime.</p>` : ""}<p>Specific topics (like “port disruption” or “crop damage”) come from labelling stories. Use <b>Run ▾ → Label topics</b> to label the stories already read, or collect new ones (they are labelled as they are read).</p></div>`;
    bindLevelSeg(); return;
  }
  if (!S.sel || !rows.some((r) => r.key === S.sel)) { S.sel = rows[0].key; S.compare.clear(); }
  const cur = rows.find((r) => r.key === S.sel);
  el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="ctl">${levelSeg()}
    <div class="seg" id="gseg"><button data-g="hour" class="${S.gran === "hour" ? "on" : ""}">Hourly</button><button data-g="day" class="${S.gran === "day" ? "on" : ""}">Daily</button></div>
    <label>Topic <select id="tsel" style="max-width:340px">${rows.map((r) => `<option value="${esc(r.key)}"${r.key === S.sel ? " selected" : ""}>${esc(r.name)} · ${x2(r.ratio)} · ${r.stage === "watch" ? "watchlist" : r.stage}</option>`).join("")}</select></label>
    <span class="mute small">As of ${dt(L.asOf)} · recent window ${L.params.recentHours}h vs ${L.history.baselineHours}h baseline</span></div></div>
  <div class="grid g-8-4">
    <div class="card"><div class="sec-h" style="margin:0"><div><h3 id="mname"></h3><p class="hint" style="margin:0">Use hourly for breaking events and daily for longer themes.</p></div><div id="mstage"></div></div>
      <div class="cl" id="mleg"></div><div class="chart" id="mchart"><div class="skel" style="height:300px"></div></div><div id="mline"></div>
      <div class="ctl" style="margin-top:8px" id="mtog"></div><div id="mcmp" class="ctl" style="margin-top:6px"></div><p class="small mute" id="mrule" style="margin:8px 0 0"></p></div>
    <div class="grid" style="align-content:start"><div class="card"><h3>Current metrics</h3><div id="mkpi"></div></div><div class="card" id="msi"></div><div class="card" id="msoc"></div></div>
  </div>
  <div class="grid g-5-7" style="margin-top:16px"><div class="card"><h3>Recent evidence</h3><div id="mev"><div class="skel"></div></div></div>
    <div class="card flush" style="position:sticky;top:76px;align-self:start"><div style="padding:16px 16px 0"><h3>Momentum board</h3><p class="hint">Every topic ranked by momentum. Click a row to chart it.</p></div><div class="tw" style="max-height:calc(100vh - 230px)"><table class="t"><thead><tr><th>Topic</th><th>Stage</th><th class="r">Momentum${info("momentum")}</th><th class="r">Accel.${info("accel")}</th><th class="r">Share${info("share")}</th><th>Trend</th><th class="r">Origins${info("origins")}</th><th>Evidence</th></tr></thead><tbody>${rows.map((r) => `<tr class="click${r.key === S.sel ? " sel" : ""}" data-topic="${esc(r.key)}"><td class="b">${esc(r.name)}${r.parentName ? ` <span class="mute tiny">${esc(r.parentName)}</span>` : ""}</td><td>${stagePill(r.stage)}</td><td class="r num b">${x2(r.ratio)}</td><td class="r num">${r.accel == null ? "–" : (r.accel >= 0 ? "+" : "") + r.accel.toFixed(2)}</td><td class="r num">${pct(r.share)}</td><td>${spark(r.spark)}</td><td class="r num">${originsLink(r.originsRecent, r.key, r.name)}</td><td>${evPill(r.evidence)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
  bindLevelSeg();
  $$("#gseg button").forEach((b) => (b.onclick = () => { S.gran = b.dataset.g; ls.set("gran", S.gran); render(); }));
  $("#tsel").onchange = (e) => { S.sel = e.target.value; S.compare.clear(); render(); };
  $$("[data-topic]", el).forEach((r) => (r.onclick = () => { S.sel = r.dataset.topic; S.compare.clear(); window.scrollTo(0, 0); render(); }));

  $("#mname").innerHTML = esc(cur.name) + info("momentumChart");
  $("#mstage").innerHTML = `${stagePill(cur.stage)} ${evPill(cur.evidence)}`;
  $("#mrule").innerHTML = `<b>Stage rule:</b> ${esc(cur.stageRule)}`;
  $("#mkpi").innerHTML = [["Coverage share", pct(cur.share), `baseline ${pct(cur.baseShare)}`], ["Momentum", x2(cur.ratio), `previous step ${x2(cur.ratioPrev)}`], ["Acceleration", cur.accel == null ? "–" : (cur.accel >= 0 ? "+" : "") + cur.accel.toFixed(2), "Δ log₂ momentum"], ["Coverage volume", cur.count, `of ${n0(cur.total)} stories in ${cur.windowHours}h`], ["Independent origins", cur.originsRecent, `${cur.originsTotal} over the whole window`], ["Impact breadth", cur.areaCount, (cur.areas || []).slice(0, 3).join(", ") || "impact areas"]].map(([l, v, s]) => `<div class="compo" style="grid-template-columns:150px 1fr"><span>${lbl(l, { ...DRAWER_TIP, "Coverage volume": "stories" }[l])}</span><span><b class="num">${l === "Independent origins" ? originsLink(v, cur.key, cur.name) : v}</b> <span class="mute tiny">${esc(s)}</span></span></div>`).join("");
  const sels = [S.sel, ...S.compare];
  const [ser, top] = await Promise.all([api(`/api/series?keys=${sels.map(encodeURIComponent).join(",")}&gran=${S.gran}${S.date ? `&date=${S.date}` : ""}`), api(`/api/topic?${qs(`&key=${encodeURIComponent(S.sel)}`)}`)]);
  const main = ser.series[S.sel], cmps = [...S.compare].map((k) => ({ name: ser.series[k]?.name ?? k, s: ser.series[k] })).filter((c) => c.s);
  const draw = () => {
    momentum($("#mchart"), main, { compare: cmps, show: S.show });
    $("#mleg").innerHTML = `<span><i style="background:var(--bars-strong);opacity:.7"></i>coverage volume (stories)</span><span><i class="ln" style="background:var(--line-share)"></i>coverage share</span><span><i class="ln" style="background:var(--line-avg)"></i>${main.rollingWindow}${S.gran === "day" ? "-day" : "h"} rolling average</span>${cmps.map((c, i) => `<span><i class="ln" style="background:${HC.PAL[i % 4]}"></i>${esc(c.name)} (share)</span>`).join("")}<span><i class="dash"></i>forecast (unvalidated)</span><span>◆ verified trigger</span>`;
  };
  $("#mtog").innerHTML = [["bars", "Volume bars"], ["share", "Coverage share"], ["avg", "Rolling average"], ["forecast", "Forecast"]].map(([k, l]) => `<label class="chk"><input type="checkbox" data-sh="${k}" ${S.show[k] ? "checked" : ""}> ${l}</label>`).join("") + (main.forecast.available ? "" : `<span class="small mute">Forecast unavailable: ${esc(main.forecast.reason)}</span>`);
  $$("[data-sh]").forEach((c) => (c.onchange = () => { S.show[c.dataset.sh] = c.checked; draw(); }));
  $("#mcmp").innerHTML = `<span class="small mute">Compare with:</span>${(top.related ?? []).slice(0, 6).map((r) => `<label class="chk"><input type="checkbox" data-cmp="${esc(r.key)}" ${S.compare.has(r.key) ? "checked" : ""}> ${esc(r.name)}</label>`).join("") || `<span class="small mute">no overlapping topics</span>`}`;
  $$("[data-cmp]").forEach((c) => (c.onchange = () => { c.checked ? S.compare.add(c.dataset.cmp) : S.compare.delete(c.dataset.cmp); render(); }));
  draw();
  $("#mline").innerHTML = xForecastLine(main, { ...cur, baselineHours: L.history?.baselineHours });
  $("#mrule").innerHTML += ` ${xSeasonChip(top.seasonality)}`;
  if (top.sentiment) $("#mkpi").insertAdjacentHTML("beforeend", `<div style="margin-top:10px"><span class="tiny mute b">SENTIMENT${info("sentimentNet")}</span>${xSentStrip(top.sentiment)}</div>`);
  $("#mev").innerHTML = top.stories.map((s) => `<div class="story"><a class="h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><div style="margin:3px 0">${s.verified ? `<span class="pill p-ok">verified</span> ` : ""}${s.primary ? `<span class="pill p-high">primary source</span> ` : ""}<span class="tag">${s.outlets} outlets → ${s.origins} origin${s.origins > 1 ? "s" : ""}</span><span class="tag">${s.fullText ? "full text" : "headline only"}</span>${s.contentType ? `<span class="tag">${esc(s.contentType)}</span>` : ""}<span class="tag">${dt(s.publishedAt)}</span></div>${s.summary ? `<div class="small mute">${esc(s.summary)}</div>` : ""}</div>`).join("") || `<span class="mute">No stories in the last 72h.</span>`;
  // search interest: a separate panel in its own units
  const si = top.searchInterest;
  $("#msi").innerHTML = `<h3>Search interest${info("searchInterest")} <span class="pill p-muted">separate signal</span></h3><p class="hint">Google Trends-style values are relative (0–100), not search counts, and have their own baseline.</p><div id="sibody"></div>`;
  if (si.available) { $("#sibody").innerHTML = `<div class="chart" id="sich"></div><p class="tiny mute">${esc(si.source)} · ${esc(si.note)}</p>`; HC.lineChart($("#sich"), si.points); }
  else {
    $("#sibody").innerHTML = `<div class="empty" style="padding:16px"><b>Unavailable</b><div class="small" style="margin-top:4px">${esc(si.reason)}</div></div>
      <details style="margin-top:10px"><summary class="small">Import a series</summary><p class="tiny mute">CSV <span class="code">topic,date,value</span> or JSON from a Trends export. Use consistent query settings (region, window).</p><textarea id="sitext" placeholder="topic,date,value&#10;${esc(cur.name.toLowerCase())},2026-10-20,35"></textarea><button class="btn sm" id="siup" style="margin-top:6px">Import</button> ${S.status.searchInterest.configured ? `<button class="btn ghost sm" id="sifetch2" style="margin-top:6px">Fetch via SerpApi</button>` : ""}</details>`;
    $("#siup").onclick = async () => { try { await post("/api/search-interest", { text: $("#sitext").value }); toast("Imported"); render(); } catch (e) { toast(e.message); } };
    const f = $("#sifetch2"); if (f) f.onclick = async () => { f.disabled = true; try { await post("/api/search-interest", { topic: cur.name }); render(); } catch (e) { toast(e.message); f.disabled = false; } };
  }

  // X (Twitter) social pulse
  const msoc = $("#msoc");
  if (msoc) {
    msoc.innerHTML = `<h3>X (Twitter) Social Pulse${info("social")} <span class="pill p-muted">social signal</span></h3><p class="hint">Hourly post volume (official X API v2). Kept separate from news coverage.</p><div id="msocbody"><div class="skel" style="height:100px"></div></div>`;
    try {
      const sr = await api(`/api/social?key=${encodeURIComponent(cur.key)}&name=${encodeURIComponent(cur.name)}`);
      if (sr.available && sr.points?.length) {
        $("#msocbody").innerHTML = `<div class="chart" id="msocchart"></div><div class="tiny mute" style="margin-top:6px">24h volume: <b>${n0(sr.stats?.recent24h ?? 0)}</b> · momentum: <b>${x2(sr.stats?.ratio)}</b> · peak: <b>${n0(sr.stats?.peakHour ?? 0)}/hr</b></div><button class="btn ghost sm" id="msoctoggle" style="margin-top:8px">↻ Refresh X data</button>`;
        HC.socialChart($("#msocchart"), sr.points, { baseline: sr.stats?.baselineDaily });
        $("#msoctoggle").onclick = async () => {
          $("#msoctoggle").disabled = true;
          try { await post("/api/social/fetch", { name: cur.name, level: S.level }); toast("Refreshed X data"); render(); } catch (e) { toast(e.message); }
        };
      } else {
        $("#msocbody").innerHTML = `<div class="empty" style="padding:14px"><b>${sr.active ? "No social data fetched yet" : "X API inactive"}</b><div class="small mute" style="margin-top:4px">${esc(sr.reason)}</div></div>${sr.active ? `<button class="btn sm" id="msoctoggle" style="margin-top:8px">Fetch X tweet volume</button>` : `<a class="btn ghost sm" href="#/settings" style="margin-top:8px">Configure in Settings →</a>`}`;
        const f = $("#msoctoggle");
        if (f) f.onclick = async () => {
          f.disabled = true; f.textContent = "Fetching…";
          try { await post("/api/social/fetch", { name: cur.name, level: S.level }); toast("Fetched X data"); render(); } catch (e) { toast(e.message); f.disabled = false; f.textContent = "Fetch X tweet volume"; }
        };
      }
    } catch (e) {
      $("#msocbody").innerHTML = `<div class="small mute">Could not load social pulse: ${esc(e.message)}</div>`;
    }
  }
}
const levelSeg = () => "";
const bindLevelSeg = () => {};

// ---------------------------------------------------------------- Company lens
async function pgSectors(el) {
  const d = await api(`/api/state?company=${encodeURIComponent(S.company)}${S.date ? `&date=${S.date}` : ""}`);
  if (d.empty) { el.innerHTML = `<div class="empty">No analysed stories for this view yet.</div>`; return; }
  const c = d.company;
  if (!c) { el.innerHTML = `<div class="empty">Pick a company in the top bar.</div>`; return; }
  const { done, total } = c.matching;
  if (!S.selSector || !c.sectorsView.some((s) => s.name === S.selSector)) S.selSector = c.sectorsView[0]?.name;
  const sel = c.sectorsView.find((s) => s.name === S.selSector);
  const mx = Math.max(...c.sectorsView.map((s) => s.total), 1e-9);
  const every = Math.ceil(d.bins.length / 8), colL = d.bins.map((t, i) => (i % every ? "" : new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "numeric" })));
  el.innerHTML = `${!d.llm.ok ? banner("warn", `Matching is off: ${esc(d.llm.message)}`) : ""}
  <div class="card"><div class="sec-h" style="margin:0"><div><h3>${esc(c.name)} <span class="mute" style="font-weight:400">· ${c.sectors.length} sectors</span></h3><p class="hint" style="margin:0">${c.sectors.map((s) => esc(s.name)).join(" · ")}</p></div>${c.builtin ? "" : `<button class="btn bad sm" id="cdel">Remove company</button>`}</div>
    ${done < total && d.llm.ok ? `<p class="small mute" style="margin:10px 0 4px">Matching news areas to ${esc(c.name)}’s sectors: ${done}/${total} judged</p><div class="bar"><i style="width:${(100 * done) / Math.max(1, total)}%"></i></div>` : ""}
    <details style="margin-top:12px"><summary>Upload or paste another company’s sectors</summary><div class="grid g2" style="margin-top:10px"><div><p class="small mute">Accepted: <b>.csv</b> (a <span class="code">sector</span> column, optional <span class="code">description</span>), <b>.txt</b> (one sector per line; first line may be <span class="code">Company: Name</span>) or <b>.json</b>. Uploading the same name again replaces its sectors.</p><label class="f">Company name</label><input type="text" id="uname"><label class="f">File</label><input type="file" id="ufile" accept=".csv,.txt,.json"></div><div><label class="f">…or paste sectors, one per line</label><textarea id="utext" placeholder="Retail banking&#10;General insurance&#10;Consumer lending"></textarea><p style="margin:8px 0 0"><button class="btn" id="usend">Analyse company</button> <span class="small mute" id="ustatus"></span></p></div></div></details></div>
  <section class="grid g-7-5" style="margin-top:16px">
    <div class="card"><h3>Exposure by sector</h3><p class="hint">Σ news-area density × relevance. <span class="cl" style="display:inline-flex;margin:0 0 0 8px"><span><i style="background:var(--bars-strong)"></i>direct</span><span><i style="background:var(--forecast)"></i>indirect (second-order)</span></span></p>
      ${c.sectorsView.map((s) => `<div class="hb click${s.name === S.selSector ? " sel" : ""}" data-sector="${esc(s.name)}" style="${s.name === S.selSector ? "background:var(--brand-soft)" : ""}"><span title="${esc(s.name)}">${esc(clip(s.name, 28))}</span><div class="bar" style="display:flex;background:var(--line)"><i style="width:${(100 * s.direct) / mx}%;background:var(--bars-strong);border-radius:3px 0 0 3px"></i><i style="width:${(100 * s.indirect) / mx}%;background:var(--forecast);border-radius:0 3px 3px 0"></i></div><span class="num small" style="text-align:right">${fmt1(s.total)}</span></div>`).join("")}</div>
    <div class="card"><h3>${esc(sel?.name ?? "Sector")} — drivers</h3>${sel?.description ? `<p class="small mute">${esc(sel.description)}</p>` : ""}${sel?.drivers.length ? sel.drivers.map((x) => `<div class="story"><b>${esc(x.name)}</b><div style="margin:3px 0"><span class="tag">${esc(x.channel)}</span><span class="tag">${esc(x.front.replace("_", " "))}</span><span class="tag">relevance ${x.relevance.toFixed(1)}</span></div><div class="small mute">${esc(x.why)}</div>${x.writeAbout ? `<div class="small" style="margin-top:3px">${esc(x.writeAbout)}</div>` : ""}</div>`).join("") : `<span class="mute">No news areas matched this sector yet.</span>`}</div>
  </section>
  <section class="grid g2" style="margin-top:16px"><div class="card"><h3>Sector density over time</h3><p class="hint">Darker = more weighted news pressure in that window.</p><div id="stime"></div></div><div class="card"><h3>At what front?</h3><p class="hint">Sector × the channel through which the impact reaches it.</p><div id="sfronts"></div></div></section>
  <section class="grid g3" style="margin-top:16px"><div class="card"><h3>Who and what is impacted</h3>${hbars(d.impactAreas.slice(0, 12), { label: (a) => a[0], value: (a) => a[1] })}</div><div class="card"><h3>Most-affected groups</h3><table class="t"><tbody>${d.groups.slice(0, 10).map((g) => `<tr><td>${esc(clip(g.group, 40))}</td><td class="mute small">${esc(g.area)}</td><td class="r num">${fmt1(g.weight)}</td></tr>`).join("")}</tbody></table></div><div class="card"><h3>Geography</h3>${hbars(d.geography.slice(0, 12), { label: (a) => a[0], value: (a) => a[1], color: () => "var(--forecast)" })}</div></section>
  <section class="card" style="margin-top:16px"><h3>Broad-area density over time</h3><p class="hint">Top 20 impact brackets × time.</p><div id="btime"></div></section>`;
  $$("[data-sector]", el).forEach((r) => (r.onclick = () => { S.selSector = r.dataset.sector; render(); }));
  heat($("#stime"), c.sectorsView.map((s) => ({ label: s.name, values: s.series })), colL, (k) => new Date(d.bins[k]).toLocaleString(), { W: 640, L: 170 });
  heat($("#sfronts"), c.sectorsView.map((s) => ({ label: s.name, values: c.fronts.map((f) => s.fronts[f] || 0) })), c.fronts.map((f) => f.replace("_", " ").slice(0, 8)), (k) => c.fronts[k], { W: 640, L: 170 });
  heat($("#btime"), d.brackets.slice(0, 20).map((b) => ({ label: b.name, values: b.series })), colL, (k) => new Date(d.bins[k]).toLocaleString());
  if ($("#cdel")) $("#cdel").onclick = async () => { if (!confirm("Remove this company and its matches?")) return; await fetch("/api/company?id=" + encodeURIComponent(S.company), { method: "DELETE" }); S.company = "bcg"; ls.set("company", "bcg"); await loadStatusOnce(); render(); };
  $("#ufile").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $("#utext").value = await f.text(); if (!$("#uname").value) $("#uname").value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "); };
  $("#usend").onclick = async () => {
    const st = $("#ustatus"); st.textContent = "Uploading…"; $("#usend").disabled = true;
    try { const j = await post("/api/company", { name: $("#uname").value, text: $("#utext").value }); S.company = j.id; ls.set("company", j.id); S.selSector = null; await loadStatusOnce(); toast(`Added ${j.name} with ${j.sectors.length} sectors`); render(); }
    catch (e) { st.textContent = e.message; $("#usend").disabled = false; }
  };
}
const fmt1 = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

// ---------------------------------------------------------------- Sources & collection
async function pgSources(el) {
  const s = await api(`/api/sources?${S.date ? `date=${S.date}` : ""}`);
  const sy = s.syndication, types = { primary: 0, newsroom: 0, trade: 0 };
  s.sources.forEach((x) => { types[x.type] = (types[x.type] || 0) + 1; });
  const dup = sy.outletMentions ? 1 - sy.independentOrigins / sy.outletMentions : 0;
  el.innerHTML = `<div class="kpis"><div class="kpi"><div class="v num">${s.sources.length}</div><div class="l">${lbl("Approved sources", "sources")}</div><div class="s">${types.primary} primary · ${types.newsroom} newsroom · ${types.trade} trade</div></div>
    <div class="kpi"><div class="v num">${s.groups.length}</div><div class="l">Ownership groups</div><div class="s">outlets in one group count as one origin</div></div>
    <div class="kpi"><div class="v num">${n0(sy.outletMentions)}</div><div class="l">Outlet mentions</div><div class="s">→ ${n0(sy.independentOrigins)} independent origins</div></div>
    <div class="kpi"><div class="v num">${n0(sy.multiOutletStories)}</div><div class="l">Multi-outlet stories</div><div class="s">${n0(sy.singleOriginRepeats)} are repeats from one origin</div></div>
    <div class="kpi"><div class="v num">${n0(sy.wireCredited)}</div><div class="l">Wire-credited</div><div class="s">${sy.wireCredited ? "PTI / ANI / Reuters etc." : "none detected yet"}</div></div>
    <div class="kpi"><div class="v num">${n0(sy.primarySourced)}</div><div class="l">Primary-sourced stories</div><div class="s">regulators, ministries, weather agency</div></div></div>
  ${sy.stories && !sy.primarySourced ? banner("info", `No story from a primary source (PIB, RBI, IMD, SEBI) has been collected yet. They were added to the source list; the next collection run will pull them in.`) : ""}
  <section style="margin-top:16px" class="card flush"><div style="padding:16px 16px 0"><h3>Approved source list</h3><p class="hint">Each source is recorded with why it is trusted. Review periodically. Polled through Google News (<span class="code">site:</span> queries); a licensed feed or API would be stronger.</p></div><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Source</th><th>Type</th><th>Group</th><th>Geography</th><th>Why trusted</th><th class="r">24h</th><th class="r">7d</th><th>Last seen</th></tr></thead><tbody>${s.sources.map((x) => `<tr><td class="b">${esc(x.name)}<div class="tiny mute">${esc(x.domain)}</div></td><td><span class="pill ${x.type === "primary" ? "p-high" : x.type === "trade" ? "p-info" : "p-muted"}">${esc(x.type)}</span></td><td class="small">${esc(x.group)}</td><td class="small">${esc(x.geography)}</td><td class="small" style="max-width:340px">${esc(x.trust)}</td><td class="r num">${n0(x.headlines24h)}</td><td class="r num">${n0(x.headlines7d)}</td><td class="small">${x.lastSeen ? ago(x.lastSeen) : '<span class="mute">never</span>'}</td></tr>`).join("")}</tbody></table></div></section>
  <section class="grid g2" style="margin-top:16px"><div class="card"><h3>Independence of coverage</h3><p class="hint">Ten websites repeating one report are not ten confirmations.</p>
    <div class="compo" style="grid-template-columns:150px 1fr 70px"><span>Outlet mentions</span><div class="bar"><i style="width:100%"></i></div><span class="num">${n0(sy.outletMentions)}</span></div>
    <div class="compo" style="grid-template-columns:150px 1fr 70px"><span>Independent origins</span><div class="bar"><i style="width:${(100 * sy.independentOrigins) / Math.max(1, sy.outletMentions)}%"></i></div><span class="num">${originsLink(n0(sy.independentOrigins), "all", "All collected stories")}</span></div>
    <p class="small mute" style="margin:8px 0 0">${(dup * 100).toFixed(1)}% of outlet mentions were repeats of an origin already counted. ${sy.wireCredited ? "" : "Wire credits are only detectable when the article body is read, so this is a lower bound for stories read from headlines."}</p>
    <h3 style="margin-top:16px">Headlines by ownership group (7d)</h3>${hbars(s.groups.slice(0, 10), { label: (g) => g.group, value: (g) => g.headlines })}</div>
    <div class="card"><h3>Collection health</h3><p class="hint">Outages are fully elapsed hours with almost nothing collected; charts show them hatched and baselines skip them.</p>
      ${s.outages.length ? `<div class="legend" style="margin:0 0 8px">${s.outages.slice(-10).map((o) => `<span class="pill p-bad">${dt(o.from)} · ${o.total} stories</span>`).join(" ")}</div>` : `<div class="pill p-ok">No collection gaps in the analysis window</div>`}
      <h3 style="margin-top:14px">Run history</h3><div class="tw" style="max-height:280px"><table class="t"><thead><tr><th>Started</th><th>Scope</th><th class="r">Headlines</th><th class="r">Stories</th><th>Result</th></tr></thead><tbody>${s.runs.map((r) => `<tr><td class="small">${dt(r.startedAt)}</td><td class="small">${r.targetDate ? fmtDay(r.targetDate) : "last 24h"}</td><td class="r num">${n0(r.headlines)}</td><td class="r num">${n0(r.done)}/${n0(r.total)}</td><td class="small">${r.finishedAt ? `<span class="pill p-ok">done${r.durationMin ? ` · ${Math.round(r.durationMin)} min` : ""}</span>` : `<span class="pill p-muted">unfinished</span>`}${r.failedSources.length ? ` <span class="pill p-bad" title="${esc(r.failedSources.join(", "))}">${r.failedSources.length} source(s) returned nothing</span>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="mute">No runs recorded.</td></tr>`}</tbody></table></div></div></section>`;
}

// ---------------------------------------------------------------- Leadership
// One page for leaders: what is trending and why, what people are writing about it (print and online), what nobody has written, what is next.
// Everything comes from /api/leadership, which is computed from the database: opening this page makes no model call and no web request.
async function pgLeadership(el) {
  // The page is fetched once and kept for a minute: switching tabs only swaps the list, with no request and no redraw of the rest.
  const C = (S.ld ??= { data: null, at: 0, origins: new Map() });
  if (!C.data || Date.now() - C.at > 60e3 || C.mode !== S.opp.mode) {
    if (!el.firstElementChild) el.innerHTML = '<div class="skel" style="height:96px"></div><div class="skel" style="height:360px;margin-top:16px"></div>';
    C.data = await api("/api/leadership?mode=" + encodeURIComponent(S.opp.mode)); C.at = Date.now(); C.mode = S.opp.mode; C.origins.clear();
  }
  const L = C.data;
  if (L.empty) { el.innerHTML = '<div class="empty"><h3>No data yet</h3><p>The Leadership view appears once the first collection has finished.</p></div>'; return; }
  const c = L.counts, o = L.online;
  const ageH = (h) => (h < 48 ? Math.round(h) + " h ago" : Math.round(h / 24) + " days ago");
  const link = (t, u) => (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + "</a>" : esc(t));
  // the chip is the count of pieces; clicking it lists them all
  const chip = (r) => (r.print + r.online ? '<button type="button" class="pill p-muted" data-pieces="' + esc(r.key) + '" style="cursor:pointer;white-space:nowrap;border:0" title="Show all ' + (r.print + r.online) + ' pieces">' + r.print + " print · " + r.online + " online</button>" : '<span class="small mute" style="white-space:nowrap">none yet</span>');
  // "N independent sources": opens the sources behind it, each with its articles as links (loaded when opened, then kept)
  const sources = (r, open) => (r.sources ? '<details class="ldsrc" data-key="' + esc(r.labelKey) + '"' + (open ? " open" : "") + ' style="margin-top:6px"><summary class="small" style="cursor:pointer;color:var(--accent,#2563eb)">' + r.sources + ' independent sources</summary><div class="ldsrc-body small mute" style="margin:6px 0 0 4px">Loading…</div></details>' : "");
  const row = (r, { trigger = false, open = false } = {}) =>
    '<div style="display:flex;gap:16px;justify-content:space-between;align-items:flex-start;padding:16px 0;border-top:1px solid var(--line)"><div style="min-width:0;flex:1">' +
    '<div style="font-weight:600;font-size:15px">' + esc(r.topic) + ' <span class="mute" style="font-weight:400">· ' + esc(r.sector) + "</span></div>" +
    '<div class="small" style="margin-top:3px">' + esc(clip(r.angle || "", 130)) + "</div>" +
    '<div class="small mute" style="margin-top:5px">' + esc(r.why || "momentum building") + "</div>" +
    (trigger && r.trigger ? '<div class="small mute" style="margin-top:3px">Set off by ' + link(clip(r.trigger.title, 80), r.trigger.url) + " · " + ageH(r.trigger.ageHours) + (r.trigger.verified ? "" : " · unverified") + "</div>" : "") +
    sources(r, open) + "</div>" + chip(r) + "</div>";
  const empty = (t) => '<p class="small mute" style="margin:18px 0 6px">' + t + "</p>";
  const TABS = [
    ["trending", "Trending now", L.top.length, "The highest-scoring rising angles and what set them off.", () => L.top.map((r) => row(r, { trigger: true })).join("") || empty("Nothing is rising right now.")],
    ["written", "Written about", c.written, "Trending angles that opinion and analysis writers have already taken up, most written first.", () => L.written.map((r) => row(r)).join("") || empty("No trending angle has an opinion or analysis piece yet.")],
    ["open", "Not yet written", c.open, "Trending, but no opinion or analysis piece found in print or online. Open “independent sources” to see every source and its articles.", () => L.open.map((r) => row(r)).join("") || empty("Every trending angle has at least one piece.")],
    ["next", "Next up", L.next.length, "Emerging or speeding up: likely to be bigger soon. Open “independent sources” to see every source and its articles.", () => L.next.map((r) => row(r)).join("") || empty("No angle is clearly accelerating.")],
    ["hot", "Hot right now", L.hot.length, "Trending angles already checked against the wider web: the web articles found, then open “independent sources” for every source and article of ours.", () => L.hot.map((r) => '<div style="padding:16px 0;border-top:1px solid var(--line)"><div style="font-weight:600;font-size:15px">' + esc(r.topic) + ' <span class="mute" style="font-weight:400">· ' + esc(r.sector) + '</span></div><div class="small mute" style="margin-top:3px">' + r.web.total + " web articles from " + r.web.outlets + " outlets" + (r.web.outside ? ", " + r.web.outside + " outside our sources" : "") + " · checked " + ago(r.web.at) + "</div>" + r.web.top.map((t) => '<div class="small" style="margin-top:4px">' + link(clip(t.title, 110), t.link) + ' <span class="mute">· ' + esc(t.source || "") + "</span></div>").join("") + sources(r, false) + "</div>").join("") || empty("No web check has been run for the current top angles.")],
  ];
  const draw = () => {
    const cur = TABS.find((t) => t[0] === S.ldTab) ?? TABS[0];
    S.ldTab = cur[0];
    $$("#ldtab button", el).forEach((b) => b.classList.toggle("on", b.dataset.t === cur[0]));
    $("#ldpanel", el).innerHTML = '<p class="small mute" style="margin:0 0 6px">' + cur[3] + "</p>" + cur[4]();
    $$("details.ldsrc", el).forEach((d) => {
      const fill = async () => {
        const body = $(".ldsrc-body", d); if (d.dataset.done) return; d.dataset.done = "1";
        let r = C.origins.get(d.dataset.key);
        if (!r) { try { r = await api("/api/origins?key=" + encodeURIComponent(d.dataset.key)); C.origins.set(d.dataset.key, r); } catch (e) { body.textContent = e.message; return; } }
        const when = (t) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
        body.innerHTML = (r.origins ?? []).map((g) => '<div style="margin:0 0 10px"><div><b style="color:var(--text,inherit)">' + esc(g.name) + '</b> <span class="tiny">' + g.stories + " stor" + (g.stories === 1 ? "y" : "ies") + "</span></div>" + (g.items?.length ? g.items : g.sample ?? []).map((x) => '<div style="margin:2px 0">' + link(x.title, x.url) + ' <span class="tiny">' + when(x.at) + "</span></div>").join("") + "</div>").join("") || "No sources found.";
      };
      d.addEventListener("toggle", () => { if (d.open) fill(); });
      if (d.open) fill();
    });
  };
  if (!$("#ldtab", el)) {
    el.innerHTML =
      '<details class="small mute" style="margin:0 0 14px"><summary style="cursor:pointer">How to read this page</summary><p style="margin:8px 0 0;max-width:760px">“Trending” means a topic is rising or emerging in the news right now. “Written about” means opinion or analysis pieces on that angle exist in the print editions or online in the last ' + L.windowDays + " days; “not yet written” means none were found in either. " +
      (o.analyze ? "Reading the text of online pieces runs after each collection." : "Online pieces are counted from the news reading’s own labels until you read their text (button at the bottom).") + "</p></details>" +
      '<div class="kpis"><div class="kpi"><div class="v num">' + n0(c.trending) + '</div><div class="l">Trending angles</div></div>' +
      '<div class="kpi"><div class="v num">' + n0(c.written) + '</div><div class="l">Already written about</div><div class="s">' + n0(c.print) + " print · " + n0(c.online) + " online</div></div>" +
      '<div class="kpi"><div class="v num">' + n0(c.open) + '</div><div class="l">Not yet written</div></div></div>' +
      '<section class="card" style="margin-top:16px;padding:20px 24px"><div class="seg" id="ldtab" style="margin-bottom:12px">' + TABS.map((t) => '<button data-t="' + t[0] + '">' + t[1] + ' <span class="mute">' + t[2] + "</span></button>").join("") + '</div><div id="ldpanel"></div></section>' +
      '<p class="small mute" style="margin:16px 4px 0">Online pieces: ' + n0(o.checked) + " read in the last 7 days (" + n0(o.authored) + " confirmed) · " + o.readToday + " of " + o.dailyCap + ' read today. <button class="btn ghost sm" id="ldAnalyse" style="margin-left:6px">Read online pieces now</button> <span class="mute">Groq only, only pieces not yet read, never more than the daily cap.</span></p>';
    $$("#ldtab button", el).forEach((b) => (b.onclick = () => { S.ldTab = b.dataset.t; draw(); }));
    $("#ldAnalyse").onclick = async () => {
      try { await post("/api/job", { kind: "online" }); C.at = 0; toast("Reading online pieces… the page updates when it finishes (Settings → Logs shows progress)."); } catch (e) { toast(e.message); }
    };
  }
  draw();
}

// ---------------------------------------------------------------- Authored articles & briefs
// Opinion and analysis pieces from the print editions (src/ocr.mjs). Takes the place of the journalist directory, and keeps the brief approval queue.
async function pgAuthored(el) {
  const f = (S.af ??= { q: "", source: "", kind: "authored", matched: "", offset: 0 }), enc = encodeURIComponent, PER = 25;
  const [st, L, B] = await Promise.all([
    api("/api/authored/status"),
    api("/api/authored?facets=1&limit=" + PER + "&offset=" + f.offset + "&q=" + enc(f.q) + "&source=" + enc(f.source) + "&kind=" + enc(f.kind) + "&matched=" + enc(f.matched)),
    api("/api/briefs"),
  ]);
  const c = st.counts, bs = B.stats, decided = (bs.approved || 0) + (bs.rejected || 0) + (bs.needs_evidence || 0);
  const kindPill = (k) => '<span class="pill ' + (k === "opinion" ? "p-ok" : k === "analysis" ? "p-medium" : "p-muted") + '">' + esc(k) + '</span>';
  const domId = (id) => "ad-" + String(id).replace(/\W+/g, "_");
  el.innerHTML = banner("info", "<b>What this counts.</b> Opinion and analysis pieces read from the newspapers' print editions: a named writer's view or argument, an editorial, or an interpretive piece. Reported news does not count, even with a reporter's name on it. Each piece is matched to the suggested angle it takes up, and the number of pieces per angle is the headroom on the Opportunities page: <i>Nobody has written it</i> scores angles higher when fewer pieces exist, <i>Others have written it</i> scores them higher when more do.") +
  (c.total ? "" : banner("warn", 'No print editions have been read yet. Run <span class="code">node src/cli.mjs ocr</span> to download them and find the authored pieces.')) +
  '<div class="kpis"><div class="kpi"><div class="v num">' + n0(c.total) + '</div><div class="l">Print articles read</div><div class="s">' + esc(c.first || "–") + ' to ' + esc(c.last || "–") + '</div></div>' +
  '<div class="kpi"><div class="v num">' + n0(c.authored) + '</div><div class="l">Authored pieces</div><div class="s">' + n0(c.opinion) + ' opinion · ' + n0(c.analysis) + ' analysis</div></div>' +
  '<div class="kpi"><div class="v num">' + n0(c.matched) + '</div><div class="l">Matched to an angle</div><div class="s">' + n0(c.authored - c.matched) + ' take up no current angle</div></div>' +
  '<div class="kpi"><div class="v num">' + (bs.pending || 0) + '</div><div class="l">Briefs awaiting an editor</div><div class="s">' + (bs.approved || 0) + ' approved · ' + decided + ' decided</div></div></div>' +
  '<div class="card flush"><div style="padding:14px 16px;border-bottom:1px solid var(--line)"><div class="ctl"><input type="text" id="aq" placeholder="Search headline, writer or text…" value="' + esc(f.q) + '" style="max-width:320px">' +
  '<label>Paper <select id="asrc"><option value="">All</option>' + st.sources.map((x) => '<option value="' + esc(x.source) + '"' + (x.source === f.source ? " selected" : "") + '>' + esc(x.source) + ' (' + (x.authored || 0) + ')</option>').join("") + '</select></label>' +
  '<label>Kind <select id="akind">' + [["authored", "Opinion + analysis"], ["opinion", "Opinion only"], ["analysis", "Analysis only"], ["news", "Reported news (for checking)"]].map(([k, t]) => '<option value="' + k + '"' + (k === f.kind ? " selected" : "") + '>' + t + '</option>').join("") + '</select></label>' +
  '<label>Angle <select id="amatch">' + [["", "Any"], ["1", "Takes up a suggested angle"], ["0", "No current angle"]].map(([k, t]) => '<option value="' + k + '"' + (k === f.matched ? " selected" : "") + '>' + t + '</option>').join("") + '</select></label>' +
  '<span class="mute small">' + n0(L.total) + ' match</span></div></div>' +
  '<div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Piece</th><th>Writer</th><th>Paper</th><th>Date</th><th>Kind</th><th>Suggested angle it takes up</th></tr></thead><tbody>' +
  (L.rows.map((a) => '<tr class="click" data-a="' + esc(a.id) + '"><td style="max-width:380px"><span class="b">' + esc(a.headline) + '</span>' + titleTag(a) + (a.page ? '<div class="tiny mute">page ' + a.page + '</div>' : "") + '</td><td class="small" style="min-width:130px">' + (a.author ? '<b>' + esc(a.author) + '</b>' : '<span class="mute" title="No writer is printed: an unsigned editorial or a desk-written piece">unsigned</span>') + '</td><td class="small">' + esc(a.source) + '</td><td class="small">' + esc(a.date) + '</td><td>' + kindPill(a.kind) + '</td><td class="small" style="max-width:380px">' +
      (a.matches.length ? a.matches.slice(0, 2).map((m) => '<div><b>' + esc(m.sector) + '</b>: ' + esc(clip(m.angle || "", 120)) + ' <span class="mute tiny">fit ' + Number(m.fit).toFixed(2) + '</span></div>').join("") : '<span class="mute">none</span>') + '</td></tr>' +
    '<tr class="ad" id="' + domId(a.id) + '" style="display:none"><td colspan="6" style="background:var(--surface2)">' + (a.why ? '<div class="small"><b>Why it was judged ' + esc(a.kind) + ':</b> ' + esc(a.why) + '</div>' : "") + '<div class="small mute" style="margin-top:6px;white-space:pre-wrap">' + esc(a.excerpt) + (a.words > 150 ? " …" : "") + '</div><button class="btn sm" style="margin-top:8px" data-read="' + esc(a.id) + '">Read full article</button>' + (a.matches.length > 2 ? '<div class="small" style="margin-top:6px">' + a.matches.slice(2).map((m) => '<div><b>' + esc(m.sector) + '</b>: ' + esc(clip(m.angle || "", 160)) + '</div>').join("") + '</div>' : "") + '</td></tr>').join("") || '<tr><td colspan="6" class="mute" style="text-align:center;padding:22px">Nothing matches these filters.</td></tr>') +
  '</tbody></table></div><div class="ctl" style="padding:10px 16px;justify-content:space-between;border-top:1px solid var(--line)"><span class="small mute">Showing ' + (L.total ? f.offset + 1 : 0) + '–' + Math.min(L.total, f.offset + PER) + ' of ' + n0(L.total) + '</span><span><button class="btn ghost sm" id="aprev"' + (f.offset <= 0 ? " disabled" : "") + '>Previous</button> <button class="btn ghost sm" id="anext"' + (f.offset + PER >= L.total ? " disabled" : "") + '>Next</button></span></div></div>' +
  '<section class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h3>Brief queue</h3><p class="hint">Open an opportunity to see who has written about its angle and draft a brief. Every brief waits for an editor decision.</p></div><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Drafted</th><th>Opportunity</th><th>Headline</th><th>Window</th><th>Status</th></tr></thead><tbody>' +
  (B.briefs.map((b) => '<tr><td class="small">' + dt(b.createdAt) + '</td><td class="small">' + esc(b.sector) + ' × ' + esc(b.topic) + '</td><td class="b" style="max-width:340px">' + esc(b.brief.headline) + '</td><td class="small">' + esc(b.brief.publication_window || "—") + '</td><td>' + statusPill(b.status) + '</td></tr>').join("") || '<tr><td colspan="5" class="mute">No briefs yet.</td></tr>') + '</tbody></table></div></section>';

  const again = () => { f.offset = 0; render(); };
  let t; $("#aq").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; again(); }, 350); };
  $("#asrc").onchange = (e) => { f.source = e.target.value; again(); };
  $("#akind").onchange = (e) => { f.kind = e.target.value; again(); };
  $("#amatch").onchange = (e) => { f.matched = e.target.value; again(); };
  $("#aprev").onclick = () => { f.offset = Math.max(0, f.offset - PER); render(); };
  $("#anext").onclick = () => { f.offset += PER; render(); };
  $$("tr[data-a]", el).forEach((r) => (r.onclick = () => { const d = document.getElementById(domId(r.dataset.a)); if (d) d.style.display = d.style.display === "none" ? "" : "none"; }));
}

// JOURNALISTS DISABLED (kept for later): the journalist directory page that this replaced.
// async function pgJournalists(el) {
//   const f = (S.jf ??= { q: "", beat: "", publication: "", offset: 0 }), enc = encodeURIComponent, PER = 25;
//   const [st, L, B] = await Promise.all([
//     api("/api/journalists/status"),
//     api("/api/journalists?facets=1&limit=" + PER + "&offset=" + f.offset + "&q=" + enc(f.q) + "&beat=" + enc(f.beat) + "&publication=" + enc(f.publication)),
//     api("/api/briefs"),
//   ]);
//   const fc = L.facets, cov = fc.coverage, total = st.count || 1, bs = B.stats;
//   const decided = (bs.approved || 0) + (bs.rejected || 0) + (bs.needs_evidence || 0);
//   const pg = (st.pages && st.page ? Math.min(100, Math.round((100 * st.page) / st.pages)) : 0);
//   const pc = (n) => Math.round((100 * n) / total) + "%";
//   el.innerHTML = banner("info", "<b>How matching works.</b> Journalists come from the directory endpoint and are stored on this machine only. An opportunity is matched using only what each record states: declared beat, outlet, location and recent articles. Contact details are shown to you but never sent to the AI model, and nothing is ever sent to a journalist: outreach is a human decision.") +
//   '<div class="kpis"><div class="kpi"><div class="v num">' + n0(st.count) + '</div><div class="l">Journalists in directory</div><div class="s">' + (st.lastSync ? "synced " + ago(st.lastSync) : "not synced yet") + '</div></div>' +
//   '<div class="kpi"><div class="v num">' + pc(cov.beat) + '</div><div class="l">With a declared beat</div><div class="s">' + pc(cov.articles) + ' have recent articles</div></div>' +
//   '<div class="kpi"><div class="v num">' + pc(cov.email) + '</div><div class="l">With an email</div><div class="s">' + pc(cov.linkedin) + ' LinkedIn · ' + pc(cov.phone) + ' phone</div></div>' +
//   '<div class="kpi"><div class="v num">' + (bs.pending || 0) + '</div><div class="l">Briefs awaiting an editor</div><div class="s">' + (bs.approved || 0) + ' approved · ' + decided + ' decided</div></div></div>' +
//   '<section class="card" style="margin-bottom:16px"><div class="sec-h" style="margin:0"><div><h3>Directory sync</h3><p class="hint" style="margin:0">Source: <span class="code">' + esc(clip(st.url, 70)) + '</span>. Records are saved page by page; a failed sync keeps what it already stored.</p></div><button class="btn sm" id="jsync"' + (st.running ? " disabled" : "") + '>' + (st.running ? "Syncing…" : "Sync now") + '</button></div>' +
//   (st.running ? '<div class="bar" style="margin-top:10px"><i style="width:' + pg + '%"></i></div><p class="small mute" style="margin:6px 0 0">Page ' + st.page + (st.pages ? " of " + st.pages : "") + ' · ' + n0(st.saved) + ' of ' + n0(st.total) + ' records saved</p>' : "") +
//   (st.error ? '<p class="small" style="color:var(--bad);margin:8px 0 0">Last sync failed: ' + esc(st.error) + '</p>' : "") + '</section>' +
//   '<div class="card flush"><div style="padding:14px 16px;border-bottom:1px solid var(--line)"><div class="ctl"><input type="text" id="jq" placeholder="Search name, outlet, beat, city or article title…" value="' + esc(f.q) + '" style="max-width:320px">' +
//   '<label>Beat <select id="jbeat"><option value="">All</option>' + fc.beats.map((b) => '<option value="' + esc(b.v) + '"' + (b.v === f.beat ? " selected" : "") + '>' + esc(b.v) + ' (' + b.n + ')</option>').join("") + '</select></label>' +
//   '<label>Outlet <select id="jpub"><option value="">All</option>' + fc.publications.map((p) => '<option value="' + esc(p.v) + '"' + (p.v === f.publication ? " selected" : "") + '>' + esc(clip(p.v, 34)) + ' (' + p.n + ')</option>').join("") + '</select></label>' +
//   '<span class="mute small">' + n0(L.total) + ' match</span></div></div>' +
//   '<div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Journalist</th><th>Outlet</th><th>Beat</th><th>Location</th><th class="r">Articles</th><th>Contact</th></tr></thead><tbody>' +
//   (L.rows.map((j) => '<tr class="click" data-j="' + esc(j.id) + '"><td><span class="b">' + esc(j.name) + '</span><div class="tiny mute">' + esc(j.designation) + '</div></td><td class="small">' + esc(j.publication) + '</td><td class="small" style="max-width:260px">' + (esc(j.beat) || '<span class="mute">not declared</span>') + '</td><td class="small">' + esc([j.city, j.state].filter(Boolean).join(", ")) + '</td><td class="r num">' + j.articles.length + '</td><td class="tiny">' + contactLinks({ email: j.email, linkedin: j.linkedin, profile: j.profileUrl, phone: "" }) + '</td></tr>' +
//     '<tr class="jd" id="jd-' + esc(j.id) + '" style="display:none"><td colspan="6" style="background:var(--surface2)">' + (j.articles.length ? j.articles.map((a) => '<div class="story"><a class="h" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.title) + '</a> <span class="mute tiny">' + esc((a.publishDate || "").slice(0, 10)) + (a.website ? " · " + esc(a.website) : "") + '</span>' + (a.summary ? '<div class="small mute">' + esc(a.summary) + '</div>' : "") + '</div>').join("") : '<span class="mute small">No recent articles on record.</span>') + (j.phone ? '<div class="tiny mute" style="margin-top:6px">Phone: ' + esc(j.phone) + '</div>' : "") + '</td></tr>').join("") || '<tr><td colspan="6" class="mute">' + (st.count ? "No journalist matches these filters." : "The directory is empty. Press Sync now.") + '</td></tr>') +
//   '</tbody></table></div><div class="ctl" style="padding:10px 16px;justify-content:space-between;border-top:1px solid var(--line)"><span class="small mute">Showing ' + (L.total ? f.offset + 1 : 0) + '–' + Math.min(L.total, f.offset + PER) + ' of ' + n0(L.total) + '</span><span><button class="btn ghost sm" id="jprev"' + (f.offset <= 0 ? " disabled" : "") + '>Previous</button> <button class="btn ghost sm" id="jnext"' + (f.offset + PER >= L.total ? " disabled" : "") + '>Next</button></span></div></div>' +
//   '<section class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h3>Pitch brief queue</h3><p class="hint">Open an opportunity to see its best-fit journalists and draft a brief. Every brief waits for an editor decision.</p></div><div class="tw" style="max-height:none"><table class="t"><thead><tr><th>Drafted</th><th>Opportunity</th><th>Headline</th><th>Pitch to</th><th>Status</th></tr></thead><tbody>' +
//   (B.briefs.map((b) => '<tr><td class="small">' + dt(b.createdAt) + '</td><td class="small">' + esc(b.sector) + ' × ' + esc(b.topic) + '</td><td class="b" style="max-width:340px">' + esc(b.brief.headline) + '</td><td class="small">' + esc(b.brief.generatedFor?.recipient?.name ?? "—") + '</td><td>' + statusPill(b.status) + '</td></tr>').join("") || '<tr><td colspan="5" class="mute">No briefs yet.</td></tr>') + '</tbody></table></div></section>';

//   const again = () => { f.offset = 0; render(); };
//   let t; $("#jq").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; again(); }, 350); };
//   $("#jbeat").onchange = (e) => { f.beat = e.target.value; again(); };
//   $("#jpub").onchange = (e) => { f.publication = e.target.value; again(); };
//   $("#jprev").onclick = () => { f.offset = Math.max(0, f.offset - PER); render(); };
//   $("#jnext").onclick = () => { f.offset += PER; render(); };
//   $$("tr[data-j]", el).forEach((r) => (r.onclick = (e) => { if (e.target.closest("a")) return; const d = $("#jd-" + r.dataset.j.replace(/"/g, "")); if (d) d.style.display = d.style.display === "none" ? "" : "none"; }));
//   $("#jsync").onclick = async () => { try { await post("/api/journalists/sync", {}); toast("Sync started"); render(); } catch (e) { toast(e.message, 5000); } };
//   if (st.running) setTimeout(() => { if (S.tab === "journalists" && !document.activeElement?.matches("input,select,textarea")) render(); }, 2500);
// }

// ---------------------------------------------------------------- Validation
async function pgValidation(el) {
  const [b, cfg, st] = await Promise.all([api("/api/backtest"), S.cfg ?? api("/api/config"), api("/api/status")]);
  S.cfg = cfg;
  const pr = (v) => (v == null ? "–" : (v * 100).toFixed(0) + "%");
  const sec = (name, r) => `<tr><td class="b">${name}</td><td class="r num">${r.picks}</td><td class="r num b">${pr(r.precision)}</td><td class="r num">${pr(r.recall)}</td><td class="r num">${pr(r.falseAlertRate)}</td><td class="r num">${r.medianLeadHours != null ? r.medianLeadHours + "h" : "–"}</td></tr>`;
  el.innerHTML = `<div class="card"><h3>What counts as a successful prediction</h3><p style="margin:6px 0">${esc(b.definition ?? "")}</p><p class="small mute" style="margin:0">A proposed threshold to tune by sector, not a universal definition of a trend. Forecast windows tested: next ${cfg.success.windowHours}h. Top ${cfg.success.topK} recommendations per day are scored.</p></div>
  ${b.ready ? `<section class="grid g-7-5" style="margin-top:16px"><div class="card"><h3>HiveMind vs a simple baseline</h3><p class="hint">Replayed over ${b.days} past day${b.days === 1 ? "" : "s"}, each using only stories observed by that time. Baseline = “fastest current growth”.</p><table class="t"><thead><tr><th>Method</th><th class="r">Picks</th><th class="r">Precision@${b.topK}</th><th class="r">Recall</th><th class="r">False alerts</th><th class="r">Median lead</th></tr></thead><tbody>${sec("HiveMind score", b.hivemind)}${sec("Fastest growth baseline", b.baseline)}</tbody></table>
      ${b.hivemind.precision != null && b.baseline.precision != null ? `<p class="small" style="margin:10px 0 0">${b.hivemind.precision > b.baseline.precision ? "HiveMind beat" : b.hivemind.precision < b.baseline.precision ? "HiveMind did not beat" : "HiveMind matched"} the baseline on precision over this history. ${b.days < 10 ? "A short history is noisy; do not over-read this." : ""}</p>` : ""}</div>
      <div class="card"><h3>Editor usefulness <span class="mute" style="font-weight:400">· separate outcome</span></h3><div class="kpi" style="box-shadow:none"><div class="v num">${b.editor.acceptanceRate != null ? pr(b.editor.acceptanceRate) : "–"}</div><div class="l">Briefs accepted by editors</div><div class="s">${b.editor.decided} decided</div></div><p class="small mute">Attention growth and editorial usefulness are different outcomes; article performance is tracked separately once pieces are published.</p></div></section>
      <section class="card flush" style="margin-top:16px"><div style="padding:16px 16px 0"><h3>Day by day</h3></div><div class="tw" style="max-height:420px"><table class="t"><thead><tr><th>Prediction day</th><th>HiveMind top ${b.topK} (✔ = met the definition)</th><th>Baseline top ${b.topK}</th><th class="r">Topics that trended</th></tr></thead><tbody>${b.points.map((p) => `<tr><td class="small">${fmtDay(p.day)}</td><td>${p.hivemind.map((x) => `<span class="pill ${x.hit ? "p-ok" : "p-muted"}">${x.hit ? "✔ " : ""}${esc(x.id.replace(/-/g, " "))}</span>`).join(" ")}</td><td>${p.baseline.map((x) => `<span class="pill ${x.hit ? "p-ok" : "p-muted"}">${x.hit ? "✔ " : ""}${esc(x.id.replace(/-/g, " "))}</span>`).join(" ")}</td><td class="r num">${p.trendingTotal}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="card" style="margin-top:16px"><h3>Caveats</h3><ul class="small">${b.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></section>`
  : `<section class="grid g-7-5" style="margin-top:16px"><div class="card"><h3>Backtest not ready</h3><p>${esc(b.reason)}</p><div class="compo" style="grid-template-columns:130px 1fr 80px"><span>History stored</span><div class="bar"><i style="width:${Math.min(100, (100 * (b.haveDays ?? 0)) / (b.needDays ?? 10))}%"></i></div><span class="num">${b.haveDays ?? 0} / ${b.needDays ?? 10} days</span></div>
      <p class="small mute" style="margin:10px 0 0">Until then, scores and stages are produced by the same transparent rules, but no claim about predictive accuracy can be made. Recommendations are logged with timestamps from now on, so a replay will be possible as history accumulates.</p></div>
      <div class="card"><h3>How it will be tested</h3><ol class="small" style="padding-left:18px;margin:6px 0"><li>Replay each past day using only stories observed by that time (no future leakage).</li><li>Rank topics with the opportunity score and, separately, with a “fastest growth” baseline.</li><li>Check which top-${cfg.success.topK} topics met the trend definition in the next ${cfg.success.windowHours}h.</li><li>Report precision, recall, lead time, false alerts and editor acceptance.</li><li>Run a monitored pilot for 4–6 weeks; add a trained model only if it beats this on a held-out period.</li></ol></div></section>`}
  <section class="kpis" style="margin-top:16px"><div class="kpi"><div class="v num">${n0(st.recommendations)}</div><div class="l">Recommendations logged</div><div class="s">each with time, evidence and why it changed</div></div><div class="kpi"><div class="v num">${n0(st.dates.length)}</div><div class="l">Days of history</div><div class="s">${st.dates.length >= cfg.success.minHistoryDays ? "enough to backtest" : `needs ${cfg.success.minHistoryDays}`}</div></div></section>`;
}

// ---------------------------------------------------------------- Method
const STEPS = [
  { n: "1", t: "Collect", s: "Approved sources, polled hourly or daily", badge: "gnews.mjs", file: "src/gnews.mjs · config/publications.json", input: "19 approved sources: newsrooms, trade press and primary sources (PIB, RBI, IMD, SEBI)", output: "Headlines with URL, publication time, first-seen time, outlet", formula: "Google News RSS: site:<domain> when:24h (or after:/before: for a past day)", desc: "Every headline keeps its source URL, publication time and first observed time. Each source records why it is trusted. Optional scheduled collection (HIVEMIND_SCHEDULE_MINUTES) gives the document’s hourly cadence." },
  { n: "2", t: "Cluster & origins", s: "Duplicates become one story", badge: "cluster.mjs · origins.mjs", file: "src/cluster.mjs · src/origins.mjs", input: "Raw headlines", output: "Stories with outlet count and independent-origin count", formula: "origins = distinct ownership groups; a wire credit (PTI, ANI…) = 1 origin", desc: "Near-duplicate headlines form one reporting cluster. Distribution (outlets) is kept apart from independence (origins): ten sites repeating one report are not ten confirmations." },
  { n: "3", t: "Read (LLM)", s: "Impact, labels, pathways", badge: "llm.mjs", file: "src/llm.mjs (Reader.readFull)", input: "Headline, article text, bracket and topic lists", output: "Impacts (area, severity, horizon), content type, topics, entities, pathways", formula: "Claude forced tool call; output validated, never trusted as-is", desc: "Read with no company in mind. Each impact is filed under a broad bracket and, where labelled, a specific topic. Pathways are marked observed or hypothesis; content is labelled reported, opinion, analysis or unverified." },
  { n: "4", t: "Metrics", s: "Volume, share, momentum", badge: "metrics.mjs", file: "src/metrics.mjs", input: "Stories as observed by a chosen time", output: "Per topic: volume, origins, share, momentum, acceleration, stage, forecast", formula: "momentum = (recent count + 1) ÷ (baseline share × recent total + 1)", desc: "Coverage share removes distortion from how many articles were collected. Momentum compares recent share to a baseline that skips collection gaps; the +1 smoothing stops 1→3 stories from out-ranking a sustained rise." },
  { n: "5", t: "Opportunity score", s: "Transparent 0–100", badge: "opportunity.mjs", file: "src/opportunity.mjs", input: "Metrics + company sector matches", output: "Score, evidence strength, action, window, review condition", formula: "Σ weight × component (momentum 25, acceleration 15, sources 15, sector evidence 20, timing 15, headroom 10)", desc: "A ranking, not a probability. Evidence strength and missing signals are reported separately. A sparse topic stays on the watchlist." },
  { n: "6", t: "Author fit", s: "Who is qualified", badge: "opportunity.mjs", file: "src/opportunity.mjs (authorFit) · src/authors.mjs", input: "Opportunity + author profiles", output: "Fit score per author with reasons and missing profile fields", formula: "expertise 45 · geography 15 · audience 10 · turnaround 15 · evidence 15", desc: "Ranked separately from momentum. Uses only fields the author or editor entered." },
  { n: "7", t: "Brief & approval", s: "Editor stays in control", badge: "briefs", file: "src/llm.mjs (draft_brief) · src/analytics.mjs", input: "Opportunity, stories, optional author", output: "Headline, argument, facts with sources, assumptions, evidence needed, window, review condition", formula: "A fact without a supplied story URL is demoted to an assumption", desc: "The model drafts; an editor approves, asks for evidence or rejects. Nothing is published or sent." },
  { n: "8", t: "Log & validate", s: "Replay and measure", badge: "backtest.mjs", file: "src/backtest.mjs · recommendation_log", input: "History, logged recommendations", output: "Precision, recall, lead time, false alerts vs a simple baseline", formula: "trend = share ≥ 2× preceding 7-day share, ≥ 5 independent origins", desc: "Every recommendation is stored with its time and evidence and why it changed. Replays use only information available at each time." },
];
async function pgMethod(el) {
  const cfg = S.cfg ?? (S.cfg = await api("/api/config"));
  const W = cfg.weights, st = cfg.stage, ac = cfg.action;
  const cov = [
    ["§1 Core idea", "Implemented", "Event → consequence tracking; coverage volume and sector breadth kept as separate measures."],
    ["§2 Trusted sources", "Partial", "Approved list with trust reasons, 4 primary sources, syndication/origin counting, opinion/unverified labels. Collection is via Google News, not licensed feeds or APIs; hourly collection is optional."],
    ["§3 Event → sector mapping", "Implemented", "Pathways labelled observed or hypothesis; impact breadth tracked separately from severity. Depends on LLM judgement."],
    ["§4 Topic volume & metrics", "Implemented", "Volume, source breadth, share, momentum, acceleration, impact breadth. Search interest is an optional separate signal and shows ‘unavailable’ when missing."],
    ["§5 Plot momentum", "Implemented", "Bars + share + rolling average, hourly/daily, triggers annotated, gaps hatched, topic comparison, stages with visible rules, dashed forecast with band."],
    ["§6 Next likely topic", "Partial", "Opportunity score, evidence strength, watchlist, 24–72h and 3–7d windows. Historical sequences from comparable events need more history."],
    ["§7 Author match & briefs", "Implemented", "Author profiles, separate fit, briefs with review conditions, editor approval. No authors are pre-loaded."],
    ["§9 First version", "Partial", "Daily ranked list, evidence, action, change log. Pilot scope here is wider than the document’s one geography and 2–3 sectors."],
    ["§10 Testing", "Built, needs data", "Backtest and baseline comparison exist; they need ≥ " + cfg.success.minHistoryDays + " days of history to run."],
  ];
  el.innerHTML = `<section class="card"><h3>How this maps to the HiveMind concept document</h3><table class="t"><thead><tr><th>Section</th><th>Status</th><th>What is in the app</th></tr></thead><tbody>${cov.map(([a, b, c]) => `<tr><td class="b">${a}</td><td><span class="pill ${b === "Implemented" ? "p-ok" : "p-medium"}">${b}</span></td><td class="small">${esc(c)}</td></tr>`).join("")}</tbody></table></section>
  <section class="grid g2" style="margin-top:16px"><div class="card"><h3>Opportunity score weights</h3><p class="hint">Pilot assumptions, not validated findings. Edit <span class="code">config/hivemind.json</span> to tune.</p>${Object.entries(W).map(([k, v]) => `<div class="compo"><span><i class="c-${k}" style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px"></i>${COMP[k]}</span><div class="bar"><i style="width:${v * 4}%"></i></div><span class="num">${v}%</span></div>`).join("")}
      <ul class="small" style="padding-left:18px;margin-top:10px"><li><b>Momentum</b> 100 × clamp(log₂ momentum ÷ 2): ×1 → 0, ×2 → 50, ×4 → 100</li><li><b>Acceleration</b> 50 + 50 × clamp(Δlog₂ ÷ 1.5): 50 = unchanged</li><li><b>Independent sources</b> 100 × min(1, origins ÷ ${cfg.evidence.originsForFullScore})</li><li><b>Sector evidence</b> 100 × relevance of the sector pairing; a little lower when the pairing is inherited from the broader area instead of judged for the topic</li><li><b>Trigger timing</b> 100 within 24h → 60 at 72h → 0 at 7d; halved if unverified</li><li><b>Headroom</b> 100 × (1 − share percentile), capped when crowded or declining</li></ul></div>
    <div class="card"><h3>Stage rules</h3><table class="t"><tbody><tr><td>${stagePill("watch")}</td><td class="small">fewer than ${cfg.evidence.minClusters} stories or ${cfg.evidence.minOrigins} independent origins, or baseline shorter than ${cfg.intervals.minBaselineHours}h</td></tr><tr><td>${stagePill("crowded")}</td><td class="small">share in the top ${Math.round((1 - st.crowdedPercentile) * 100)}% of topics and momentum below ×${st.risingRatio}</td></tr><tr><td>${stagePill("declining")}</td><td class="small">momentum ≤ ×${st.decliningRatio} for two steps, or ≤ ×${st.decliningStrongRatio}</td></tr><tr><td>${stagePill("rising")}</td><td class="small">momentum ≥ ×${st.risingRatio} and the previous step ≥ ×${st.sustainedRatio} (sustained)</td></tr><tr><td>${stagePill("emerging")}</td><td class="small">momentum ≥ ×${st.risingRatio} from a below-median share, not yet sustained</td></tr><tr><td>${stagePill("steady")}</td><td class="small">anything else</td></tr></tbody></table>
      <h3 style="margin-top:16px">Suggested action</h3><ul class="small" style="padding-left:18px;margin:6px 0"><li>${actionPill("write now")} score ≥ ${ac.writeNowScore}, evidence ≥ medium, rising/emerging, headroom ≥ ${ac.writeNowMinHeadroom}, verified trigger, supported sector link</li><li>${actionPill("investigate")} score ≥ ${ac.investigateScore} but a write-now condition is missing</li><li>${actionPill("monitor")} score ≥ ${ac.monitorScore}, or sparse evidence (watchlist)</li><li>${actionPill("skip")} declining, crowded with no headroom, or score below ${ac.monitorScore}</li></ul>
      <p class="small mute">Momentum windows: last ${cfg.intervals.recentHoursShort}h (${cfg.intervals.recentHours}h once ≥ ${cfg.intervals.shortBelowHistoryHours}h of history exists) vs a baseline of up to ${cfg.intervals.baselineHours}h. Forecast windows: next 24–72h and 3–7 days.</p></div></section>
  <section class="card" style="margin-top:16px"><div class="sec-h" style="margin:0"><div><h3>System working diagram</h3><p class="hint" style="margin:0">Click a stage to inspect inputs, outputs and the core calculation.</p></div></div><div class="pipe" id="pipe"></div><div class="card" style="margin-top:10px;background:var(--surface2);box-shadow:none" id="pbox"></div></section>
  <section class="card" style="margin-top:16px"><h3>Read with care</h3><ul class="small"><li>Severity, relevance and direct/indirect are model judgements, not measurements; weights and thresholds are pilot assumptions.</li><li>Coverage ≠ importance: press attention skews to politics and metros.</li><li>Google News is lossy and unofficial; paywalled outlets give headline-only readings. Keep use internal and check the terms of Google and publishers.</li><li>Short history means short baselines. The dashboard shows how much baseline each number rests on.</li></ul></section>`;
  const draw = () => {
    $("#pipe").innerHTML = STEPS.map((s, i) => `<div class="pstep${i === (S.step ?? 3) ? " on" : ""}" data-i="${i}"><div class="n">Stage ${s.n}</div><div class="t">${esc(s.t)}</div><div class="d">${esc(s.s)}</div></div>`).join("");
    const c = STEPS[S.step ?? 3];
    $("#pbox").innerHTML = `<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><b>${esc(c.t)} <span class="code">${esc(c.badge)}</span></b><span class="small mute">${esc(c.file)}</span></div><p class="small">${esc(c.desc)}</p><div class="grid g3"><div><div class="tiny mute b">INPUT</div><div class="small">${esc(c.input)}</div></div><div><div class="tiny mute b">OUTPUT</div><div class="small">${esc(c.output)}</div></div><div><div class="tiny mute b">CORE CALCULATION</div><div class="small code">${esc(c.formula)}</div></div></div>`;
    $$(".pstep").forEach((p) => (p.onclick = () => { S.step = +p.dataset.i; draw(); }));
  };
  draw();
}

// ---------------------------------------------------------------- Clients & Sectors
const CLIENT_PRESETS = [
  {
    name: "Google (Alphabet)",
    desc: "Global Big Tech corporation across cloud, search, AI, mobile platforms, video, devices and advertising",
    sectors: [
      "Cloud & Enterprise Infrastructure",
      "Search, Information & Web Platforms",
      "AI Research & Gemini (DeepMind)",
      "Android, Mobile & Chrome OS",
      "YouTube, Streaming & Creator Economy",
      "Hardware & Consumer Devices (Pixel, Nest)",
      "Digital Advertising, AdTech & Commerce",
      "Antitrust, Privacy & Tech Regulation"
    ]
  },
  {
    name: "Tata / Reliance (Conglomerate)",
    desc: "Diversified industrial and consumer business conglomerate",
    sectors: [
      "Energy, Petrochemicals & Renewables",
      "Telecommunications, 5G & Digital Platforms",
      "Retail, E-Commerce & Consumer Brands",
      "Automotive, Electric Vehicles & Mobility",
      "Steel, Metals & Heavy Manufacturing",
      "Financial Services & Insurance",
      "IT Services & Global Technology Delivery"
    ]
  },
  {
    name: "Global Private Equity & Investment Bank",
    desc: "Institutional asset management, capital markets, and corporate deal advisory",
    sectors: [
      "M&A Advisory & Corporate Finance",
      "Private Equity Buyouts & Growth Capital",
      "Venture Capital & Tech Startups",
      "Fixed Income, Currencies & Commodities",
      "Debt Capital Markets & Corporate Restructuring"
    ]
  },
  {
    name: "Pharmaceutical & Healthcare Group",
    desc: "Life sciences, hospital chains, drug formulations and medical devices",
    sectors: [
      "Formulations, Generics & Active Ingredients",
      "Hospital Networks & Inpatient Care",
      "Clinical Trials & R&D Pipeline",
      "Medical Devices & Diagnostic Equipment",
      "Health Insurance & Government Healthcare Schemes"
    ]
  }
];

async function pgClients(el) {
  const [data, st] = await Promise.all([api("/api/companies"), api("/api/status")]);
  const list = data.companies || [];
  const cur = list.find((c) => c.id === S.company) || list[0];

  el.innerHTML = `
    <div class="sec-h">
      <div>
        <h2>Client Company Management</h2>
        <p>Switch active client lenses or create new enterprise clients to project news impacts through their unique sector taxonomy.</p>
      </div>
      <div>
        <button class="btn" id="mrunall">Run sector matching for all</button>
      </div>
    </div>

    <div class="kpis" style="margin-bottom:20px">
      <div class="kpi accent">
        <div class="v">${esc(cur?.name ?? "None")}</div>
        <div class="l">Active Client Lens</div>
        <div class="s">${cur?.sectors?.length ?? 0} practice areas / sectors</div>
      </div>
      <div class="kpi">
        <div class="v num">${list.length}</div>
        <div class="l">Configured Clients</div>
        <div class="s">${list.filter((c) => !c.builtin).length} custom client profiles</div>
      </div>
      <div class="kpi">
        <div class="v num">${Object.keys(cur?.matches ?? {}).length}</div>
        <div class="l">Matched Judgements</div>
        <div class="s">bracket × sector tailored angles</div>
      </div>
    </div>

    <div class="grid g-7-5">
      <div class="card flush">
        <div style="padding:16px 16px 8px">
          <h3>Active Clients</h3>
          <p class="hint">Click "Switch" to immediately adapt all dashboard rankings, scores, and briefs to that client.</p>
        </div>
        <div class="tw" style="max-height:none">
          <table class="t">
            <thead>
              <tr>
                <th>Company</th>
                <th>Sectors</th>
                <th>Matching Status</th>
                <th class="r">Action</th>
              </tr>
            </thead>
            <tbody>
              ${list.map((c) => {
                const isAct = c.id === S.company;
                const matchCount = Object.keys(c.matches || {}).length;
                return `<tr>
                  <td>
                    <div class="b">${esc(c.name)} ${c.builtin ? `<span class="pill p-muted">default</span>` : ""} ${isAct ? `<span class="pill p-ok">active</span>` : ""}</div>
                    <div class="tiny mute">${c.sectors.slice(0, 3).map((s) => esc(s.name)).join(" · ")}${c.sectors.length > 3 ? "..." : ""}</div>
                  </td>
                  <td class="num">${c.sectors.length} sectors</td>
                  <td>
                    <div class="compo" style="grid-template-columns:80px 1fr;gap:6px">
                      <span class="tiny mute">${matchCount} matched</span>
                      <div class="bar" style="height:6px"><i style="width:${Math.min(100, matchCount * 4)}%"></i></div>
                    </div>
                  </td>
                  <td class="r">
                    ${isAct ? `<span class="small b mute">Active</span>` : `<button class="btn sm" data-switch="${esc(c.id)}">Switch</button>`}
                    ${c.builtin ? "" : `<button class="btn bad sm" data-delco="${esc(c.id)}" style="margin-left:4px">Delete</button>`}
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3>Create New Client</h3>
        <p class="hint">Use a preset template or enter custom sectors to immediately serve a new client.</p>
        <div style="margin-bottom:12px">
          <div class="tiny mute b" style="margin-bottom:4px">POPULAR TEMPLATES (CLICK TO FILL)</div>
          <div class="preset-grid">
            ${CLIENT_PRESETS.map((p, i) => `<button class="preset-btn" data-preset="${i}">${esc(p.name)}</button>`).join("")}
          </div>
        </div>
        <label class="f">Client / Company Name</label>
        <input type="text" id="nconame" placeholder="e.g. Google, Tata Sons, Reliance Industries">
        <label class="f">Sector &amp; Practice Area Taxonomy (One per line)</label>
        <textarea id="ncotext" rows="8" placeholder="Cloud &amp; Enterprise Platforms&#10;Autonomous Mobility &amp; EV&#10;Semiconductor Manufacturing&#10;Digital Ads &amp; Commerce"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn" id="ncosave">Create Client &amp; Match</button>
          <span class="small mute" id="ncostatus"></span>
        </div>
      </div>
    </div>
  `;

  $$("[data-switch]", el).forEach((b) => (b.onclick = async () => {
    S.company = b.dataset.switch;
    ls.set("company", S.company);
    S.selSector = null;
    toast(`Switched active client to ${list.find((c) => c.id === S.company)?.name ?? S.company}`);
    await loadStatusOnce();
    render();
  }));

  $$("[data-delco]", el).forEach((b) => (b.onclick = async () => {
    const id = b.dataset.delco;
    if (!confirm(`Delete client "${id}" and its sector matches?`)) return;
    try {
      await fetch(`/api/company?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (S.company === id) { S.company = "bcg"; ls.set("company", "bcg"); }
      toast("Deleted client");
      await loadStatusOnce();
      render();
    } catch (e) { toast(e.message); }
  }));

  $$("[data-preset]", el).forEach((b) => (b.onclick = () => {
    const p = CLIENT_PRESETS[+b.dataset.preset];
    $("#nconame").value = p.name;
    $("#ncotext").value = p.sectors.join("\n");
  }));

  $("#ncosave").onclick = async () => {
    const name = $("#nconame").value.trim();
    const text = $("#ncotext").value.trim();
    if (!name) return toast("Enter a client company name");
    if (!text) return toast("Enter at least one sector");
    const st = $("#ncostatus");
    st.textContent = "Creating & initiating matching…";
    $("#ncosave").disabled = true;
    try {
      const res = await post("/api/company", { name, text });
      S.company = res.id;
      ls.set("company", res.id);
      toast(`Created ${res.name} with ${res.sectors.length} sectors. Matching started!`);
      await loadStatusOnce();
      render();
    } catch (e) {
      st.textContent = e.message;
      $("#ncosave").disabled = false;
    }
  };

  $("#mrunall").onclick = async () => {
    const btn = $("#mrunall");
    btn.disabled = true;
    try {
      await post("/api/company/match", {});
      toast("Sector matching started in background");
      setTimeout(render, 1500);
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- Guide & Features
async function pgGuide(el) {
  const cfg = S.cfg ?? (S.cfg = await api("/api/config"));
  el.innerHTML = `
    <div class="card" style="margin-bottom:20px;background:var(--brand-soft);border-color:transparent">
      <div style="max-width:860px">
        <img src="/ui/logo.png" alt="HiveMind" class="guide-logo"><div class="pill p-write dot" style="margin-bottom:8px">System Architecture &amp; User Manual</div>
        <h2 style="font-size:22px;margin:0 0 8px">HiveMind: Editorial Intelligence &amp; Topic Forecasting</h2>
        <p style="font-size:14px;color:var(--ink2);line-height:1.6;margin:0">
          HiveMind is a decision-support intelligence platform built to bridge the critical gap between breaking event signals and executive publishing decisions.
          Instead of measuring retrospective popularity, HiveMind tracks verified primary news events, maps their causal business disruptions, and forecasts which secondary topics will command public attention <b>24–72 hours</b> and <b>3–7 days</b> ahead.
        </p>
      </div>
    </div>

    <section class="card" style="margin-bottom:20px">
      <h3>End-to-End System Flow: From Event to Executive Brief</h3>
      <p class="hint">The pipeline executes 8 deterministic, transparent stages with human editorial oversight.</p>
      <div class="guide-flow">
        <div class="flow-card">
          <div class="num">01</div>
          <h4>Multi-Source Ingestion</h4>
          <p>Collects hourly from 19 approved sources: primary regulators (PIB, RBI, IMD, SEBI), national newsrooms, and specialist trade dailies. Uses Google News queries; preserves publication and observation timestamps.</p>
        </div>
        <div class="flow-card">
          <div class="num">02</div>
          <h4>Clustering &amp; Origin Deduplication</h4>
          <p>Groups near-duplicate headlines via token Jaccard similarity. Crucially separates <i>reach</i> (outlets) from <i>independence</i> (origins): newsroom conglomerates collapse, and wire syndication (PTI/ANI) counts as 1 confirmation.</p>
        </div>
        <div class="flow-card">
          <div class="num">03</div>
          <h4>Causal Impact &amp; Pathway Extraction</h4>
          <p>Language model reads stories with zero client bias. Identifies severity, horizon, content type (reported/opinion/unverified), and causal pathway chains (<code>event → disruption → affected sector → question</code>).</p>
        </div>
        <div class="flow-card">
          <div class="num">04</div>
          <h4>Time-Series Metrics Engine</h4>
          <p>Computes coverage share (mitigating collection volume distortions), momentum against a 7-day baseline (+1 Laplacian smoothed to prevent 1→3 surges), acceleration, and flags collection outages.</p>
        </div>
        <div class="flow-card">
          <div class="num">05</div>
          <h4>Transparent Opportunity Score</h4>
          <p>Calculates a 0–100 ranking score combining Momentum (25%), Acceleration (15%), Source Breadth (15%), Sector Evidence (20%), Trigger Timing (15%), and Headroom (10%).</p>
        </div>
        <div class="flow-card">
          <div class="num">06</div>
          <h4>Multi-Client Sector Lens</h4>
          <p>Projects topic density through client practice areas (BCG, Google, Conglomerates). Evaluates direct vs. second-order exposure, and distinguishes supported evidence from hypotheses.</p>
        </div>
        <div class="flow-card">
          <div class="num">07</div>
          <h4>Author Matching &amp; Factual Briefs</h4>
          <p>Ranks author fit strictly from profile expertise, audience, and turnaround (never hallucinates). Generates briefs with verified facts linked to source URLs; unlinked claims become assumptions.</p>
        </div>
        <div class="flow-card">
          <div class="num">08</div>
          <h4>Replay Validation &amp; Change Audit</h4>
          <p>Replays history at past day boundaries (zero future leakage) to test whether predicted topics doubled coverage share. Logs every score change and rationale in SQLite.</p>
        </div>
      </div>
    </section>

    <div class="grid g2" style="margin-bottom:20px">
      <div class="card">
        <h3>Topic Lifecycle Stages</h3>
        <p class="hint">How topics progress through the editorial lifecycle.</p>
        <table class="t">
          <tbody>
            <tr><td><span class="pill p-emerging dot">Emerging</span></td><td class="small">Coverage momentum &ge; 1.3× from a low baseline. Attention is breaking.</td></tr>
            <tr><td><span class="pill p-rising dot">Rising</span></td><td class="small">Sustained growth across two consecutive steps (&ge; 1.3× and &ge; 1.1×). Prime window to publish.</td></tr>
            <tr><td><span class="pill p-steady dot">Steady</span></td><td class="small">Momentum stable between 0.8× and 1.3×. Ongoing background coverage.</td></tr>
            <tr><td><span class="pill p-crowded dot">Crowded</span></td><td class="small">Coverage share in top 25% percentile but momentum slowing. Room for fresh angles is saturated.</td></tr>
            <tr><td><span class="pill p-declining dot">Declining</span></td><td class="small">Coverage momentum &le; 0.8× or falling sharply. Editorial interest has moved on.</td></tr>
            <tr><td><span class="pill p-watch dot">Watchlist</span></td><td class="small">Fewer than 3 stories or 2 independent origins, or baseline &lt; 24h. Monitoring.</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>Action Classifications &amp; Decision Rules</h3>
        <p class="hint">Recommended editorial moves based on multi-factor thresholds.</p>
        <table class="t">
          <tbody>
            <tr>
              <td><span class="pill p-write">● Write Now</span></td>
              <td class="small">Score &ge; 65, evidence &ge; medium, stage rising/emerging, headroom &ge; 40%, verified trigger within 7 days, and supported sector link. Ready for brief approval.</td>
            </tr>
            <tr>
              <td><span class="pill p-investigate">Investigate</span></td>
              <td class="small">Score &ge; 50. Promising momentum, but something is still missing, usually a verified trigger or a sector link judged for this topic.</td>
            </tr>
            <tr>
              <td><span class="pill p-monitor">Monitor</span></td>
              <td class="small">Score &ge; 35, or insufficient baseline history. Kept on watchlist as evidence accumulates.</td>
            </tr>
            <tr>
              <td><span class="pill p-skip">Skip</span></td>
              <td class="small">Coverage is declining, topic is crowded with minimal headroom, or score &lt; 35.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <section class="card">
      <h3>Role-Based Workflows</h3>
      <div class="grid g3" style="margin-top:12px">
        <div class="guide-card" style="margin:0">
          <h4>For newsroom editors</h4>
          <p class="small mute" style="line-height:1.5">
            <b>1. Morning Triage:</b> Open Executive Overview to review "Today's Priorities".<br>
            <b>2. Inspect Momentum:</b> Check if the rising topic has independent origins or just syndicated repeats.<br>
            <b>3. Match Author:</b> Open opportunity detail to see the best qualified staff author.<br>
            <b>4. Approve Brief:</b> Click "Draft Brief", verify source citations, and click "Approve".
          </p>
        </div>
        <div class="guide-card" style="margin:0">
          <h4>For consulting partners</h4>
          <p class="small mute" style="line-height:1.5">
            <b>1. Client Selection:</b> Switch active client to BCG, Google, or your corporate client in the top bar.<br>
            <b>2. Sector Heatmap:</b> Open "Company Lens" to inspect direct vs. indirect disruption fronts (regulation, supply chain, costs).<br>
            <b>3. Executive Briefing:</b> Export sector drivers for leadership memos.
          </p>
        </div>
        <div class="guide-card" style="margin:0">
          <h4>For data &amp; platform teams</h4>
          <p class="small mute" style="line-height:1.5">
            <b>1. Model Fallback:</b> Enable Ollama local fallback in Settings for resilient zero-cost offline operation.<br>
            <b>2. Signal Expansion:</b> Connect X API v2 and SerpApi Google Trends to enrich editorial scores.<br>
            <b>3. Statistical Backtest:</b> Validate precision@K and lead time over accumulated history.
          </p>
        </div>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------- Settings & Integrations
async function pgSettings(el) {
  const [idata, sdata] = await Promise.all([api("/api/integrations"), api("/api/system")]);
  const ints = idata.integrations || [];
  const sys = sdata.system || {};
  const settings = sdata.settings || {};

  const gpus = sys.gpus || [];
  const gpuDesc = gpus.length ? gpus.map((g) => `${g.name} (${g.vramGB} GB VRAM)`).join(", ") : "No dedicated GPU detected (CPU mode)";
  const models = sys.ollama?.models || [];

  const html = `
    <div class="sec-h">
      <div>
        <h2>${S.tab === "system" ? "This machine and the local model" : "Integrations and API keys"}</h2>
        <p>${S.tab === "system" ? "Hardware profile, the local Ollama fallback and which model is used first." : "Add or remove keys, switch services on or off and test each connection."}</p>
      </div>
      <div>
        <span class="pill ${idata.provider ? "p-ok" : "p-bad"} dot">Active Provider: ${esc(idata.label || idata.provider || "None")}</span>
      </div>
    </div>

    <!-- LLM Provider & Local Fallback Card -->
    <div class="card" style="margin-bottom:20px">
      <div class="sec-h" style="margin:0 0 10px">
        <div>
          <h3>LLM Engine &amp; Hardware Profile</h3>
          <p class="hint" style="margin:0">Dual-provider failover: cloud Claude for speed + local Ollama for zero-cost offline resilience.</p>
        </div>
        <div>
          <span class="pill ${sys.ollama?.reachable ? "p-ok" : "p-muted"} dot">${sys.ollama?.reachable ? "Ollama Connected" : "Ollama Offline"}</span>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="kpi" style="padding:10px 12px"><div class="v num" style="font-size:18px">${sys.ramGB ?? 0} GB</div><div class="l tiny">System RAM (${sys.freeRamGB ?? 0} GB free)</div></div>
        <div class="kpi" style="padding:10px 12px"><div class="v" style="font-size:16px">${esc(sys.cpu?.cores ?? 0)} Cores</div><div class="l tiny">${esc(clip(sys.cpu?.model ?? "CPU", 24))}</div></div>
        <div class="kpi" style="padding:10px 12px"><div class="v" style="font-size:16px">${gpus.length ? `${gpus[0].vramGB} GB` : "0 GB"}</div><div class="l tiny">${esc(clip(gpuDesc, 26))}</div></div>
        <div class="kpi" style="padding:10px 12px"><div class="v num" style="font-size:18px">${models.length}</div><div class="l tiny">Installed Ollama Models</div></div>
      </div>

      <div class="grid g2" style="background:var(--surface2);padding:14px;border-radius:10px;margin-bottom:12px">
        <div>
          <label class="f b">Primary LLM Provider</label>
          <select id="set-primary" class="f">
            <option value="anthropic"${settings.primary === "anthropic" ? " selected" : ""}>Anthropic (Claude)</option>
            <option value="ollama"${settings.primary === "ollama" ? " selected" : ""}>Ollama (Local Offline Model)</option>
          </select>
          <div style="margin-top:10px">
            <label class="chk b">
              <input type="checkbox" id="set-fallback" ${settings.fallback !== false ? "checked" : ""}>
              Auto-Fallback to Ollama if Claude hits rate limits or runs out of credits
            </label>
          </div>
        </div>
        <div>
          <label class="f b">Select Local Ollama Model</label>
          <select id="set-model" class="f">
            ${models.length ? models.map((m) => `<option value="${esc(m.name)}"${settings.ollamaModel === m.name ? " selected" : ""}>${esc(m.name)} (${m.sizeGB} GB)</option>`).join("") : `<option value="">No local models installed in Ollama</option>`}
          </select>
          <p class="tiny mute" style="margin:6px 0 0">
            ${sys.recommended ? `Recommended for <b>${esc(sys.hostname)}</b> (${sys.ramGB} GB RAM, ${sys.recommended.fastMemGB} GB GPU memory): <span class="code">${esc(sys.recommended.tag)}</span>, ${sys.recommended.sizeGB} GB, ${esc(sys.recommended.speed)}. ${esc(sys.recommended.note)} ${sys.ollama?.installed ? `Get it with <span class="code">ollama pull ${esc(sys.recommended.tag)}</span>.` : `Ollama is not installed here: <span class="code">${esc(sys.install?.install ?? "")}</span>, then <span class="code">ollama pull ${esc(sys.recommended.tag)}</span>.`} Larger models (32B and up) need roughly 24 GB or more of GPU memory to run at a usable speed.` : ""}
          </p>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn" id="save-llm-settings">Save LLM Configuration</button>
        <span class="small mute" id="llm-st"></span>
      </div>
    </div>

    <!-- Integrations & Keys Grid -->
    <div class="sec-h">
      <div>
        <h3>External Integrations &amp; API Keys</h3>
        <p class="hint">Toggle services on/off, update credentials directly, or test live connectivity.</p>
      </div>
    </div>

    <div class="grid g2">
      ${ints.map((it) => {
        const cls = it.health === "ok" ? "healthy" : it.health === "exhausted" ? "warning" : it.health === "off" ? "off" : "error";
        const badge = it.health === "ok" ? `<span class="pill p-ok">Connected</span>` : it.health === "exhausted" ? `<span class="pill p-medium">Quota Exhausted</span>` : it.health === "off" ? `<span class="pill p-muted">Disabled</span>` : it.health === "error" ? `<span class="pill p-medium" title="${esc(String(it.state?.lastError ?? "").slice(0, 200))}">Recent errors</span>` : `<span class="pill p-bad">Not Configured</span>`;
        return `
          <div class="int-card ${cls}" id="card-${it.name}">
            <div class="int-card-head">
              <div>
                <b>${esc(it.label)}</b>
                ${it.essential ? `<span class="pill p-high" style="margin-left:6px">Essential</span>` : ""}
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                ${badge}
                <label class="switch" title="Toggle ${esc(it.label)}">
                  <input type="checkbox" data-toggle="${it.name}" ${it.enabled ? "checked" : ""}>
                  <span class="slider"></span>
                </label>
              </div>
            </div>
            <p class="small mute" style="margin:0">${esc(it.role)}</p>

            ${it.hasKey ? `
              <div style="margin-top:6px">
                <label class="f tiny mute">CURRENT KEY: <b>${it.configured ? esc(it.masked) : "None"}</b></label>
                <div style="display:flex;gap:6px">
                  <input type="password" id="input-${it.name}" placeholder="Enter new ${it.envName}..." style="font-size:12px;padding:5px 8px">
                  <button class="btn ghost sm" data-savekey="${it.name}">Save</button>
                  ${it.configured ? `<button class="btn bad sm" data-remkey="${it.name}">Remove</button>` : ""}
                </div>
              </div>
            ` : ""}

            <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--line)">
              <span class="tiny mute">${it.docs ? `<a href="https://${it.docs}" target="_blank" rel="noopener">${it.docs} ↗</a>` : ""}</span>
              <button class="btn sm" data-test="${it.name}">Test Connection</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  const iL = html.indexOf("<!-- LLM Provider"), iI = html.indexOf("<!-- Integrations & Keys Grid -->");
  el.innerHTML = S.tab === "system" ? html.slice(0, iI) : html.slice(0, iL) + html.slice(iI);

  // LLM settings save
  if ($("#save-llm-settings")) $("#save-llm-settings").onclick = async () => {
    const primary = $("#set-primary").value;
    const fallback = $("#set-fallback").checked;
    const ollamaModel = $("#set-model").value || null;
    const st = $("#llm-st");
    st.textContent = "Saving…";
    try {
      const res = await post("/api/system/settings", { primary, fallback, ollamaModel });
      toast("LLM settings updated");
      st.textContent = res.llm?.message ? `Active: ${res.llm.message}` : "Saved";
      await loadStatusOnce();
      render();
    } catch (e) { st.textContent = e.message; }
  };

  // Toggle integration switches
  $$("[data-toggle]", el).forEach((sw) => {
    sw.onchange = async () => {
      const name = sw.dataset.toggle;
      try {
        await post("/api/integrations/toggle", { name, enabled: sw.checked });
        toast(`${sw.checked ? "Enabled" : "Disabled"} ${name}`);
        await loadStatusOnce();
        render();
      } catch (e) {
        toast(e.message);
        sw.checked = !sw.checked;
      }
    };
  });

  // Save new key
  $$("[data-savekey]", el).forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.savekey;
      const inp = $(`#input-${name}`);
      const val = inp?.value?.trim();
      if (!val) return toast("Enter a key first");
      try {
        await post("/api/integrations/key", { name, value: val });
        inp.value = "";
        toast(`Updated key for ${name}`);
        await loadStatusOnce();
        render();
      } catch (e) { toast(e.message); }
    };
  });

  // Remove key
  $$("[data-remkey]", el).forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.remkey;
      if (!confirm(`Remove key for ${name} from .env?`)) return;
      try {
        await post("/api/integrations/remove", { name });
        toast(`Removed key for ${name}`);
        await loadStatusOnce();
        render();
      } catch (e) { toast(e.message); }
    };
  });

  // Test connection
  $$("[data-test]", el).forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.test;
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        const res = await post("/api/integrations/test", { name });
        toast(res.message, 4500);
      } catch (e) {
        toast(`Test failed: ${e.message}`, 5000);
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Connection";
      }
    };
  });
}
