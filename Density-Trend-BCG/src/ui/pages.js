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
  const chartView = S.chartView || ls.get("chartView") || "momentum";
  S.chartView = chartView;

  el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="ctl">${levelSeg()}
    <div class="seg" id="gseg"><button data-g="hour" class="${S.gran === "hour" ? "on" : ""}">Hourly</button><button data-g="day" class="${S.gran === "day" ? "on" : ""}">Daily</button></div>
    <label>Topic <select id="tsel" style="max-width:340px">${rows.map((r) => `<option value="${esc(r.key)}"${r.key === S.sel ? " selected" : ""}>${esc(r.name)} · ${x2(r.ratio)} · ${r.stage === "watch" ? "watchlist" : r.stage}</option>`).join("")}</select></label>
    <span class="mute small">As of ${dt(L.asOf)} · recent window ${L.params.recentHours}h vs ${L.history.baselineHours}h baseline</span></div></div>
  <div class="grid g-8-4">
    <div class="card">
      <div class="sec-h" style="margin:0 0 8px">
        <div><h3 id="mname"></h3><p class="hint" style="margin:0">Use hourly for breaking events and daily for longer themes.</p></div>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="chart-view-seg" id="cviewseg">
            <button data-cv="momentum" class="${chartView === "momentum" ? "on" : ""}" title="Volume bars, coverage share line &amp; confidence band forecast">📈 Forecast &amp; Momentum</button>
            <button data-cv="candlestick" class="${chartView === "candlestick" ? "on" : ""}" title="Candlestick OHLC coverage share surges &amp; volume">🕯️ Candlestick</button>
            <button data-cv="both" class="${chartView === "both" ? "on" : ""}" title="View both charts stacked">📊 Stacked</button>
          </div>
          <div id="mstage"></div>
        </div>
      </div>
      <div class="cl" id="mleg"></div>
      <div class="chart" id="mchart"><div class="skel" style="height:300px"></div></div>
      <div id="mline"></div>
      <div class="ctl" style="margin-top:8px" id="mtog"></div><div id="mcmp" class="ctl" style="margin-top:6px"></div><p class="small mute" id="mrule" style="margin:8px 0 0"></p>
    </div>
    <div class="grid" style="align-content:start" id="mrightcol">
      <!-- Adjacent stories card for candle click (sits adjacent to the chart) -->
      <div class="card" id="mcandlestories" style="display:none;border:1.5px solid var(--brand);background:var(--surface);padding:16px 18px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div class="tiny mute b" style="letter-spacing:.05em;text-transform:uppercase">Interval Coverage Stories</div>
            <h3 id="mcandletitle" style="font-size:15px;margin:2px 0 0;color:var(--ink)">Stories Behind Candle</h3>
          </div>
          <button class="btn ghost sm" id="mcandleclose" title="Dismiss adjacent view" style="padding:2px 8px;font-size:12px;cursor:pointer">✕ Close</button>
        </div>
        <div id="mcandlesub" class="small" style="margin-bottom:10px"></div>
        <div id="mcandlelist" style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px"></div>
      </div>

      <div class="card" id="mkpicard"><h3>Current metrics</h3><div id="mkpi"></div></div>
      <div class="card" id="msi"></div>
      <div class="card" id="msoc"></div>
    </div>
  </div>

  <div class="grid g-5-7" style="margin-top:16px">
    <div>
      <!-- Story tracking summary -->
      <div class="card" style="margin-bottom:14px">
        <div class="sec-h" style="margin:0 0 6px">
          <div>
            <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:6px">📊 Story Tracking &amp; Publication Reach</h3>
            <p class="hint" style="margin:2px 0 0">Tracking coverage density, news velocity and publication reach across India and global media.</p>
          </div>
        </div>
        <div class="story-tracker-bar" id="mtracker"></div>
        <div id="moutlets" class="small mute"></div>
      </div>

      <!-- Specific-Based News & Geographical Intelligence -->
      <div class="card" style="margin-bottom:14px">
        <div class="sec-h" style="margin:0 0 6px">
          <div>
            <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:6px">📍 Specific News &amp; Geographical Breakdown</h3>
            <p class="hint" style="margin:2px 0 0">Filter from broad worldwide trends down to city-specific events (e.g. Mumbai, Delhi) and tailored editorial angles.</p>
          </div>
          <span class="small b" id="mactivefilter"></span>
        </div>
        <div class="geo-filter-bar" id="mgeobar"></div>
        <div id="meventclusters"></div>
      </div>

      <!-- Evidence Stories -->
      <div class="card">
        <div class="sec-h" style="margin:0 0 8px">
          <div>
            <h3 id="mevtitle">Evidence Stories</h3>
            <p class="hint" id="mevsubtitle" style="margin:0">Most significant verified stories in the window.</p>
          </div>
          <button class="btn ghost sm" id="mclearfilter" style="display:none">Show All Stories</button>
        </div>
        <div id="mev"><div class="skel"></div></div>
      </div>
    </div>

    <!-- Momentum board -->
    <div class="card flush" style="position:sticky;top:76px;align-self:start">
      <div style="padding:16px 16px 0"><h3>Momentum board</h3><p class="hint">Every topic ranked by momentum. Click a row to chart it.</p></div>
      <div class="tw" style="max-height:calc(100vh - 230px)">
        <table class="t">
          <thead><tr><th>Topic</th><th>Stage</th><th class="r">Momentum${info("momentum")}</th><th class="r">Accel.${info("accel")}</th><th class="r">Share${info("share")}</th><th>Trend</th><th class="r">Origins${info("origins")}</th><th>Evidence</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr class="click${r.key === S.sel ? " sel" : ""}" data-topic="${esc(r.key)}"><td class="b">${esc(r.name)}${r.parentName ? ` <span class="mute tiny">${esc(r.parentName)}</span>` : ""}</td><td>${stagePill(r.stage)}</td><td class="r num b">${x2(r.ratio)}</td><td class="r num">${r.accel == null ? "–" : (r.accel >= 0 ? "+" : "") + r.accel.toFixed(2)}</td><td class="r num">${pct(r.share)}</td><td>${spark(r.spark)}</td><td class="r num">${originsLink(r.originsRecent, r.key, r.name)}</td><td>${evPill(r.evidence)}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  bindLevelSeg();
  $$("#gseg button").forEach((b) => (b.onclick = () => { S.gran = b.dataset.g; ls.set("gran", S.gran); render(); }));
  $("#tsel").onchange = (e) => { S.sel = e.target.value; S.compare.clear(); render(); };
  $$("[data-topic]", el).forEach((r) => (r.onclick = () => { S.sel = r.dataset.topic; S.compare.clear(); window.scrollTo(0, 0); render(); }));

  $("#mname").innerHTML = esc(cur.name) + info("momentumChart");
  $("#mstage").innerHTML = `${stagePill(cur.stage)} ${evPill(cur.evidence)}`;
  $("#mrule").innerHTML = `<b>Stage rule:</b> ${esc(cur.stageRule)}`;
  $("#mkpi").innerHTML = [["Coverage share", pct(cur.share), `baseline ${pct(cur.baseShare)}`], ["Momentum", x2(cur.ratio), `previous step ${x2(cur.ratioPrev)}`], ["Acceleration", cur.accel == null ? "–" : (cur.accel >= 0 ? "+" : "") + cur.accel.toFixed(2), "Δ log₂ momentum"], ["Coverage volume", cur.count, `of ${n0(cur.total)} stories in ${cur.windowHours}h`], ["Independent origins", cur.originsRecent, `${cur.originsTotal} over the whole window`], ["Impact breadth", cur.areaCount, (cur.areas || []).slice(0, 3).join(", ") || "impact areas"]].map(([l, v, s]) => `<div class="compo" style="grid-template-columns:150px 1fr"><span>${lbl(l, { ...DRAWER_TIP, "Coverage volume": "stories" }[l])}</span><span><b class="num">${l === "Independent origins" ? originsLink(v, cur.key, cur.name) : v}</b> <span class="mute tiny">${esc(s)}</span></span></div>`).join("");

  const sels = [S.sel, ...S.compare];
  const [ser, top] = await Promise.all([
    api(`/api/series?keys=${sels.map(encodeURIComponent).join(",")}&gran=${S.gran}${S.date ? `&date=${S.date}` : ""}`),
    api(`/api/topic?${qs(`&key=${encodeURIComponent(S.sel)}`)}`),
  ]);
  const main = ser.series[S.sel], cmps = [...S.compare].map((k) => ({ name: ser.series[k]?.name ?? k, s: ser.series[k] })).filter((c) => c.s);

  // ---- Specific News & Geographical Breakdown ----
  let allStories = top.allStories || top.stories || [];
  let curGeo = "all";
  let curEventId = null;

  const renderStories = (list, subtitle = "Most significant verified stories in the window.") => {
    $("#mevsubtitle").textContent = subtitle;
    $("#mev").innerHTML = list.map((s) => `
      <div class="story">
        <a class="h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
        <div style="margin:3px 0">
          ${s.verified ? `<span class="pill p-ok">verified</span> ` : ""}
          ${s.primary ? `<span class="pill p-high">primary source</span> ` : ""}
          ${s.sentiment ? `<span class="tag" style="background:${s.sentiment === "negative" ? "rgba(242,54,69,0.12);color:#f23645" : "rgba(8,153,129,0.12);color:#089981"};font-weight:600">${esc(s.sentiment)}</span> ` : ""}
          ${s.geography?.length ? `<span class="tag" style="background:var(--brand-soft);color:var(--brand);font-weight:600">📍 ${s.geography.map(esc).join(", ")}</span>` : ""}
          <span class="tag">${s.outlets} outlet${s.outlets > 1 ? "s" : ""} → ${s.origins} origin${s.origins > 1 ? "s" : ""}</span>
          <span class="tag">${s.fullText ? "full text" : "headline only"}</span>
          ${s.contentType ? `<span class="tag">${esc(s.contentType)}</span>` : ""}
          <span class="tag">${dt(s.publishedAt)}</span>
        </div>
        ${s.summary ? `<div class="small mute">${esc(s.summary)}</div>` : ""}
      </div>
    `).join("") || `<span class="mute">No stories found for this specific filter.</span>`;
  };

  const handleCandleStoryFilter = (candle, idx, ser) => {
    if (!candle) return;
    const binMs = main.binMs || (S.gran === "day" ? 86400e3 : 3600e3);
    const tFrom = candle.t, tTo = candle.t + binMs;
    let candleStories = candle.stories || [];
    if (!candleStories.length) {
      candleStories = allStories.filter((s) => s.publishedAt >= tFrom && s.publishedAt < tTo);
    }

    const timeLabel = fmtT(candle.t, S.gran);
    const isNeg = candle.sentiment === "negative" || (candle.sentimentNet != null && candle.sentimentNet < 0);
    const sentText = candle.sentiment || (isNeg ? "negative" : "positive / neutral");

    // 1. Populate and show ADJACENT stories panel right next to the chart
    const adjCard = $("#mcandlestories");
    const adjTitle = $("#mcandletitle");
    const adjSub = $("#mcandlesub");
    const adjList = $("#mcandlelist");
    const adjClose = $("#mcandleclose");
    const filterIndicator = $("#mactivefilter");
    const clearBtn = $("#mclearfilter");

    if (adjCard && adjTitle && adjList) {
      adjTitle.innerHTML = `Stories on ${esc(timeLabel)} <span class="badge" style="background:var(--brand);color:#fff;margin-left:4px;font-size:11px">${candleStories.length}</span>`;
      adjSub.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          <span class="tag b">📊 Share: ${pct(candle.close)}</span>
          <span class="tag">📦 Vol: ${candle.volume || candleStories.length} stor${(candle.volume || candleStories.length) === 1 ? "y" : "ies"}</span>
          <span class="tag" style="background:${isNeg ? 'rgba(242,54,69,0.12);color:#f23645' : 'rgba(8,153,129,0.12);color:#089981'};font-weight:700">${esc(sentText)}</span>
          ${candle.isHammer ? '<span class="tag">🔨 Hammer</span>' : ''}
        </div>
      `;

      adjList.innerHTML = candleStories.map((s) => `
        <div class="story-item" style="padding:10px 12px;background:var(--surface2);border:1px solid var(--line);border-radius:8px">
          <a class="h" href="${esc(s.url)}" target="_blank" rel="noopener" style="font-weight:600;font-size:13px;line-height:1.35;color:var(--brand);display:block">${esc(s.title)}</a>
          <div style="margin:4px 0 2px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
            ${s.sentiment ? `<span class="tag" style="background:${s.sentiment === "negative" ? "rgba(242,54,69,0.12);color:#f23645" : "rgba(8,153,129,0.12);color:#089981"};font-weight:700;font-size:10px">${esc(s.sentiment)}</span>` : ""}
            ${s.verified ? `<span class="pill p-ok" style="font-size:10px;padding:1px 6px">verified</span>` : ""}
            ${s.primary ? `<span class="pill p-high" style="font-size:10px;padding:1px 6px">primary</span>` : ""}
            ${s.geography?.length ? `<span class="tag" style="background:var(--brand-soft);color:var(--brand);font-weight:600;font-size:10px">📍 ${s.geography.map(esc).join(", ")}</span>` : ""}
            <span class="tag" style="font-size:10px">${s.outlets || 1} outlet${(s.outlets || 1) > 1 ? "s" : ""}</span>
            <span class="tag mute" style="font-size:10px">${dt(s.publishedAt)}</span>
          </div>
          ${s.summary ? `<div class="small mute" style="margin-top:4px;line-height:1.35">${esc(clip(s.summary, 130))}</div>` : ""}
        </div>
      `).join("") || `<div class="empty" style="padding:16px">No explicit stories recorded for this interval (baseline extrapolation).</div>`;

      adjCard.style.display = "";

      if (adjClose) {
        adjClose.onclick = () => {
          adjCard.style.display = "none";
          document.querySelectorAll(".candle-selection-highlight").forEach((el) => el.remove());
          if (clearBtn) clearBtn.style.display = "none";
          if (filterIndicator) filterIndicator.innerHTML = "";
          renderStories(allStories, "Most significant verified stories across all locations.");
          const mevTitle = $("#mevtitle");
          if (mevTitle) mevTitle.textContent = "Evidence Stories";
        };
      }
    }

    // 2. Also keep the lower Evidence Stories in sync (WITHOUT scrolling down)
    if (filterIndicator) {
      filterIndicator.innerHTML = `<span class="pill p-ok" style="background:var(--brand);color:#fff">🕯️ Candle: ${esc(timeLabel)} (${candleStories.length} stories)</span>`;
    }
    if (clearBtn) clearBtn.style.display = "";

    const mevTitle = $("#mevtitle");
    if (mevTitle) mevTitle.textContent = `Stories Behind Selected Candle · ${esc(timeLabel)}`;
    renderStories(
      candleStories,
      `Showing ${candleStories.length} stories recorded for ${timeLabel} (Coverage Share: ${pct(candle.close)}, Volume: ${candle.volume || candleStories.length} stories).`
    );

    // Adjacent display visible right next to chart - no scrolling down needed!
    toast(`Viewing ${candleStories.length} stories adjacent to chart for ${timeLabel}`);
  };

  const draw = () => {
    const cv = S.chartView || "momentum";
    if (cv === "candlestick") {
      HC.candlestick($("#mchart"), main, { show: S.show, onCandleClick: handleCandleStoryFilter });
      $("#mleg").innerHTML = `<span><i style="background:#089981;border-radius:2px"></i>Positive &amp; Neutral (Green)</span><span><i style="background:#f23645;border-radius:2px"></i>Negative (Red)</span><span><i style="background:#f23645;border-radius:2px"></i>🔨 Hammer (Volume decline)</span><span><i class="ln" style="background:#2962ff"></i>MA(7) Trend</span><span><i class="dash"></i>Forecast 72h</span><span>◆ Verified Trigger</span>`;
    } else if (cv === "both") {
      $("#mchart").innerHTML = `<div id="mch-mom" style="margin-bottom:16px"></div><div class="sec-h" style="margin:14px 0 6px"><h4 style="margin:0;font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em">Candlestick Coverage Momentum (OHLC)</h4></div><div id="mch-cand"></div>`;
      HC.momentum($("#mch-mom"), main, { compare: cmps, show: S.show, onCandleClick: handleCandleStoryFilter });
      HC.candlestick($("#mch-cand"), main, { show: S.show, onCandleClick: handleCandleStoryFilter });
      $("#mleg").innerHTML = `<span><i style="background:var(--bars-strong);opacity:.7"></i>stories volume</span><span><i class="ln" style="background:var(--line-share)"></i>coverage share</span><span><i style="background:#089981"></i>positive</span><span><i style="background:#f23645"></i>negative</span><span><i style="background:#f23645"></i>🔨 hammer</span><span><i class="dash"></i>forecast</span>`;
    } else {
      HC.momentum($("#mchart"), main, { compare: cmps, show: S.show, onCandleClick: handleCandleStoryFilter });
      $("#mleg").innerHTML = `<span><i style="background:var(--bars-strong);opacity:.7"></i>coverage volume (stories)</span><span><i class="ln" style="background:var(--line-share)"></i>coverage share</span><span><i class="ln" style="background:var(--line-avg)"></i>${main.rollingWindow}${S.gran === "day" ? "-day" : "h"} rolling average</span>${cmps.map((c, i) => `<span><i class="ln" style="background:${HC.PAL[i % 4]}"></i>${esc(c.name)} (share)</span>`).join("")}<span><i class="dash"></i>forecast ${main.forecast?.validated ? "(validated)" : "(unvalidated)"}</span><span>◆ verified trigger</span>`;
    }
  };

  $$("#cviewseg button").forEach((b) => (b.onclick = () => {
    S.chartView = b.dataset.cv;
    ls.set("chartView", S.chartView);
    $$("#cviewseg button").forEach((x) => x.classList.toggle("on", x === b));
    draw();
  }));

  $("#mtog").innerHTML = [["bars", "Volume bars"], ["share", "Coverage share"], ["avg", "Rolling average"], ["forecast", "Forecast"]].map(([k, l]) => `<label class="chk"><input type="checkbox" data-sh="${k}" ${S.show[k] ? "checked" : ""}> ${l}</label>`).join("") + (main.forecast.available ? "" : `<span class="small mute">Forecast unavailable: ${esc(main.forecast.reason)}</span>`);
  $$("[data-sh]").forEach((c) => (c.onchange = () => { S.show[c.dataset.sh] = c.checked; draw(); }));
  $("#mcmp").innerHTML = `<span class="small mute">Compare with:</span>${(top.related ?? []).slice(0, 6).map((r) => `<label class="chk"><input type="checkbox" data-cmp="${esc(r.key)}" ${S.compare.has(r.key) ? "checked" : ""}> ${esc(r.name)}</label>`).join("") || `<span class="small mute">no overlapping topics</span>`}`;
  $$("[data-cmp]").forEach((c) => (c.onchange = () => { c.checked ? S.compare.add(c.dataset.cmp) : S.compare.delete(c.dataset.cmp); render(); }));
  draw();
  $("#mline").innerHTML = xForecastLine(main, { ...cur, baselineHours: L.history?.baselineHours });
  $("#mrule").innerHTML += ` ${xSeasonChip(top.seasonality)}`;
  if (top.sentiment) $("#mkpi").insertAdjacentHTML("beforeend", `<div style="margin-top:10px"><span class="tiny mute b">SENTIMENT${info("sentimentNet")}</span>${xSentStrip(top.sentiment)}</div>`);

  // ---- Story Tracking & Velocity ----
  const trk = top.storyTracking || {};
  $("#mtracker").innerHTML = `
    <div class="story-tracker-pill"><span class="num">${n0(trk.totalCount ?? cur.count)}</span> <span>Total Stories Tracked</span></div>
    <div class="story-tracker-pill"><span class="num">${n0(trk.recent72hCount ?? cur.count)}</span> <span>Last 72 Hours</span></div>
    <div class="story-tracker-pill ${trk.growth24h != null && trk.growth24h > 0 ? "growth" : ""}"><span class="num">${n0(trk.recent24hCount ?? 0)}</span> <span>Last 24h ${trk.growth24h != null ? `(${trk.growth24h >= 0 ? "+" : ""}${trk.growth24h}% surge)` : ""}</span></div>
    <div class="story-tracker-pill"><span class="num">${trk.outletsCount ?? 0}</span> <span>News Publications</span></div>
    <div class="story-tracker-pill"><span class="num">${cur.originsRecent ?? 0}</span> <span>Independent Origins</span></div>
  `;
  if (trk.topOutlets?.length) {
    $("#moutlets").innerHTML = `<b>Top reporting outlets:</b> ${trk.topOutlets.map((o) => `${esc(o.name)} <span class="mute">(${o.count})</span>`).join(" · ")}`;
  }

  renderStories(allStories);

  // Render Geo Pills
  const geos = top.geoBreakdown || [];
  const geoBar = $("#mgeobar");
  geoBar.innerHTML = `
    <button class="geo-pill active" data-geo="all">🌐 All Coverage <span class="badge">${trk.recent72hCount ?? allStories.length}</span></button>
    ${geos.map((g) => `<button class="geo-pill" data-geo="${esc(g.name)}">📍 ${esc(g.name)} <span class="badge">${g.recentCount || g.count}</span></button>`).join("")}
  `;

  // Render Event Clusters & Tailored BCG MDP Angles grouped by geographical area
  const clusters = top.eventClusters || [];
  const clBox = $("#meventclusters");
  if (clusters.length) {
    // Group event clusters and their MDP angles by geographical area
    const geoGroupMap = new Map();
    for (const cl of clusters) {
      const loc = cl.location || "National / Regional";
      if (!geoGroupMap.has(loc)) {
        geoGroupMap.set(loc, {
          location: loc,
          clusters: [],
          mdpAngles: [],
          totalStories: 0
        });
      }
      const group = geoGroupMap.get(loc);
      group.clusters.push(cl);
      group.totalStories += cl.storyCount || 0;
      for (const ang of (cl.mdpAngles || [])) {
        group.mdpAngles.push({ ...ang, cluster: cl });
      }
    }
    const geoGroups = Array.from(geoGroupMap.values()).sort((a, b) => b.totalStories - a.totalStories);
    const allMdpAngles = geoGroups.flatMap((g) => g.mdpAngles);

    clBox.innerHTML = `
      <div class="mdp-showcase-container">
        <div class="mdp-showcase-header">
          <div>
            <h3>🏛️ BCG MDP THOUGHT LEADERSHIP &amp; STRATEGIC ADVISORY BOARD (${allMdpAngles.length})</h3>
            <div class="mdp-showcase-sub">${allMdpAngles.length ? "Executive POV and boardroom advisory briefs grouped by geographical region with localized incident intelligence." : "No BCG op-ed angle for these events: they are not business events (e.g. sport or entertainment), or the topic was judged not relevant to any BCG sector. The events and stories are still listed below."}</div>
          </div>
        </div>

        <div class="mdp-geo-groups-list">
          ${geoGroups.map((g) => `
            <div class="mdp-geo-group" data-geogroup="${esc(g.location)}">
              <div class="mdp-geo-header">
                <div class="mdp-geo-title">
                  <span class="mdp-geo-name">📍 ${esc(g.location)}</span>
                  <span class="badge b">📊 ${g.totalStories} stories tracked</span>
                  <span class="badge">${g.clusters.length} event incident${g.clusters.length > 1 ? "s" : ""}</span>
                </div>
                <button class="btn sm ghost" data-filtgeo="${esc(g.location)}">Filter ${esc(g.location)} stories →</button>
              </div>

              <div class="mdp-advisory-grid">
                ${g.mdpAngles.map((ang) => {
                  const cl = ang.cluster;
                  return `
                    <div class="mdp-advisory-card" data-evid="${esc(cl.id)}" data-angid="${esc(ang.id)}" data-cardgeo="${esc(g.location)}">
                      <div class="mdp-card-topbar">
                        <div class="mdp-card-badges">
                          <span class="mdp-practice-tag">🏢 ${esc(ang.practice || "BCG Practice Area")}</span>
                          <span class="mdp-role-pill">👤 ${esc(ang.role)}</span>
                          <span class="mdp-format-pill">${esc(ang.editorialFormat || "Op-Ed / Executive Leadership Column")}</span>
                        </div>
                        <div class="mdp-card-meta">
                          <span class="tag">📍 ${esc(cl.location)}</span>
                          <span class="tag b">📊 ${cl.storyCount} stories tracked</span>
                        </div>
                      </div>

                      <h3 class="mdp-card-headline">${esc(ang.title)}</h3>

                      <div class="mdp-thesis-box">
                        <div class="mdp-box-lbl">EXECUTIVE POINT OF VIEW (POV)</div>
                        <div class="mdp-thesis-text">${esc(ang.thesis || ang.angle)}</div>
                      </div>

                      ${ang.boardroomQuestions?.length ? `
                        <div class="mdp-questions-section">
                          <div class="mdp-box-lbl">KEY C-SUITE / BOARD QUESTIONS &amp; STRATEGIC ANGLES</div>
                          <ul class="mdp-questions-list">
                            ${ang.boardroomQuestions.map((q) => {
                              const colonIdx = q.indexOf(":");
                              if (colonIdx > 0 && colonIdx < 35) {
                                const prefix = q.slice(0, colonIdx);
                                const rest = q.slice(colonIdx + 1);
                                return `<li><b>${esc(prefix)}:</b>${esc(rest)}</li>`;
                              }
                              return `<li>${esc(q)}</li>`;
                            }).join("")}
                          </ul>
                        </div>
                      ` : ""}

                      <div class="mdp-card-footer">
                        <div class="mdp-outlet-hint">
                          <b>Target Outlets:</b> ${esc(ang.targetOutlets || "The Economic Times, Mint, BCG Henderson Institute")}
                        </div>
                        <div class="mdp-actions">
                          <button class="btn sm ghost" data-copybrief="${esc(ang.id)}">📋 Copy Advisory Brief</button>
                          <button class="btn sm" data-filtevid="${esc(cl.id)}">Filter ${cl.storyCount} Stories →</button>
                        </div>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>

              <div class="mdp-geo-incidents">
                <div class="mdp-incidents-subhead">
                  <span class="tiny mute b" style="letter-spacing:.05em">📍 DETECTED EVENT INCIDENTS IN ${esc(g.location.toUpperCase())} (${g.clusters.length})</span>
                  <span class="tiny mute">Click an incident to filter</span>
                </div>
                <div class="incident-strip-grid">
                  ${g.clusters.map((cl) => `
                    <div class="incident-card" data-evid="${esc(cl.id)}">
                      <div class="incident-card-loc">📍 ${esc(cl.location)} · <span style="font-weight:normal">${esc(cl.eventType)}</span></div>
                      <div class="incident-card-title">${esc(clip(cl.title, 68))}</div>
                      <div class="incident-card-meta">
                        <span><b>${cl.storyCount}</b> stories</span>
                        <span><b>${cl.outletsCount}</b> outlets</span>
                        ${cl.entities?.length ? `<span class="mute">${esc(cl.entities.slice(0, 2).join(", "))}</span>` : ""}
                      </div>
                    </div>
                  `).join("")}
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    // Bind Copy Advisory Brief buttons
    $$("[data-copybrief]", clBox).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const angId = btn.dataset.copybrief;
        const targetAng = allMdpAngles.find((a) => a.id === angId);
        if (!targetAng) return;
        const cl = targetAng.cluster;
        const text = [
          `BCG MDP STRATEGIC ADVISORY & THOUGHT LEADERSHIP BRIEF`,
          `=====================================================`,
          `PRACTICE AREA: ${targetAng.practice || "BCG Advisory"}`,
          `TARGET MDP:    ${targetAng.role}`,
          `FORMAT:        ${targetAng.editorialFormat || "Op-Ed / Executive Leadership Column"}`,
          `GEOGRAPHY:     ${cl.location} (${cl.storyCount} stories tracked across ${cl.outletsCount} outlets)`,
          ``,
          `HEADLINE:`,
          targetAng.title,
          ``,
          `EXECUTIVE POINT OF VIEW (POV):`,
          targetAng.thesis || targetAng.angle,
          ``,
          `KEY C-SUITE / BOARD QUESTIONS & STRATEGIC ANGLES:`,
          ...(targetAng.boardroomQuestions || []).map((q, i) => `${i + 1}. ${q}`),
          ``,
          `TARGET AUDIENCE:`,
          targetAng.targetAudience || "CEOs, Board Risk Committees, Regulators, and Infrastructure Investors",
          ``,
          `RECOMMENDED MEDIA PLACEMENT:`,
          targetAng.targetOutlets || "The Economic Times, Mint, BCG Henderson Institute, Financial Express",
          ``,
          `PITCH SUMMARY:`,
          targetAng.pitch || targetAng.thesis
        ].join("\n");

        navigator.clipboard?.writeText(text);
        toast("📋 Advisory brief copied to clipboard!");
      };
    });
  } else {
    clBox.innerHTML = `<div class="small mute" style="margin:8px 0">No distinct sub-event incidents clustered yet.</div>`;
  }

  // Handle Geo filter clicks
  const clearBtn = $("#mclearfilter");
  const filterIndicator = $("#mactivefilter");

  const applyGeoFilter = (target) => {
    curGeo = target;
    curEventId = null;
    $$(".geo-pill", geoBar).forEach((b) => b.classList.toggle("active", b.dataset.geo === target));
    $$(".incident-card", clBox).forEach((c) => c.classList.remove("active"));
    $$(".mdp-advisory-card", clBox).forEach((c) => { c.classList.remove("active"); c.style.display = ""; });
    $$(".mdp-geo-group", clBox).forEach((grp) => {
      if (target === "all") {
        grp.style.display = "";
      } else {
        const grpLoc = grp.dataset.geogroup?.toLowerCase() || "";
        const match = grpLoc === target.toLowerCase() || grpLoc.includes(target.toLowerCase()) || target.toLowerCase().includes(grpLoc);
        grp.style.display = match ? "" : "none";
      }
    });
    if (target === "all") {
      filterIndicator.textContent = "";
      clearBtn.style.display = "none";
      renderStories(allStories, "Most significant verified stories across all locations.");
    } else {
      filterIndicator.innerHTML = `<span class="pill p-ok">Filtered by: 📍 ${esc(target)}</span>`;
      clearBtn.style.display = "";
      const filtered = allStories.filter((s) => (s.geography || []).some((g) => g.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(g.toLowerCase())));
      renderStories(filtered, `Showing ${filtered.length} stories specifically in and around ${target}.`);
    }
  };

  const applyEventFilter = (evId) => {
    curEventId = evId;
    const targetCluster = clusters.find((c) => c.id === evId);
    if (!targetCluster) return;
    $$(".geo-pill", geoBar).forEach((b) => b.classList.remove("active"));
    $$(".incident-card", clBox).forEach((c) => c.classList.toggle("active", c.dataset.evid === evId));
    $$(".mdp-geo-group", clBox).forEach((grp) => {
      const hasCluster = grp.querySelector(`[data-evid="${evId}"]`);
      grp.style.display = hasCluster ? "" : "none";
    });
    $$(".mdp-advisory-card", clBox).forEach((c) => {
      const match = c.dataset.evid === evId;
      c.style.display = (evId && !match) ? "none" : "";
      c.classList.toggle("active", match);
    });
    filterIndicator.innerHTML = `<span class="pill p-ok">Event Incident: 📍 ${esc(targetCluster.location)}</span>`;
    clearBtn.style.display = "";
    renderStories(targetCluster.stories, `Showing ${targetCluster.stories.length} stories for specific event: ${targetCluster.title}`);
    window.scrollTo({ top: $("#mevtitle").offsetTop - 80, behavior: "smooth" });
  };

  $$("[data-geo]", geoBar).forEach((b) => (b.onclick = () => applyGeoFilter(b.dataset.geo)));
  $$("[data-filtgeo]", clBox).forEach((b) => (b.onclick = () => applyGeoFilter(b.dataset.filtgeo)));
  $$("[data-filtevid]", clBox).forEach((b) => (b.onclick = () => applyEventFilter(b.dataset.filtevid)));
  $$(".incident-card", clBox).forEach((c) => (c.onclick = () => applyEventFilter(c.dataset.evid)));

  clearBtn.onclick = () => {
    const mevTitle = $("#mevtitle");
    if (mevTitle) mevTitle.textContent = "Evidence Stories";
    const adjCard = $("#mcandlestories");
    if (adjCard) adjCard.style.display = "none";
    document.querySelectorAll(".candle-selection-highlight").forEach((el) => el.remove());
    applyGeoFilter("all");
  };

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

  // X (Twitter) trending status
  const msoc = $("#msoc");
  if (msoc) {
    msoc.innerHTML = `<div class="sec-h" style="margin:0 0 8px"><div style="display:flex;align-items:center;gap:8px"><span style="background:#1d9bf0;color:#fff;width:24px;height:24px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">𝕏</span><h3 style="margin:0">Twitter / X Trending Status</h3></div><div id="msoctoggle"></div></div><div id="msocbody"><div class="skel" style="height:70px"></div></div>`;
    try {
      const xt = await api("/api/xtrends").catch(() => null);
      const trends = xt?.trends || [];
      const topName = (cur.name || "").toLowerCase();
      const topClean = topName.replace(/[^a-z0-9]/g, "");
      const match = trends.find((t) => {
        const raw = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return raw && topClean.length >= 4 && (raw.includes(topClean) || topClean.includes(raw));
      });
      if (match) {
        $("#msocbody").innerHTML = `<div style="background:rgba(29,155,240,0.06);border:1px solid rgba(29,155,240,0.3);border-radius:8px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between"><div><span class="pill" style="background:#1d9bf0;color:#fff;font-weight:700">● Trending on 𝕏 (Rank #${match.rank})</span> <span class="tag" style="font-weight:700;margin-left:6px">${esc(match.name)}</span> ${match.count ? `<span class="small mute">(${esc(match.count)} tweets)</span>` : ""}</div><span class="tag">Top 70 Live Mirror</span></div>`;
      } else {
        $("#msocbody").innerHTML = `<div style="background:var(--surface2);border:1px dashed var(--line);border-radius:8px;padding:12px 14px"><span class="pill p-muted">○ Not Trending on 𝕏</span> <span class="small mute" style="margin-left:8px">This topic is not currently in India's Top 70 Twitter trends. Driven by news publication coverage.</span></div>`;
      }
    } catch {
      $("#msocbody").innerHTML = `<div class="small mute">Could not load Twitter trends.</div>`;
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
  <div class="card"><div class="sec-h" style="margin:0"><div><h3>${esc(c.name)} <span class="mute" style="font-weight:400">· ${c.sectors.length} sectors</span></h3><p class="hint" style="margin:0">${c.sectors.map((s) => `${esc(s.name)}${s.description ? ` (${esc(clip(s.description, 35))})` : ""}`).join(" · ")}</p></div><div style="display:flex;gap:6px;align-items:center"><button class="btn sm" id="seditsec">✏️ Edit Sectors &amp; Scope</button>${c.builtin ? "" : `<button class="btn bad sm" id="cdel">Remove</button>`}</div></div>
    ${done < total && d.llm.ok ? `<p class="small mute" style="margin:10px 0 4px">Matching news areas to ${esc(c.name)}’s sectors: ${done}/${total} judged</p><div class="bar"><i style="width:${(100 * done) / Math.max(1, total)}%"></i></div>` : ""}
    <details style="margin-top:12px"><summary>Upload or paste another company’s sectors</summary><div class="grid g2" style="margin-top:10px"><div><p class="small mute">Accepted: <b>.csv</b> (a <span class="code">sector</span> column, optional <span class="code">description</span>), <b>.txt</b> (one sector per line; first line may be <span class="code">Company: Name</span>) or <b>.json</b>. Uploading the same name again replaces its sectors.</p><label class="f">Company name</label><input type="text" id="uname"><label class="f">File</label><input type="file" id="ufile" accept=".csv,.txt,.json"></div><div><label class="f">…or paste sectors, one per line</label><textarea id="utext" placeholder="Retail banking&#10;General insurance&#10;Consumer lending"></textarea><p style="margin:8px 0 0"><button class="btn" id="usend">Analyse company</button> <span class="small mute" id="ustatus"></span></p></div></div></details></div>
  <section class="grid g-7-5" style="margin-top:16px">
    <div class="card"><h3>Exposure by sector</h3><p class="hint">Σ news-area density × relevance. <span class="cl" style="display:inline-flex;margin:0 0 0 8px"><span><i style="background:var(--bars-strong)"></i>direct</span><span><i style="background:var(--forecast)"></i>indirect (second-order)</span></span></p>
      ${c.sectorsView.map((s) => `<div class="hb click${s.name === S.selSector ? " sel" : ""}" data-sector="${esc(s.name)}" style="${s.name === S.selSector ? "background:var(--brand-soft)" : ""}"><span title="${esc(s.name)}">${esc(clip(s.name, 28))}</span><div class="bar" style="display:flex;background:var(--line)"><i style="width:${(100 * s.direct) / mx}%;background:var(--bars-strong);border-radius:3px 0 0 3px"></i><i style="width:${(100 * s.indirect) / mx}%;background:var(--forecast);border-radius:0 3px 3px 0"></i></div><span class="num small" style="text-align:right">${fmt1(s.total)}</span></div>`).join("")}</div>
    <div class="card"><h3>${esc(sel?.name ?? "Sector")} — drivers</h3>${sel?.description ? `<p class="small mute"><b>Sector Scope:</b> ${esc(sel.description)}</p>` : ""}${sel?.drivers.length ? sel.drivers.map((x) => `<div class="story"><b>${esc(x.name)}</b><div style="margin:3px 0"><span class="tag">${esc(x.channel)}</span><span class="tag">${esc(x.front.replace("_", " "))}</span><span class="tag">relevance ${x.relevance.toFixed(1)}</span></div><div class="small mute">${esc(x.why)}</div>${x.writeAbout ? `<div class="small" style="margin-top:3px">${esc(x.writeAbout)}</div>` : ""}</div>`).join("") : `<span class="mute">No news areas matched this sector yet.</span>`}</div>
  </section>
  <section class="grid g2" style="margin-top:16px"><div class="card"><h3>Sector density over time</h3><p class="hint">Darker = more weighted news pressure in that window.</p><div id="stime"></div></div><div class="card"><h3>At what front?</h3><p class="hint">Sector × the channel through which the impact reaches it.</p><div id="sfronts"></div></div></section>
  <section class="grid g3" style="margin-top:16px"><div class="card"><h3>Who and what is impacted</h3>${hbars(d.impactAreas.slice(0, 12), { label: (a) => a[0], value: (a) => a[1] })}</div><div class="card"><h3>Most-affected groups</h3><table class="t"><tbody>${d.groups.slice(0, 10).map((g) => `<tr><td>${esc(clip(g.group, 40))}</td><td class="mute small">${esc(g.area)}</td><td class="r num">${fmt1(g.weight)}</td></tr>`).join("")}</tbody></table></div><div class="card"><h3>Geography</h3>${hbars(d.geography.slice(0, 12), { label: (a) => a[0], value: (a) => a[1], color: () => "var(--forecast)" })}</div></section>
  <section class="card" style="margin-top:16px"><h3>Broad-area density over time</h3><p class="hint">Top 20 impact brackets × time.</p><div id="btime"></div></section>`;
  $$("[data-sector]", el).forEach((r) => (r.onclick = () => { S.selSector = r.dataset.sector; render(); }));
  heat($("#stime"), c.sectorsView.map((s) => ({ label: s.name, values: s.series })), colL, (k) => new Date(d.bins[k]).toLocaleString(), { W: 640, L: 170 });
  heat($("#sfronts"), c.sectorsView.map((s) => ({ label: s.name, values: c.fronts.map((f) => s.fronts[f] || 0) })), c.fronts.map((f) => f.replace("_", " ").slice(0, 8)), (k) => c.fronts[k], { W: 640, L: 170 });
  heat($("#btime"), d.brackets.slice(0, 20).map((b) => ({ label: b.name, values: b.series })), colL, (k) => new Date(d.bins[k]).toLocaleString());
  if ($("#seditsec")) $("#seditsec").onclick = () => showSectorEditor(c, async () => { await loadStatusOnce(); render(); });
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

function showSectorEditor(co, onDone) {
  let sectors = JSON.parse(JSON.stringify(co.sectors || []));
  const modal = document.createElement("div");
  modal.className = "modal-scrim";

  const renderRows = () => {
    if (!sectors.length) return `<div class="empty" style="padding:16px">No sectors configured yet. Click "+ Add Sector" below.</div>`;
    return sectors.map((s, idx) => `
      <div class="sector-row" data-sidx="${idx}">
        <div>
          <label class="small b mute" style="display:block;margin-bottom:4px">SECTOR NAME</label>
          <input type="text" class="s-name" value="${esc(s.name)}" placeholder="e.g. Healthcare">
        </div>
        <div>
          <label class="small b mute" style="display:block;margin-bottom:4px">SCOPE &amp; DESCRIPTION (Focus Areas, Subsectors, Exclusions)</label>
          <textarea class="s-desc" rows="2" placeholder="e.g. Hospital equipment, medical devices, diagnostics. Exclude generic disease outbreaks.">${esc(s.description || "")}</textarea>
        </div>
        <div style="padding-top:20px;text-align:center">
          <button class="sector-del-btn" data-dels="${idx}" title="Remove sector">✕</button>
        </div>
      </div>
    `).join("");
  };

  modal.innerHTML = `
    <div class="sector-modal">
      <div class="sector-modal-header">
        <div>
          <h3 style="display:flex;align-items:center;gap:8px">✏️ Edit Sectors &amp; Taxonomy Scope: ${esc(co.name)}</h3>
          <p class="hint" style="margin:2px 0 0">Provide clear descriptions of sector focus areas (e.g. scoping Healthcare to hospital equipment and medtech so it does not pull generic broad news).</p>
        </div>
        <button class="btn ghost sm" id="sclose">✕ Close</button>
      </div>
      <div class="sector-modal-body">
        <div style="display:flex;gap:12px;align-items:center;background:var(--brand-soft);border:1px solid color-mix(in srgb,var(--brand) 25%,var(--line));border-radius:10px;padding:10px 14px">
          <span style="font-size:20px">💡</span>
          <div class="small" style="color:var(--ink2);line-height:1.4">
            <b>Targeted Relevance:</b> The LLM evaluates every news area strictly against your sector descriptions. Providing scope prevents broad categories (like Healthcare, Energy, or Tech) from pulling up irrelevant stories!
          </div>
        </div>
        <div>
          <label class="f">Client Company Name</label>
          <input type="text" id="sedit-name" value="${esc(co.name)}" ${co.builtin ? "readonly" : ""}>
        </div>
        <div class="sec-h" style="margin:6px 0 2px">
          <h4 style="margin:0;font-size:14px">Sectors Taxonomy &amp; Detailed Descriptions (<span id="ssec-cnt">${sectors.length}</span>)</h4>
          <button class="btn sm" id="sadd-btn">+ Add Sector</button>
        </div>
        <div id="srows" style="display:grid;gap:10px">
          ${renderRows()}
        </div>
      </div>
      <div class="sector-modal-footer">
        <button class="btn ghost" id="scancel">Cancel</button>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="small mute" id="ssavestatus"></span>
          <button class="btn" id="ssave-btn">💾 Save Sectors &amp; Re-Match</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const syncFromDom = () => {
    $$(".sector-row", modal).forEach((row, i) => {
      const name = $(".s-name", row)?.value.trim() || "";
      const description = $(".s-desc", row)?.value.trim() || "";
      sectors[i] = { name, description };
    });
  };

  const bindEvents = () => {
    $("#ssec-cnt", modal).textContent = sectors.length;
    $$("[data-dels]", modal).forEach((b) => (b.onclick = () => {
      syncFromDom();
      sectors.splice(+b.dataset.dels, 1);
      $("#srows", modal).innerHTML = renderRows();
      bindEvents();
    }));
  };
  bindEvents();

  $("#sadd-btn", modal).onclick = () => {
    syncFromDom();
    sectors.push({ name: "", description: "" });
    $("#srows", modal).innerHTML = renderRows();
    bindEvents();
    const rows = $$(".sector-row", modal);
    const last = rows[rows.length - 1];
    if (last) $(".s-name", last)?.focus();
  };

  const close = () => modal.remove();
  $("#sclose", modal).onclick = close;
  $("#scancel", modal).onclick = close;

  $("#ssave-btn", modal).onclick = async () => {
    syncFromDom();
    const cleanSectors = sectors.filter((s) => s.name);
    if (!cleanSectors.length) return toast("Enter at least one sector with a name");
    const name = $("#sedit-name", modal).value.trim() || co.name;
    const btn = $("#ssave-btn", modal);
    const st = $("#ssavestatus", modal);
    btn.disabled = true;
    st.textContent = "Saving & rematching…";
    try {
      await post("/api/company/update", { id: co.id, name, sectors: cleanSectors });
      toast(`Updated ${cleanSectors.length} sectors for ${name}! Re-matching started.`);
      close();
      if (onDone) onDone();
    } catch (e) {
      st.textContent = e.message;
      btn.disabled = false;
    }
  };
}

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
        <div style="margin-top:10px"><button class="btn sm" id="macteditsec">✏️ Update Sectors &amp; Descriptions</button></div>
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
                <th>Sectors &amp; Descriptions</th>
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
                    <div class="tiny mute">${c.sectors.slice(0, 3).map((s) => `${esc(s.name)}${s.description ? ` (${esc(clip(s.description, 28))})` : ""}`).join(" · ")}${c.sectors.length > 3 ? "..." : ""}</div>
                  </td>
                  <td class="num">${c.sectors.length} sectors</td>
                  <td>
                    <div class="compo" style="grid-template-columns:80px 1fr;gap:6px">
                      <span class="tiny mute">${matchCount} matched</span>
                      <div class="bar" style="height:6px"><i style="width:${Math.min(100, matchCount * 4)}%"></i></div>
                    </div>
                  </td>
                  <td class="r" style="white-space:nowrap">
                    <button class="btn sm ghost" data-editsec="${esc(c.id)}" title="Update sector taxonomy &amp; descriptions">✏️ Edit</button>
                    ${isAct ? `<span class="small b mute" style="margin:0 4px">Active</span>` : `<button class="btn sm" data-switch="${esc(c.id)}">Switch</button>`}
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
        <label class="f">Sector &amp; Practice Area Taxonomy (One per line, optional 'Sector: Description')</label>
        <textarea id="ncotext" rows="8" placeholder="Healthcare: Hospital equipment, medical devices, diagnostics&#10;Cloud &amp; Enterprise Platforms: Hyperscaler infra &amp; security&#10;Autonomous Mobility &amp; EV&#10;Semiconductor Manufacturing"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
          <button class="btn" id="ncosave">Create Client &amp; Match</button>
          <span class="small mute" id="ncostatus"></span>
        </div>
      </div>
    </div>
  `;

  if ($("#macteditsec")) {
    $("#macteditsec").onclick = () => {
      if (cur) showSectorEditor(cur, async () => { await loadStatusOnce(); render(); });
    };
  }

  $$("[data-editsec]", el).forEach((b) => (b.onclick = () => {
    const co = list.find((c) => c.id === b.dataset.editsec);
    if (co) showSectorEditor(co, async () => { await loadStatusOnce(); render(); });
  }));

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

// ---------------------------------------------------------------- Twitter (X) Trends tab
async function pgXTrends(el) {
  el.innerHTML = `<div class="card flush"><div class="skel" style="height:260px;margin:16px"></div></div>`;
  try {
    const data = await api(`/api/xtrends?company=${encodeURIComponent(S.company)}&region=all`);
    const allTrends = data.trends || [];
    const asOf = data.asOf || Date.now();
    const indCount = data.counts?.india ?? allTrends.filter((t) => t.region === "india").length;
    const worldCount = data.counts?.worldwide ?? allTrends.filter((t) => t.region === "worldwide").length;
    const totalCount = allTrends.length;

    let regionFilter = "all"; // 'all', 'india', 'worldwide'
    let filterMode = "all"; // 'all', 'matched', 'hashtags', 'keywords'
    let searchQuery = "";

    const renderView = () => {
      let filtered = allTrends;
      if (regionFilter === "india") filtered = filtered.filter((t) => t.region === "india");
      else if (regionFilter === "worldwide") filtered = filtered.filter((t) => t.region === "worldwide");

      const matchedInRegion = filtered.filter((t) => t.match).length;

      if (filterMode === "matched") filtered = filtered.filter((t) => t.match);
      else if (filterMode === "hashtags") filtered = filtered.filter((t) => t.name.startsWith("#"));
      else if (filterMode === "keywords") filtered = filtered.filter((t) => !t.name.startsWith("#"));

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter((t) =>
          t.name.toLowerCase().includes(q) ||
          t.clean.toLowerCase().includes(q) ||
          (t.match && `${t.match.sector} ${t.match.topic} ${t.match.angle}`.toLowerCase().includes(q))
        );
      }

      const nextH = Math.max(0.1, (data.nextScheduledIn || 0) / 3600000).toFixed(1);

      el.innerHTML = `
        <div class="kpis" style="margin-bottom:16px">
          <div class="kpi"><div class="v num">${indCount}</div><div class="l">🇮🇳 India Stream</div><div class="s">Top national trends</div></div>
          <div class="kpi"><div class="v num">${worldCount}</div><div class="l">🌐 Worldwide Stream</div><div class="s">Global viral trends</div></div>
          <div class="kpi ${matchedInRegion ? 'accent' : ''}"><div class="v num">${matchedInRegion}</div><div class="l">Editorial Matches</div><div class="s">Matching ${esc(S.company.toUpperCase())} Opportunities</div></div>
          <div class="kpi"><div class="v num" style="font-size:16px">Every 8h</div><div class="l">Automated Schedule</div><div class="s">Polled ${ago(asOf)} · Next ~${nextH}h</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="ctl" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <input type="text" id="xtq" placeholder="Search trends, hashtags, sectors…" value="${esc(searchQuery)}" style="min-width:240px">
              <div class="seg" id="xtregion" title="Filter by Geographic Stream">
                <button data-r="all" class="${regionFilter === 'all' ? 'on' : ''}">All Streams (${totalCount})</button>
                <button data-r="india" class="${regionFilter === 'india' ? 'on' : ''}">🇮🇳 India (${indCount})</button>
                <button data-r="worldwide" class="${regionFilter === 'worldwide' ? 'on' : ''}">🌐 Worldwide (${worldCount})</button>
              </div>
              <div class="seg" id="xtfilter">
                <button data-f="all" class="${filterMode === 'all' ? 'on' : ''}">All Types</button>
                <button data-f="matched" class="${filterMode === 'matched' ? 'on' : ''}">Matched (${matchedInRegion})</button>
                <button data-f="hashtags" class="${filterMode === 'hashtags' ? 'on' : ''}">Hashtags</button>
                <button data-f="keywords" class="${filterMode === 'keywords' ? 'on' : ''}">Keywords</button>
              </div>
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <span class="mute small" id="xtcount">${filtered.length} shown</span>
              <button class="btn sm" id="xtreload">↻ Poll Fresh Trends Now</button>
            </div>
          </div>
        </div>

        <div class="card flush">
          <div class="tw" style="max-height:none">
            <table class="t" id="xttable">
              <thead>
                <tr>
                  <th style="width:65px">Rank</th>
                  <th style="width:115px">Region</th>
                  <th>Trending Topic / Hashtag</th>
                  <th style="width:130px">Tweet Volume</th>
                  <th>Editorial Opportunity Alignment</th>
                  <th style="width:115px;text-align:right">Action</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.length ? filtered.map((t) => {
                  const medal = t.rank === 1 ? '🥇 ' : t.rank === 2 ? '🥈 ' : t.rank === 3 ? '🥉 ' : '';
                  const rankBadge = t.rank <= 3
                    ? `<b style="color:var(--brand);font-size:14px">${medal}#${t.rank}</b>`
                    : `<span class="mute num">#${t.rank}</span>`;
                  const isWorld = t.region === "worldwide";
                  const regChip = isWorld
                    ? `<span class="tag" style="background:rgba(29,155,240,0.12);color:#1d9bf0;font-size:11px;font-weight:700">🌐 World</span>`
                    : `<span class="tag" style="background:rgba(255,153,0,0.12);color:#e67e22;font-size:11px;font-weight:700">🇮🇳 India</span>`;
                  return `
                    <tr>
                      <td>${rankBadge}</td>
                      <td>${regChip}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:6px">
                          <b style="font-size:14px">${esc(t.name)}</b>
                          ${t.name.startsWith("#") ? `<span class="tag" style="font-size:10px">hashtag</span>` : ""}
                        </div>
                      </td>
                      <td>
                        <span class="num">${t.count ? esc(t.count) : "–"}</span>
                      </td>
                      <td>
                        ${t.match ? `
                          <div class="chip go" data-opp="${esc(t.match.oppKey)}" title="Click to view Opportunity in drawer" style="cursor:pointer;background:rgba(29,155,240,0.08);border:1px solid rgba(29,155,240,0.3);color:var(--text);display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px">
                            <span style="background:#1d9bf0;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700">𝕏 Matched</span>
                            <b>${esc(t.match.sector)}</b> <span class="mute">×</span> ${esc(t.match.topic)}
                            <span class="tag" style="background:#1d9bf0;color:#fff;font-size:10px;font-weight:700">Score ${t.match.score}</span>
                          </div>` : `
                          <span class="mute small">No direct editorial pairing</span>`}
                      </td>
                      <td style="text-align:right">
                        <a href="https://twitter.com/search?q=${encodeURIComponent(t.name)}" target="_blank" rel="noopener" class="btn ghost sm" style="font-size:11px;padding:3px 8px" title="Open on Twitter/X">View on 𝕏 ↗</a>
                      </td>
                    </tr>`;
                }).join("") : `
                  <tr><td colspan="6" class="mute" style="text-align:center;padding:28px">No trending topics match this filter.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
        <p class="small mute" style="margin-top:12px">
          Live stream from India & Worldwide Twitter Trends (hourly public mirror feed). Automated background poll runs <b>every 8 hours</b> during collection. Zero scraping, zero API cost.
        </p>
      `;

      const qInput = $("#xtq", el);
      if (qInput) {
        qInput.oninput = (e) => {
          searchQuery = e.target.value;
          renderView();
        };
      }

      $$("#xtregion button", el).forEach((b) => {
        b.onclick = () => {
          regionFilter = b.dataset.r;
          renderView();
        };
      });

      $$("#xtfilter button", el).forEach((b) => {
        b.onclick = () => {
          filterMode = b.dataset.f;
          renderView();
        };
      });

      const reloadBtn = $("#xtreload", el);
      if (reloadBtn) {
        reloadBtn.onclick = async () => {
          reloadBtn.disabled = true; reloadBtn.textContent = "Polling live trends…";
          try {
            await post("/api/xtrends/refresh", {});
            toast("Polled fresh Twitter trends (India & Worldwide)!");
            pgXTrends(el);
          } catch (e) {
            toast("Refresh failed: " + e.message);
            reloadBtn.disabled = false; reloadBtn.textContent = "↻ Poll Fresh Trends Now";
          }
        };
      }

      $$("[data-opp]", el).forEach((chip) => {
        chip.onclick = () => openOpp(chip.dataset.opp);
      });
    };

    renderView();
  } catch (err) {
    el.innerHTML = `<div class="card"><div class="banner bad">Could not load Twitter trends: ${esc(err.message)}</div><button class="btn sm" onclick="location.reload()" style="margin-top:8px">Retry</button></div>`;
  }
}

// ---------------------------------------------------------------- PITCH & OP-ED MATCHING
// Matches BCG Managing Directors & Partners (MDPs) from BCG_Hivemind.xlsx to live editorial opportunities.
async function pgPitch(el) {
  el.innerHTML = `<div class="card" style="padding:40px 20px;text-align:center"><div class="spin" style="margin:0 auto 14px"></div><p style="margin:0;color:var(--mute);font-size:14px">Mapping BCG Managing Directors &amp; Partners to live editorial opportunities…</p></div>`;

  try {
    const data = await api(`/api/pitch?${qs()}`);
    if (!data || !data.mdps) {
      el.innerHTML = `<div class="card"><div class="banner bad">No MDP pitch data available.</div></div>`;
      return;
    }

    const { mdps, opportunities, stats, asOf } = data;

    // Pre-populate S.oppByKey with all opportunities so openOpp() always opens the side drawer instantly
    (opportunities || []).forEach((o) => {
      if (o.oppKey && !S.oppByKey.has(o.oppKey)) {
        S.oppByKey.set(o.oppKey, {
          key: o.oppKey,
          sector: o.sector,
          label: { name: o.topic, key: o.oppKey.split("|")[2] || o.topic },
          score: o.score || 70,
          action: o.action || "investigate",
          stage: o.stage || "emerging",
          slim: true,
          kind: "editorial",
          evidence: "moderate",
          metrics: { count: 0, originsRecent: 1 },
          stories: []
        });
      }
    });

    const currentTab = S.tab === "by-opp" ? "by-opp" : "by-mdp"; // the page tabs at the top switch the view
    let searchQ = "";
    let selectedSector = "all";
    let onlyPitches = stats.mdpsWithPitches > 0;
    const expandedMdpIds = new Set(); // Cards start collapsed by default
    const activePitchIdx = new Map(); // mdpId -> selected pitch index (0 by default)

    const allSectors = Array.from(new Set(mdps.map((m) => m.primarySector).filter(Boolean))).sort();

    const render = () => {
      const q = searchQ.trim().toLowerCase();

      // Filter MDPs
      const filteredMdps = mdps.filter((m) => {
        if (onlyPitches && m.opportunityCount === 0) return false;
        if (selectedSector !== "all" && m.primarySector !== selectedSector) return false;
        if (q) {
          const inName = (m.name || "").toLowerCase().includes(q);
          const inDesig = (m.designation || "").toLowerCase().includes(q);
          const inSector = (m.primarySector || "").toLowerCase().includes(q);
          const inThemes = (m.themes || []).some((t) => t.toLowerCase().includes(q));
          const inOpps = (m.opportunities || []).some((o) => (o.topic || "").toLowerCase().includes(q) || (o.headline || "").toLowerCase().includes(q));
          if (!inName && !inDesig && !inSector && !inThemes && !inOpps) return false;
        }
        return true;
      });

      // Filter Opportunities for by-opp view
      const filteredOpps = opportunities.filter((o) => {
        if (selectedSector !== "all" && o.sector !== selectedSector) return false;
        if (q) {
          const inTopic = (o.topic || "").toLowerCase().includes(q);
          const inSector = (o.sector || "").toLowerCase().includes(q);
          const inAuthor = (o.topMdp?.mdpName || "").toLowerCase().includes(q);
          const inHeadline = (o.topMdp?.headline || "").toLowerCase().includes(q);
          if (!inTopic && !inSector && !inAuthor && !inHeadline) return false;
        }
        return true;
      });

      el.innerHTML = `
        <div class="pitch-container">
          <!-- Executive Summary KPI Strip (Clean & Minimal) -->
          <div class="pitch-kpi-bar">
            <div class="pitch-kpi-item">
              <span class="pitch-kpi-num">${stats.totalMdps}</span>
              <span class="pitch-kpi-text">BCG Leaders</span>
            </div>
            <div class="pitch-kpi-item is-brand">
              <span class="pitch-kpi-num">${stats.totalPitchesReady}</span>
              <span class="pitch-kpi-text">Op-Ed Angles Ready</span>
            </div>
            <div class="pitch-kpi-item is-star">
              <span class="pitch-kpi-num">${stats.highFitPitches}</span>
              <span class="pitch-kpi-text">High-Priority Matches (≥75%)</span>
            </div>
            <div class="pitch-kpi-item">
              <span class="pitch-kpi-num">${stats.sectorsCovered}</span>
              <span class="pitch-kpi-text">Practice Areas Covered</span>
            </div>
          </div>

          <!-- Clean Toolbar -->
          <div class="pitch-toolbar-clean">
            <div class="pitch-search-clean">
              <span class="pitch-search-ico">🔍</span>
              <input type="text" id="pitch-search" autocomplete="off" placeholder="Filter by partner, practice, theme or topic…" value="${esc(searchQ)}">
            </div>

            <div class="pitch-filter-actions">
              <select id="pitch-sector-sel" class="pitch-select-clean">
                <option value="all">All Practice Areas (${allSectors.length})</option>
                ${allSectors.map((s) => `<option value="${esc(s)}"${s === selectedSector ? " selected" : ""}>${esc(s)}</option>`).join("")}
              </select>

              <button class="btn sm ${onlyPitches ? "" : "ghost"}" id="pitch-toggle-only" title="Toggle between leaders with live pitches vs all 34 leaders">
                ${onlyPitches ? `✓ Ready Pitches (${stats.mdpsWithPitches})` : `All Leaders (${stats.totalMdps})`}
              </button>
            </div>
          </div>

          <!-- List Content (Collapsed by default for clean executive viewing) -->
          ${currentTab === "by-mdp" ? renderByMdpCollapsed(filteredMdps) : renderByOppClean(filteredOpps)}
        </div>
      `;

      bindEvents();
    };

    function renderByMdpCollapsed(list) {
      if (!list.length) {
        return `
          <div class="card" style="text-align:center;padding:40px 20px">
            <h3 style="margin:0 0 6px">No leaders match current filter</h3>
            <p class="mute" style="margin:0 0 14px;font-size:13px">Try clearing search or showing all leaders.</p>
            <button class="btn sm" id="pitch-reset-filters">Reset Filters</button>
          </div>
        `;
      }

      return `
        <div class="pitch-leader-list">
          ${list.map((m) => {
            const hasPitches = m.opportunityCount > 0;
            const isExpanded = expandedMdpIds.has(m.id);
            const currentIdx = activePitchIdx.get(m.id) || 0;
            const pitch = (m.opportunities && m.opportunities[currentIdx]) || m.topOpportunity;
            const initials = m.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

            return `
              <div class="pitch-leader-row ${hasPitches ? "has-pitches" : ""} ${isExpanded ? "expanded" : ""}" data-mdpid="${esc(m.id)}">
                <!-- Collapsed Row Header (Clicking expands/collapses) -->
                <div class="pitch-row-header" data-toggle-card="${esc(m.id)}">
                  <div class="pitch-row-left">
                    <div class="pitch-avatar-circle">${esc(initials)}</div>
                    <div class="pitch-row-identity">
                      <div class="pitch-row-name-line">
                        <span class="pitch-row-name">${esc(m.name)}</span>
                        ${m.group === "BCG Leaders" ? `<span class="pitch-tag-leader">Leadership</span>` : ""}
                        <span class="pitch-tag-practice">🏢 ${esc(m.primarySector)}</span>
                      </div>
                      <div class="pitch-row-desig">${esc(m.designation)}</div>
                    </div>
                  </div>

                  <div class="pitch-row-middle">
                    <div class="pitch-mini-themes">
                      ${(m.themes || []).slice(0, 3).map((t) => `<span class="pitch-theme-chip" title="${esc(t)}">${esc(t)}</span>`).join("")}
                      ${(m.themes || []).length > 3 ? `<span class="pitch-theme-chip mute">+${m.themes.length - 3}</span>` : ""}
                    </div>
                  </div>

                  <div class="pitch-row-right">
                    ${hasPitches ? `
                      <span class="pitch-match-pill ${m.highPriorityCount > 0 ? "high" : ""}">
                        ⭐ ${m.opportunityCount} Pitch${m.opportunityCount > 1 ? "es" : ""} Ready
                      </span>
                    ` : `
                      <span class="pitch-match-pill mute">Monitoring Feeds</span>
                    `}
                    <button class="pitch-expand-icon-btn" data-toggle-card="${esc(m.id)}" aria-label="Toggle details">
                      ${isExpanded ? "▲" : "▼"}
                    </button>
                  </div>
                </div>

                <!-- Expanded Workspace (Only shown when this card is clicked) -->
                ${isExpanded ? `
                  <div class="pitch-expanded-body">
                    ${hasPitches && pitch ? `
                      <!-- Multi-pitch switcher pills if more than 1 pitch -->
                      ${m.opportunityCount > 1 ? `
                        <div class="pitch-switcher-bar">
                          <span class="pitch-switcher-lbl">Available Angles:</span>
                          ${m.opportunities.map((o, idx) => `
                            <button class="pitch-switch-pill ${idx === currentIdx ? "active" : ""}" data-switch-mdp="${esc(m.id)}" data-switch-idx="${idx}">
                              #${idx + 1}: ${esc(o.topic)} (${o.fitScore}% Fit)
                            </button>
                          `).join("")}
                        </div>
                      ` : ""}

                      <div class="pitch-workspace-card">
                        <!-- Top Metadata Row -->
                        <div class="pitch-ws-top">
                          <div class="pitch-ws-topic-tag" data-opp="${esc(pitch.oppKey)}" title="Click to open full opportunity details &amp; evidence in side panel">
                            <span class="pitch-ws-dot">●</span> 
                            <span>Live Topic: <b>${esc(pitch.topic)}</b></span>
                            <span class="pitch-ws-score">Score ${Math.round(pitch.score || 0)}</span>
                            <span class="pitch-ws-link-hint">Open Evidence Drawer →</span>
                          </div>
                          <div class="pitch-ws-meta-tags">
                            <span class="fit-score-pill ${pitch.fitScore >= 75 ? "fit-high" : "fit-med"}">${pitch.fitScore}% Fit ⭐</span>
                            <span class="tag">🎯 ${esc(pitch.targetOutlets.split(",").slice(0, 2).join(", "))}</span>
                          </div>
                        </div>

                        <!-- Proposed Headline -->
                        <div class="pitch-headline-display">
                          <div class="pitch-headline-lbl">PROPOSED OP-ED HEADLINE</div>
                          <div class="pitch-headline-quote">"${esc(pitch.headline)}"</div>
                        </div>

                        <!-- Core Thesis -->
                        <div class="pitch-thesis-display">
                          <span class="pitch-thesis-lbl">EDITORIAL THESIS:</span>
                          <span class="pitch-thesis-body">${esc(pitch.thesis)}</span>
                        </div>

                        <!-- Boardroom Questions -->
                        <div class="pitch-boardroom-box">
                          <div class="pitch-boardroom-lbl">KEY QUESTIONS THIS OP-ED ANSWERS:</div>
                          <ul class="pitch-questions-list">
                            ${(pitch.boardroomQuestions || []).slice(0, 3).map((q) => `<li>${esc(q)}</li>`).join("")}
                          </ul>
                        </div>

                        <!-- Action Bar (Prominent and Clean) -->
                        <div class="pitch-ws-actions">
                          <button class="btn btn-primary" data-opp="${esc(pitch.oppKey)}" title="Open side panel drawer with news stories, volume curves and causal pathways">
                            📊 Inspect Opportunity &amp; Evidence (Side Panel) →
                          </button>
                          <button class="btn ghost" data-memo-mdp="${esc(m.id)}" data-memo-opp="${esc(pitch.oppKey)}">
                            📋 Copy Pitch Memo
                          </button>
                          <span class="pitch-ws-why-text">💡 ${esc(pitch.why)}</span>
                        </div>
                      </div>
                    ` : `
                      <div class="pitch-empty-clean">
                        <span>📡 Currently monitoring live feeds for <b>${esc(m.primarySector)}</b> triggers. No high-momentum news cycle currently fits this practice area.</span>
                      </div>
                    `}
                  </div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    function renderByOppClean(list) {
      if (!list.length) {
        return `
          <div class="card" style="text-align:center;padding:40px 20px">
            <h3 style="margin:0 0 6px">No opportunities match current filter</h3>
            <p class="mute">Try adjusting practice area or search query.</p>
          </div>
        `;
      }

      return `
        <div class="pitch-opp-clean-list">
          ${list.map((o) => {
            const m = o.topMdp;
            return `
              <div class="pitch-opp-row" data-opp="${esc(o.oppKey)}">
                <div class="pitch-opp-main">
                  <div class="pitch-opp-header-line">
                    <span class="pitch-tag-practice">🏢 ${esc(o.sector)}</span>
                    <h3 class="pitch-opp-name" data-opp="${esc(o.oppKey)}">
                      ${esc(o.topic)}
                    </h3>
                    <span class="pitch-ws-score">Score ${Math.round(o.score || 0)}</span>
                    <span class="tag">${esc(o.stage || "emerging")}</span>
                  </div>

                  ${m ? `
                    <div class="pitch-opp-author-line">
                      <span class="pitch-opp-auth-lbl">Recommended Author:</span>
                      <span class="pitch-opp-auth-name"><b>${esc(m.mdpName)}</b> (${esc(m.designation)})</span>
                      <span class="fit-score-pill ${m.fitScore >= 75 ? "fit-high" : "fit-med"}">${m.fitScore}% Fit ⭐</span>
                    </div>
                    <div class="pitch-opp-headline-line">
                      "${esc(m.headline)}"
                    </div>
                  ` : `
                    <div class="mute" style="font-size:12px;margin-top:4px">No author mapped.</div>
                  `}
                </div>

                <div class="pitch-opp-actions-col">
                  <button class="btn sm" data-opp="${esc(o.oppKey)}" title="Open side panel drawer with all evidence, charts and stories">
                    📊 Inspect Evidence (Side Panel) →
                  </button>
                  ${m ? `
                    <button class="btn sm ghost" data-memo-mdp="${esc(m.mdpId)}" data-memo-opp="${esc(o.oppKey)}">
                      📋 Copy Memo
                    </button>
                  ` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    function bindEvents() {
      // Search
      const searchEl = $("#pitch-search", el);
      if (searchEl) {
        searchEl.oninput = () => {
          searchQ = searchEl.value;
          const pos = searchEl.selectionStart;
          render(); // the page is redrawn, so put the cursor back where the user was typing
          const again = $("#pitch-search", el);
          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
        };
      }

      // Sector select
      const sectorSel = $("#pitch-sector-sel", el);
      if (sectorSel) {
        sectorSel.onchange = () => {
          selectedSector = sectorSel.value;
          render();
        };
      }

      // Pitches only toggle
      const toggleOnly = $("#pitch-toggle-only", el);
      if (toggleOnly) {
        toggleOnly.onclick = () => {
          onlyPitches = !onlyPitches;
          render();
        };
      }

      // Reset filters
      const resetBtn = $("#pitch-reset-filters", el);
      if (resetBtn) {
        resetBtn.onclick = () => {
          searchQ = "";
          selectedSector = "all";
          onlyPitches = false;
          render();
        };
      }

      // Toggle Card Expand / Collapse
      $$("[data-toggle-card]", el).forEach((row) => {
        row.onclick = (e) => {
          // If clicked a button inside, let button handler deal with it
          if (e.target.closest("button") || e.target.closest("[data-opp]") || e.target.closest("[data-memo-mdp]")) return;
          const id = row.dataset.toggleCard || row.closest("[data-mdpid]")?.dataset.mdpid;
          if (!id) return;
          if (expandedMdpIds.has(id)) expandedMdpIds.delete(id);
          else expandedMdpIds.add(id);
          render();
        };
      });

      $$(".pitch-expand-icon-btn", el).forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = btn.dataset.toggleCard || btn.closest("[data-mdpid]")?.dataset.mdpid;
          if (!id) return;
          if (expandedMdpIds.has(id)) expandedMdpIds.delete(id);
          else expandedMdpIds.add(id);
          render();
        };
      });

      // Switch active pitch for an MDP with multiple matches
      $$("[data-switch-mdp]", el).forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const mdpId = btn.dataset.switchMdp;
          const idx = parseInt(btn.dataset.switchIdx, 10) || 0;
          activePitchIdx.set(mdpId, idx);
          render();
        };
      });

      // Inspect Evidence & Open Side Panel Drawer
      $$("[data-opp]", el).forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const oppKey = btn.dataset.opp;
          if (oppKey) {
            openOpp(oppKey);
          }
        };
      });

      // Copy Pitch Memo
      $$("[data-memo-mdp]", el).forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const mdpId = btn.dataset.memoMdp;
          const oppKey = btn.dataset.memoOpp;

          const mdp = mdps.find((m) => m.id === mdpId);
          if (!mdp) return;

          let oppPitch = (mdp.opportunities || []).find((o) => o.oppKey === oppKey);
          if (!oppPitch) {
            const rootOpp = opportunities.find((o) => o.oppKey === oppKey);
            if (rootOpp && rootOpp.topMdp && rootOpp.topMdp.mdpId === mdpId) {
              oppPitch = { ...rootOpp.topMdp, ...rootOpp };
            }
          }
          if (!oppPitch) return;

          const memo = [
            `BCG OP-ED EDITORIAL PITCH MEMO`,
            `==================================================`,
            `TARGET AUTHOR:   ${mdp.name} (${mdp.designation})`,
            `PRACTICE AREA:   ${mdp.primarySector}`,
            `TARGET OUTLETS:  ${oppPitch.targetOutlets || "Mint, The Economic Times, Financial Express, BCG Henderson Institute"}`,
            ``,
            `PROPOSED OP-ED HEADLINE:`,
            `"${oppPitch.headline}"`,
            ``,
            `CORE EDITORIAL THESIS:`,
            `${oppPitch.thesis}`,
            ``,
            `KEY BOARDROOM / C-SUITE QUESTIONS ADDRESSED:`,
            ...((oppPitch.boardroomQuestions || []).map((q, i) => `${i + 1}. ${q}`)),
            ``,
            `WHY THIS AUTHOR & ANGLE:`,
            `${oppPitch.why}`,
            ``,
            `PITCH HOOK FOR EDITORS:`,
            `${oppPitch.pitchHook}`,
            ``,
            `EDITORIAL CONTEXT:`,
            `- HiveMind Topic: ${oppPitch.topic} (Score: ${Math.round(oppPitch.score || 0)}, Stage: ${oppPitch.stage || "emerging"}, Action: ${oppPitch.action || "investigate"})`,
            `- Focus Themes: ${(mdp.themes || []).join(", ")}`,
            `==================================================`,
            `Generated by HiveMind Editorial Intelligence`
          ].join("\n");

          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(memo).then(() => {
              toast(`Editorial Pitch Memo for ${mdp.name} copied to clipboard!`);
            }).catch(() => fallbackCopy(memo, mdp.name));
          } else {
            fallbackCopy(memo, mdp.name);
          }
        };
      });
    }

    function fallbackCopy(text, authorName) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast(`Editorial Pitch Memo for ${authorName} copied to clipboard!`);
      } catch {
        toast("Could not copy memo automatically. Please copy manually.");
      }
      document.body.removeChild(ta);
    }

    render();
  } catch (err) {
    el.innerHTML = `<div class="card"><div class="banner bad">Could not load pitch matching view: ${esc(err.message)}</div><button class="btn sm" onclick="location.reload()" style="margin-top:8px">Retry</button></div>`;
  }
}
