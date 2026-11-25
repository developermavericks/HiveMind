// Dependency-free SVG charts for the HiveMind dashboard. Everything is drawn from the API's numbers; nothing is invented.
// The momentum chart follows HiveMind.docx §5: raw coverage volume as bars, coverage share and a rolling average as
// lines, verified triggers annotated, collection gaps shown, and any forecast dashed with a labelled uncertainty band
// after the current-time marker, so it can't be mistaken for an observation.
const HC = (() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
  const PAL = ["#ff9500", "#32ade6", "#ff4f78", "#30b45a"]; // compare lines

  // ---- tooltip ----
  let tipEl;
  const tip = {
    show(html, e) {
      tipEl ??= document.getElementById("tip");
      tipEl.innerHTML = html; tipEl.classList.add("on");
      const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + w > innerWidth - 8) x = e.clientX - w - 14;
      if (y + h > innerHeight - 8) y = e.clientY - h - 14;
      tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
    },
    hide() { (tipEl ??= document.getElementById("tip"))?.classList.remove("on"); },
  };

  const fmtT = (ms, gran) => new Date(ms).toLocaleString([], gran === "day" ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", hour: "numeric", minute: undefined });
  const pct = (v, d = 1) => (v == null ? "–" : (v * 100).toFixed(d) + "%");

  // ---- sparkline (values are coverage share per 6h) ----
  function spark(vals, { w = 96, h = 26, color = "var(--brand)" } = {}) {
    if (!vals?.length) return "";
    const mx = Math.max(...vals, 1e-9), step = w / Math.max(1, vals.length - 1);
    const pts = vals.map((v, i) => [i * step, h - 2 - (h - 4) * (v / mx)]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const last = pts.at(-1);
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:inline-block;vertical-align:middle"><path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${color}"/></svg>`;
  }

  // ---- score ring ----
  function ring(score, size = 56, color) {
    const r = size / 2 - 5, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, score));
    const col = color ?? (v >= 65 ? "var(--good)" : v >= 50 ? "var(--info)" : v >= 35 ? "var(--warn)" : "var(--mute)");
    return `<div class="ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b class="num" style="font-size:${Math.round(size / 3.6)}px">${Math.round(v)}</b></div>`;
  }

  // ---- horizontal bars (HTML) ----
  function hbars(items, { label, value, fmt = (v) => v.toFixed(0), sub, onKey, color } = {}) {
    if (!items.length) return `<div class="empty">Nothing yet.</div>`;
    const mx = Math.max(...items.map(value), 1e-9);
    return items.map((it) => `<div class="hb ${onKey ? "click" : ""}" ${onKey ? `data-k="${esc(onKey(it))}"` : ""}><span title="${esc(label(it))}">${esc(clip(label(it), 26))}${sub ? `<span class="mute tiny"> ${sub(it)}</span>` : ""}</span><div class="bar"><i style="width:${(100 * value(it)) / mx}%;${color ? `background:${color(it)}` : ""}"></i></div><span class="num small" style="text-align:right">${fmt(value(it))}</span></div>`).join("");
  }

  // ---- heatmap ----
  function heat(el, rows, colLabels, colTitle, { W = 1100, L = 190, rh = 22 } = {}) {
    if (!rows.length) { el.innerHTML = `<div class="empty">Nothing yet.</div>`; return; }
    const cols = colLabels.length, cw = (W - L) / cols, hdr = 22;
    let mx = 1e-9; rows.forEach((r) => r.values.forEach((v) => { mx = Math.max(mx, v); }));
    let s = `<svg viewBox="0 0 ${W} ${rows.length * rh + hdr + 4}">`;
    colLabels.forEach((l, c) => { if (l) s += `<text x="${L + c * cw + cw / 2}" y="13" text-anchor="middle">${esc(l)}</text>`; });
    rows.forEach((r, i) => {
      const y = hdr + i * rh;
      s += `<text class="ink" x="2" y="${y + 15}">${esc(clip(r.label, 30))}</text>`;
      r.values.forEach((v, c) => { s += `<rect data-t="${esc(r.label)} · ${esc(colTitle(c))}: ${v.toFixed(2)}" x="${L + c * cw}" y="${y}" width="${cw - 1.5}" height="${rh - 2}" rx="3" style="fill:color-mix(in srgb,var(--brand) ${Math.round(100 * Math.sqrt(v / mx))}%,var(--surface2))"/>`; });
    });
    el.innerHTML = s + "</svg>";
    el.querySelectorAll("rect[data-t]").forEach((r) => { r.onmousemove = (e) => tip.show(esc(r.dataset.t), e); r.onmouseleave = tip.hide; });
  }

  // ---- the momentum chart ----
  // S: one series from /api/series. opts.compare: [{name, s}] extra share lines. opts.show: {bars, share, avg, forecast}.
  function momentum(el, S, opts = {}) {
    const show = { bars: true, share: true, avg: true, forecast: true, ...opts.show };
    const compare = opts.compare ?? [];
    const W = 1000, H = 340, mL = 46, mR = 54, mT = 18, mB = 34;
    const n = S.bins.length, fc = show.forecast && S.forecast?.available ? S.forecast.points : [];
    const slots = n + fc.length, bw = (W - mL - mR) / slots, X = (i) => mL + (i + 0.5) * bw;
    const maxC = Math.max(...S.count, 1) * 1.18;
    // The share axis follows what was observed (and the forecast line itself); a wide band is clipped, not allowed to flatten the data.
    const shares = [...S.share, ...S.avg, ...compare.flatMap((c) => c.s.share), ...fc.map((p) => p.value)].filter((v) => v != null);
    const maxS = Math.max(...shares, 0.01) * 1.18;
    const yC = (v) => mT + (H - mT - mB) * (1 - v / maxC), yS = (v) => Math.max(mT, mT + (H - mT - mB) * (1 - v / maxS));
    const base = H - mB;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Coverage momentum chart"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--surface2)"/><rect width="2.5" height="6" fill="var(--line2)"/></pattern></defs>`;
    // grid + axes
    for (let k = 0; k <= 4; k++) {
      const y = mT + ((H - mT - mB) * k) / 4;
      s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/>`;
      s += `<text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(maxC * (1 - k / 4))}</text><text x="${W - mR + 6}" y="${y + 4}">${((maxS * (1 - k / 4)) * 100).toFixed(maxS < 0.05 ? 1 : 0)}%</text>`;
    }
    s += `<text x="${mL - 6}" y="10" text-anchor="end">stories</text><text x="${W - mR + 6}" y="10">share</text>`;
    // forecast region
    if (fc.length) s += `<rect x="${mL + n * bw}" y="${mT}" width="${fc.length * bw}" height="${H - mT - mB}" fill="var(--forecast)" opacity=".06"/>`;
    // bars (raw coverage volume), gaps hatched
    S.count.forEach((c, i) => {
      const st = S.status[i];
      if (st === "nodata") return;
      if (st === "low") { s += `<rect x="${X(i) - bw / 2}" y="${mT}" width="${bw}" height="${H - mT - mB}" fill="url(#hatch)" opacity=".8"/>`; return; }
      if (show.bars && c) s += `<rect x="${X(i) - bw * 0.36}" y="${yC(c)}" width="${bw * 0.72}" height="${base - yC(c)}" rx="2" fill="${st === "open" ? "var(--bars)" : "var(--bars-strong)"}" ${st === "open" ? 'stroke="var(--bars-strong)" stroke-dasharray="3 2" fill-opacity=".55"' : 'fill-opacity=".62"'}/>`;
    });
    const line = (vals, col, w, dash = "") => {
      let d = "", pen = false;
      vals.forEach((v, i) => { if (v == null || S.status[i] === "nodata") { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${yS(v).toFixed(1)}`; pen = true; });
      return d ? `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>` : "";
    };
    compare.forEach((c, k) => { s += line(c.s.share.map((v, i) => (c.s.bins[i] === S.bins[i] ? v : null)), PAL[k % PAL.length], 1.8); });
    if (show.avg) s += line(S.avg, "var(--line-avg)", 2);
    if (show.share) s += line(S.share, "var(--line-share)", 2.2);
    // now marker + forecast
    const nowX = mL + n * bw;
    s += `<line x1="${nowX}" x2="${nowX}" y1="${mT}" y2="${base}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 3" opacity=".55"/><text x="${nowX - 4}" y="${mT + 8}" text-anchor="end" class="ink" style="font-weight:600">now</text>`;
    if (fc.length) {
      const up = fc.map((p, k) => `${k ? "L" : "M"}${X(n + k).toFixed(1)},${yS(p.hi).toFixed(1)}`).join("");
      const dn = [...fc].reverse().map((p, k) => `L${X(n + fc.length - 1 - k).toFixed(1)},${yS(p.lo).toFixed(1)}`).join("");
      s += `<path d="${up}${dn}Z" fill="var(--forecast)" opacity=".18"/>`;
      const last = S.share.map((v, i) => [v, i]).filter(([v]) => v != null).at(-1);
      let d = last ? `M${X(last[1]).toFixed(1)},${yS(S.avg[last[1]] ?? last[0]).toFixed(1)}` : "";
      fc.forEach((p, k) => { d += `${d ? "L" : "M"}${X(n + k).toFixed(1)},${yS(p.value).toFixed(1)}`; });
      s += `<path d="${d}" fill="none" stroke="var(--forecast)" stroke-width="2.2" stroke-dasharray="6 4"/>`;
      s += `<text x="${nowX + 6}" y="${mT + 8}" style="fill:var(--forecast);font-weight:600">Forecast · ${S.forecast?.validated ? "validated · 80% band" : "pilot extrapolation, not validated · 80% band"}</text>`;
    }
    // verified triggers
    (S.triggers ?? []).forEach((t, i) => {
      const x = X(t.bin);
      s += `<line x1="${x}" x2="${x}" y1="${mT + 14}" y2="${base}" stroke="var(--forecast)" stroke-width="1" stroke-dasharray="1 3"/><g class="trg" data-i="${i}" style="cursor:pointer"><path d="M${x},${mT + 2} l7,7 -7,7 -7,-7Z" fill="var(--forecast)" stroke="var(--surface)" stroke-width="1.5"/><text x="${x}" y="${mT + 12}" text-anchor="middle" style="fill:#fff;font-size:9px;font-weight:700">${i + 1}</text></g>`;
    });
    // x axis
    const every = Math.max(1, Math.ceil(n / 8));
    S.bins.forEach((t, i) => { if (i % every === 0) s += `<text x="${X(i)}" y="${H - 14}" text-anchor="middle">${esc(fmtT(t, S.granularity))}</text>`; });
    s += `<rect class="ov" x="${mL}" y="${mT}" width="${W - mL - mR}" height="${H - mT - mB}" fill="transparent"/><line class="cross" y1="${mT}" y2="${base}" stroke="var(--mute)" stroke-width="1" style="display:none"/></svg>`;
    el.innerHTML = s;

    const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), ov = svg.querySelector(".ov");
    const at = (e) => { const r = svg.getBoundingClientRect(); return Math.floor((((e.clientX - r.left) / r.width) * W - mL) / bw); };
    ov.onmousemove = (e) => {
      const i = at(e);
      if (i < 0 || i >= slots) return;
      cross.style.display = ""; cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i));
      if (i < n) {
        const st = S.status[i];
        let h = `<b>${esc(fmtT(S.bins[i], S.granularity))}${st === "open" ? " (still filling)" : ""}</b>`;
        if (st === "low") h += `<div class="row"><span>Collection gap</span><span>only ${S.total[i]} stories collected</span></div>`;
        else if (st === "nodata") h += `<div>No data collected</div>`;
        else {
          h += `<div class="row"><span>Stories</span><span>${S.count[i]} of ${S.total[i]}</span></div><div class="row"><span>Coverage share</span><span>${pct(S.share[i])}</span></div><div class="row"><span>Rolling avg (${S.rollingWindow}${S.granularity === "day" ? "d" : "h"})</span><span>${pct(S.avg[i])}</span></div><div class="row"><span>Independent origins</span><span>${S.origins[i]}</span></div>`;
          compare.forEach((c, k) => { h += `<div class="row"><span style="color:${PAL[k % PAL.length]}">● ${esc(clip(c.name, 22))}</span><span>${pct(c.s.share[i])}</span></div>`; });
        }
        tip.show(h, e);
      } else {
        const p = fc[i - n];
        tip.show(`<b>Forecast · ${esc(fmtT(p.t, S.granularity))}</b><div class="row"><span>Expected share</span><span>${pct(p.value)}</span></div><div class="row"><span>80% band</span><span>${pct(p.lo)} – ${pct(p.hi)}</span></div><div style="opacity:.7;margin-top:3px">Pilot extrapolation, not an observation</div>`, e);
      }
    };
    ov.onmouseleave = () => { cross.style.display = "none"; tip.hide(); };
    ov.onclick = (e) => {
      const i = at(e);
      if (i < 0 || i >= n) return;
      const targetOhlc = S.ohlc?.[i] || { t: S.bins[i], volume: S.count[i], stories: [] };
      if (typeof opts.onCandleClick === "function") {
        opts.onCandleClick(targetOhlc, i, S);
      }
    };
    svg.querySelectorAll(".trg").forEach((g) => {
      const t = S.triggers[+g.dataset.i];
      g.onmousemove = (e) => tip.show(`<b>Verified trigger ${+g.dataset.i + 1}</b>${esc(clip(t.title, 120))}<div style="opacity:.75;margin-top:3px">${esc(t.reason)} · ${esc(fmtT(t.t, "hour"))}</div><div style="opacity:.6">click to open</div>`, e);
      g.onmouseleave = tip.hide; g.onclick = () => window.open(t.url, "_blank", "noopener");
    });
  }

  // ---- generic line chart for the separate search-interest panel (own axis, own units) ----
  function lineChart(el, points, { color = "var(--line-avg)", label = "Relative interest (0–100)" } = {}) {
    const W = 1000, H = 190, mL = 40, mR = 16, mT = 10, mB = 28;
    const t0 = points[0].t, t1 = points.at(-1).t, X = (t) => mL + ((t - t0) / Math.max(1, t1 - t0)) * (W - mL - mR), Y = (v) => mT + (H - mT - mB) * (1 - v / 100);
    let s = `<svg viewBox="0 0 ${W} ${H}">`;
    for (let k = 0; k <= 4; k++) { const y = mT + ((H - mT - mB) * k) / 4; s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/><text x="${mL - 6}" y="${y + 4}" text-anchor="end">${100 - 25 * k}</text>`; }
    s += `<path d="${points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join("")}" fill="none" stroke="${color}" stroke-width="2.2"/>`;
    [0, 0.5, 1].forEach((f) => { const t = t0 + (t1 - t0) * f; s += `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).toLocaleDateString([], { day: "numeric", month: "short" })}</text>`; });
    el.innerHTML = s + `<text x="${mL}" y="8" style="font-weight:600">${esc(label)}</text></svg>`;
  }

  // ---- 6-factor opportunity radar / spider chart ----
  // Extra horizontal room in the viewBox keeps the axis names from being clipped at the card edge.
  function radar(components, size = 260) {
    if (!components) return "";
    const keys = ["momentum", "acceleration", "sourceBreadth", "sectorEvidence", "triggerTiming", "headroom"];
    const labels = ["Momentum", "Accel.", "Sources", "Sector", "Trigger", "Headroom"];
    const padX = 74, W = size + padX * 2, H = size + 28, cx = W / 2, cy = H / 2, radius = size * 0.34, n = keys.length;
    const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
    const pt = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
    let s = `<svg viewBox="0 0 ${W} ${H}" class="radar-chart" style="width:100%;max-width:${W}px;height:auto;overflow:visible" role="img" aria-label="Opportunity score by factor">`;
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      const ringPts = Array.from({ length: n }, (_, i) => pt(i, radius * f).map((v) => v.toFixed(1)).join(",")).join(" ");
      s += `<polygon points="${ringPts}" fill="none" stroke="var(--line2)" stroke-width="1" ${f === 1 ? "" : 'stroke-dasharray="2 2"'} opacity="0.7"/>`;
    });
    for (let i = 0; i < n; i++) { const [x, y] = pt(i, radius); s += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line2)" stroke-width="1" opacity="0.7"/>`; }
    const dataCoords = keys.map((k, i) => pt(i, (radius * Math.max(0, Math.min(100, components[k]?.score ?? 0))) / 100));
    s += `<polygon points="${dataCoords.map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join(" ")}" fill="var(--brand)" fill-opacity=".16" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round"/>`;
    dataCoords.forEach(([x, y], i) => { s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--surface)" stroke="var(--brand)" stroke-width="2"><title>${labels[i]}: ${Math.round(components[keys[i]]?.score ?? 0)}/100</title></circle>`; });
    labels.forEach((l, i) => {
      const [x, y] = pt(i, radius + 14), score = Math.round(components[keys[i]]?.score ?? 0);
      const align = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
      s += `<text data-info="c_${keys[i]}" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${align}" style="font-size:11px;font-weight:600;fill:var(--ink2);cursor:help;text-decoration:underline dotted;text-underline-offset:3px">${l} <tspan style="fill:var(--brand);font-weight:700">${score}</tspan></text>`;
    });
    return s + `</svg>`;
  }

  // ---- sentiment: daily bars, positive up / negative down, neutral+mixed as a grey band between ----
  function sentimentChart(el, daily) {
    if (!daily?.length) { el.innerHTML = `<div class="empty">No sentiment data yet.</div>`; return; }
    const W = 1000, H = 260, mL = 40, mR = 12, mT = 16, mB = 30, mid = mT + (H - mT - mB) / 2, half = (H - mT - mB) / 2 - 4;
    const tot = (d) => (d.pos || 0) + (d.neg || 0) + (d.neu || 0) + (d.mixed || 0) || 1;
    const bw = (W - mL - mR) / daily.length;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sentiment">`;
    [-1, -0.5, 0, 0.5, 1].forEach((f) => { const y = mid - f * half; s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/><text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.abs(Math.round(f * 100))}%</text>`; });
    daily.forEach((d, i) => {
      const t = tot(d), x = mL + i * bw + bw * 0.14, w = bw * 0.72, hp = (half * (d.pos || 0)) / t, hn = (half * (d.neg || 0)) / t, hm = (half * ((d.neu || 0) + (d.mixed || 0))) / t / 2;
      s += `<rect data-i="${i}" x="${x}" y="${mid - hp - hm}" width="${w}" height="${hp}" rx="2" fill="#30a46c"/>`;
      s += `<rect data-i="${i}" x="${x}" y="${mid - hm}" width="${w}" height="${hm * 2}" fill="#a1a1aa" opacity=".55"/>`;
      s += `<rect data-i="${i}" x="${x}" y="${mid + hm}" width="${w}" height="${hn}" rx="2" fill="#e5484d"/>`;
      if (i % Math.max(1, Math.ceil(daily.length / 10)) === 0) s += `<text x="${x + w / 2}" y="${H - 10}" text-anchor="middle">${esc(new Date(d.day + "T00:00:00").toLocaleDateString([], { day: "numeric", month: "short" }))}</text>`;
    });
    el.innerHTML = s + `</svg>`;
    el.querySelectorAll("rect[data-i]").forEach((r) => {
      const d = daily[+r.dataset.i];
      r.onmousemove = (e) => tip.show(`<b>${esc(d.day)}</b><div class="row"><span>Positive</span><span>${d.pos || 0}</span></div><div class="row"><span>Negative</span><span>${d.neg || 0}</span></div><div class="row"><span>Neutral / mixed</span><span>${(d.neu || 0) + (d.mixed || 0)}</span></div><div class="row"><span>Net</span><span>${d.net == null ? "–" : (d.net >= 0 ? "+" : "") + d.net.toFixed(2)}</span></div>`, e);
      r.onmouseleave = tip.hide;
    });
  }

  // ---- financial-grade candlestick chart for news coverage momentum ----
  // Renders stock-market-grade OHLC candlestick chart with ticker header, price ladder, volume sub-pane, and crosshairs.
  function candlestick(el, S, opts = {}) {
    if (!S || (!S.ohlc?.length && !S.bins?.length)) {
      el.innerHTML = `<div class="empty">No candlestick data available for this topic.</div>`;
      return;
    }
    const show = { volume: true, avg: true, forecast: true, ...opts.show };
    const rawOhlc = S.ohlc || [];
    const fcOhlc = show.forecast && S.forecastOhlc?.length ? S.forecastOhlc : [];
    const allOhlc = [...rawOhlc, ...fcOhlc];
    if (!allOhlc.length) {
      el.innerHTML = `<div class="empty">No OHLC series.</div>`;
      return;
    }

    const W = 1000, H = 370, mL = 16, mR = 66, mT = 22, mB = 30;
    const topH = 240; // main candle area height
    const volH = 50;  // volume sub-panel height
    const volGap = 16;
    const topBase = mT + topH;
    const volTop = topBase + volGap;
    const volBase = volTop + volH;

    const n = rawOhlc.length;
    const slots = allOhlc.length;
    const bw = (W - mL - mR) / Math.max(1, slots);
    const cw = Math.min(18, Math.max(3.5, bw * 0.72));
    const X = (i) => mL + (i + 0.5) * bw;

    // Calculate axis maximums
    const validHighs = allOhlc.map((d) => d.high).filter((v) => v != null);
    const validLows = allOhlc.map((d) => d.low).filter((v) => v != null);
    const maxShare = Math.max(...validHighs, 0.01) * 1.12;
    const volumes = rawOhlc.map((d) => d.volume || 0);
    const maxVol = Math.max(...volumes, 1) * 1.15;

    const yS = (v) => Math.max(mT, Math.min(topBase, mT + topH * (1 - v / maxShare)));
    const yV = (v) => Math.max(volTop, Math.min(volBase, volBase - volH * (v / maxVol)));

    // Identify latest valid candle for default ticker and active price line
    const lastValidIdx = rawOhlc.findLastIndex((d) => d.close != null && d.open != null);
    const latestCandle = lastValidIdx >= 0 ? rawOhlc[lastValidIdx] : (allOhlc[0] || null);

    // 1. Interactive stock market ticker bar HTML
    let outHtml = `
      <div class="candle-ticker-strip">
        <div class="candle-ticker-left">
          <span class="candle-ticker-badge">📈 COVERAGE MOMENTUM</span>
          <span class="candle-ticker-pill">${S.granularity === "day" ? "1D" : "1H"}</span>
          <span class="candle-ticker-metric"${isAdmin() ? "" : ' style="display:none"'}>O <b class="ct-o">--</b></span>
          <span class="candle-ticker-metric"${isAdmin() ? "" : ' style="display:none"'}>H <b class="ct-h">--</b></span>
          <span class="candle-ticker-metric"${isAdmin() ? "" : ' style="display:none"'}>L <b class="ct-l">--</b></span>
          <span class="candle-ticker-metric"${isAdmin() ? "" : ' style="display:none"'}>C <b class="ct-c">--</b></span>
          <span class="candle-ticker-chg ct-chg"${isAdmin() ? "" : ' style="display:none"'}>--</span>
          <span class="candle-ticker-metric"${isAdmin() ? "" : ' style="display:none"'}>Vol <b class="ct-v">--</b></span>
          <span class="candle-ticker-metric ma"${isAdmin() ? "" : ' style="display:none"'}>MA(7) <b class="ct-ma">--</b></span>
        </div>
        <div class="candle-ticker-right">
          <span class="candle-ticker-time ct-t">--</span>
        </div>
      </div>
    `;

    // 2. SVG Financial Chart
    let s = `<svg viewBox="0 0 ${W} ${H}" class="candlestick-svg" role="img" aria-label="Stock market analysis candlestick chart">`;

    // Background horizontal grid lines & share ladder (right axis)
    for (let k = 0; k <= 5; k++) {
      const val = maxShare * (1 - k / 5);
      const y = mT + (topH * k) / 5;
      s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-dasharray="2 3" opacity=".6"/>`;
      s += `<text x="${W - mR + 7}" y="${y + 4}" style="font-size:10.5px;font-family:var(--mono,monospace);fill:var(--ink2)">${(val * 100).toFixed(maxShare < 0.05 ? 2 : 1)}%</text>`;
    }

    // Right-hand axis vertical separator rule
    s += `<line x1="${W - mR}" x2="${W - mR}" y1="${mT}" y2="${volBase}" stroke="var(--line2)" stroke-width="1"/>`;
    s += `<text x="${W - mR + 7}" y="${mT - 6}" style="font-weight:700;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;fill:var(--ink2)">SHARE</text>`;

    // Volume sub-panel separator line & labels
    s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${volTop}" y2="${volTop}" stroke="var(--line)" stroke-dasharray="2 3" opacity=".6"/>`;
    s += `<line x1="${mL}" x2="${W - mR}" y1="${volBase}" y2="${volBase}" stroke="var(--line)"/>`;
    s += `<text x="${W - mR + 7}" y="${volTop + 10}" style="font-size:9.5px;font-family:var(--mono,monospace);fill:var(--mute)">${Math.round(maxVol)}</text>`;
    s += `<text x="${W - mR + 7}" y="${volBase}" style="font-size:9.5px;font-family:var(--mono,monospace);fill:var(--mute)">0</text>`;
    s += `<text x="${mL + 2}" y="${volTop - 4}" style="font-weight:700;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;fill:var(--mute)">VOL (STORIES)</text>`;

    // Forecast projection boundary & shading
    if (fcOhlc.length) {
      const fcX = mL + n * bw;
      s += `<rect x="${fcX}" y="${mT}" width="${fcOhlc.length * bw}" height="${volBase - mT}" fill="var(--forecast)" opacity=".04"/>`;
      s += `<line x1="${fcX}" x2="${fcX}" y1="${mT}" y2="${volBase}" stroke="var(--forecast)" stroke-width="1.2" stroke-dasharray="3 3"/>`;
      s += `<rect x="${fcX - 44}" y="${mT - 2}" width="40" height="15" rx="3" fill="var(--surface2)" stroke="var(--line)"/>`;
      s += `<text x="${fcX - 24}" y="${mT + 9}" text-anchor="middle" style="font-size:9px;font-weight:800;fill:var(--ink)">LIVE</text>`;
      s += `<rect x="${fcX + 4}" y="${mT - 2}" width="92" height="15" rx="3" fill="var(--forecast)" opacity=".18"/>`;
      s += `<text x="${fcX + 50}" y="${mT + 9}" text-anchor="middle" style="font-size:9px;font-weight:800;fill:var(--forecast)">FORECAST 72H</text>`;
    }

    // Sentiment & Color helpers: Positive & Neutral Green (#089981), Negative Red (#f23645)
    const POSITIVE_GREEN = "#089981";
    const NEGATIVE_RED = "#f23645";

    const getSentiment = (d) => {
      if (d?.sentiment) return d.sentiment;
      if (d?.sentimentNet != null) return d.sentimentNet > 0 ? "positive" : (d.sentimentNet < 0 ? "negative" : "neutral");
      const topicNet = S.sentiment?.net ?? (typeof opts.sentimentNet === "number" ? opts.sentimentNet : null);
      if (topicNet != null) return topicNet > 0 ? "positive" : (topicNet < 0 ? "negative" : "neutral");
      return "neutral";
    };

    const getCandleColor = (sent) => {
      return sent === "negative" ? NEGATIVE_RED : POSITIVE_GREEN;
    };

    // Latest price active horizontal line & axis tag
    if (latestCandle && latestCandle.close != null) {
      const sent = getSentiment(latestCandle);
      const isNeg = sent === "negative";
      const col = isNeg ? NEGATIVE_RED : POSITIVE_GREEN;
      const yClose = yS(latestCandle.close);
      s += `<line x1="${mL}" x2="${W - mR}" y1="${yClose}" y2="${yClose}" stroke="${col}" stroke-width="1.2" stroke-dasharray="3 3" opacity=".8"/>`;
      s += `<g class="latest-price-badge"><rect x="${W - mR}" y="${yClose - 8}" width="${mR - 4}" height="16" rx="3" fill="${col}"/><text x="${W - mR + (mR - 4)/2}" y="${yClose + 3.5}" text-anchor="middle" style="font-size:9.5px;font-weight:700;font-family:var(--mono,monospace);fill:#fff">${(latestCandle.close * 100).toFixed(2)}%</text></g>`;
    }

    // Draw candles & volume bars
    allOhlc.forEach((d, i) => {
      if (d.open == null || d.close == null) return;
      const x = X(i);
      const isUp = d.close >= d.open;
      const prevVol = i > 0 ? (allOhlc[i - 1]?.volume || 0) : d.volume;
      const isVolDecline = d.volume < prevVol;
      const isHammer = d.isHammer ?? (!isUp || (isVolDecline && d.close <= d.open * 1.01));

      const sent = getSentiment(d);
      const isNeg = sent === "negative";
      const sentCol = isNeg ? NEGATIVE_RED : POSITIVE_GREEN;
      const col = d.isForecast ? "var(--forecast)" : sentCol;
      const fillCol = d.isForecast ? "rgba(245,158,11,0.22)" : (isNeg ? NEGATIVE_RED : POSITIVE_GREEN);

      const yH = yS(d.high), yL = yS(d.low);
      const yO = yS(d.open), yC = yS(d.close);

      if (isHammer && !d.isForecast) {
        // Hammer Candlestick Formation:
        // When declining as per volume or share, render as a hammer
        // (compact body at upper end, long lower wick representing volume absorption)
        // Colored by sentiment: Negative Red (#f23645), or Positive/Neutral Green (#089981)
        const topY = Math.min(yO, yC, yH);
        const hammerH = Math.max(4, Math.min(8.5, cw * 0.45));
        const bodyTop = Math.min(topBase - hammerH, Math.max(mT, topY));
        const bodyBottom = bodyTop + hammerH;
        const wickBottom = Math.max(bodyBottom, yL);

        // Long lower shadow / wick extending downwards
        // WICKS DISABLED (commented out): lower and upper wicks are not drawn.
        // s += `<line x1="${x}" x2="${x}" y1="${bodyBottom}" y2="${wickBottom}" stroke="${col}" stroke-width="1.4" shape-rendering="crispEdges"/>`;

        // Tiny upper wick if high extends above hammer body
        // if (yH < bodyTop) {
        //   s += `<line x1="${x}" x2="${x}" y1="${yH}" y2="${bodyTop}" stroke="${col}" stroke-width="1.2" shape-rendering="crispEdges"/>`;
        // }

        // Hammer head (compact body at top of the range)
        s += `<rect x="${x - cw / 2}" y="${bodyTop}" width="${cw}" height="${hammerH}" rx="1" fill="${fillCol}" stroke="${col}" stroke-width="1.2" shape-rendering="crispEdges"/>`;
      } else {
        // Standard Rising / Forecast Candle:
        // 1. High-Low Wick line
        // WICKS DISABLED (commented out):
        // s += `<line x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke="${col}" stroke-width="${d.isForecast ? "1" : "1.2"}" shape-rendering="crispEdges" ${d.isForecast ? 'stroke-dasharray="2 2"' : ""}/>`;

        // 2. Candle body
        const bTop = Math.min(yO, yC);
        const bH = Math.max(1.8, Math.abs(yC - yO));
        s += `<rect x="${x - cw / 2}" y="${bTop}" width="${cw}" height="${bH}" rx="${d.isForecast ? 1 : 0.5}" fill="${fillCol}" stroke="${col}" stroke-width="1.2" shape-rendering="crispEdges" ${d.isForecast ? 'stroke-dasharray="3 2"' : ""}/>`;
      }

      // 3. Volume bar in bottom sub-pane (colored by sentiment: green for positive & neutral, red for negative)
      if (show.volume && !d.isForecast && d.volume) {
        const vy = yV(d.volume);
        const vCol = isNeg ? "rgba(242,54,69,0.45)" : "rgba(8,153,129,0.5)";
        s += `<rect x="${x - cw / 2}" y="${vy}" width="${cw}" height="${volBase - vy}" fill="${vCol}" shape-rendering="crispEdges"/>`;
      }
    });

    // 4. Moving Average (7-period) overlay line
    if (show.avg && S.avg?.length) {
      let dStr = "", pen = false;
      S.avg.forEach((v, i) => {
        if (v == null || i >= n) { pen = false; return; }
        dStr += `${pen ? "L" : "M"}${X(i).toFixed(1)},${yS(v).toFixed(1)}`;
        pen = true;
      });
      if (dStr) {
        s += `<path d="${dStr}" fill="none" stroke="#2962ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }

    // 5. Verified trigger diamonds
    (S.triggers ?? []).forEach((t, idxTrg) => {
      const x = X(t.bin);
      const cd = rawOhlc[t.bin];
      const ty = cd?.high != null ? yS(cd.high) - 8 : mT + 12;
      s += `<g class="trg" data-i="${idxTrg}" style="cursor:pointer"><path d="M${x},${ty - 6} l6,6 -6,6 -6,-6Z" fill="var(--forecast)" stroke="var(--surface)" stroke-width="1.5"/><text x="${x}" y="${ty + 3}" text-anchor="middle" style="fill:#fff;font-size:8px;font-weight:800">${idxTrg + 1}</text></g>`;
    });

    // 6. X-axis time labels
    const every = Math.max(1, Math.ceil(slots / 8));
    allOhlc.forEach((d, i) => {
      if (i % every === 0) {
        s += `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" style="font-size:10px;font-family:var(--mono,monospace);fill:var(--ink2)">${esc(fmtT(d.t, S.granularity))}</text>`;
      }
    });

    // 7. Interactive Crosshair & Cursor Floating Badges
    s += `
      <g class="crosshair-group" style="display:none">
        <line class="cross-x" x1="${mL}" x2="${W - mR}" y1="0" y2="0" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 2" opacity=".5"/>
        <line class="cross-y" x1="0" x2="0" y1="${mT}" y2="${volBase}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 2" opacity=".5"/>
        <g class="cross-price-tag"><rect x="${W - mR}" y="0" width="${mR - 4}" height="16" rx="2" fill="var(--ink)"/><text x="${W - mR + (mR - 4)/2}" y="11" text-anchor="middle" style="font-size:9.5px;font-weight:700;font-family:var(--mono,monospace);fill:var(--surface)">--</text></g>
        <g class="cross-time-tag"><rect x="0" y="${volBase + 3}" width="68" height="16" rx="2" fill="var(--ink)"/><text x="34" y="${volBase + 14}" text-anchor="middle" style="font-size:9.5px;font-weight:700;font-family:var(--mono,monospace);fill:var(--surface)">--</text></g>
      </g>
      <rect class="ov" x="${mL}" y="${mT}" width="${W - mL - mR}" height="${volBase - mT}" fill="transparent" style="cursor:crosshair"/>
    </svg>`;

    el.innerHTML = outHtml + s;

    // Elements
    const svg = el.querySelector("svg");
    const ov = svg.querySelector(".ov");
    const chGroup = svg.querySelector(".crosshair-group");
    const crossX = svg.querySelector(".cross-x");
    const crossY = svg.querySelector(".cross-y");
    const chPriceTag = svg.querySelector(".cross-price-tag");
    const chTimeTag = svg.querySelector(".cross-time-tag");
    const chPriceText = chPriceTag.querySelector("text");
    const chPriceRect = chPriceTag.querySelector("rect");
    const chTimeText = chTimeTag.querySelector("text");
    const chTimeRect = chTimeTag.querySelector("rect");

    // Ticker strip DOM elements
    const tkO = el.querySelector(".ct-o");
    const tkH = el.querySelector(".ct-h");
    const tkL = el.querySelector(".ct-l");
    const tkC = el.querySelector(".ct-c");
    const tkChg = el.querySelector(".ct-chg");
    const tkV = el.querySelector(".ct-v");
    const tkMA = el.querySelector(".ct-ma");
    const tkT = el.querySelector(".ct-t");

    // Helper to update ticker
    const updateTicker = (d, i) => {
      if (!d || d.open == null) return;
      const isUp = d.close >= d.open;
      const prevVol = i > 0 ? (allOhlc[i - 1]?.volume || 0) : d.volume;
      const isVolDecline = d.volume < prevVol;
      const isHammer = d.isHammer ?? (!isUp || (isVolDecline && d.close <= d.open * 1.01));
      const chgVal = d.close - d.open;
      const chgPct = d.open > 0 ? (chgVal / d.open) * 100 : 0;
      const sign = chgVal >= 0 ? "+" : "";

      const sent = getSentiment(d);
      const sentCol = getCandleColor(sent);

      tkO.textContent = pct(d.open);
      tkH.textContent = pct(d.high);
      tkL.textContent = pct(d.low);
      tkC.textContent = pct(d.close);
      tkChg.textContent = `${isHammer && !isUp ? "🔨 " : ""}${sign}${pct(chgVal)} (${sign}${chgPct.toFixed(2)}%)`;
      tkChg.className = `candle-ticker-chg ${isHammer && !isUp ? "hammer" : (isUp ? "up" : "down")}`;
      tkChg.style.color = sentCol;
      tkChg.style.background = sent === "negative" ? "rgba(242,54,69,0.12)" : "rgba(8,153,129,0.14)";
      tkV.textContent = d.isForecast ? "--" : (d.volume || 0);
      const maVal = S.avg?.[i];
      tkMA.textContent = maVal != null ? pct(maVal) : "--";
      tkT.textContent = `${fmtT(d.t, S.granularity)}${d.isForecast ? " (Forecast)" : ""}`;
    };

    // Initialize ticker with latest candle
    if (latestCandle) updateTicker(latestCandle, lastValidIdx >= 0 ? lastValidIdx : 0);

    const at = (e) => {
      const r = svg.getBoundingClientRect();
      const relX = ((e.clientX - r.left) / r.width) * W;
      const relY = ((e.clientY - r.top) / r.height) * H;
      const i = Math.floor((relX - mL) / bw);
      return { i, relX, relY };
    };

    ov.onmousemove = (e) => {
      const { i, relX, relY } = at(e);
      if (i < 0 || i >= slots) return;

      const d = allOhlc[i];
      if (!d) return;

      chGroup.style.display = "";
      const xPos = X(i);
      crossY.setAttribute("x1", xPos);
      crossY.setAttribute("x2", xPos);
      crossX.setAttribute("y1", relY);
      crossX.setAttribute("y2", relY);

      // Price tag at mouse Y
      const cursorShare = Math.max(0, (1 - (relY - mT) / topH) * maxShare);
      chPriceRect.setAttribute("y", relY - 8);
      chPriceText.setAttribute("y", relY + 3.5);
      chPriceText.textContent = `${(cursorShare * 100).toFixed(2)}%`;

      // Time tag at candle X
      const timeTagW = 76;
      chTimeTag.setAttribute("transform", `translate(${Math.max(mL, Math.min(W - mR - timeTagW, xPos - timeTagW / 2))}, 0)`);
      chTimeText.textContent = fmtT(d.t, S.granularity);

      // Update ticker bar
      updateTicker(d, i);

      // Show detailed floating tooltip
      const isUp = d.close >= d.open;
      const prevVol = i > 0 ? (allOhlc[i - 1]?.volume || 0) : d.volume;
      const isVolDecline = d.volume < prevVol;
      const isHammer = d.isHammer ?? (!isUp || (isVolDecline && d.close <= d.open * 1.01));
      const chg = d.open > 0 ? (((d.close - d.open) / d.open) * 100).toFixed(2) : "0.00";
      const chgSign = +chg >= 0 ? "+" : "";

      const sent = getSentiment(d);
      const sentCol = getCandleColor(sent);
      const sentLabel = sent === "negative" ? "Negative (Red)" : (sent === "positive" ? "Positive (Green)" : "Neutral (Green)");

      let h = `<b>${esc(fmtT(d.t, S.granularity))}${d.isForecast ? " (Forecast)" : ""}</b>`;
      h += `<div class="row"><span>Open</span><span>${pct(d.open)}</span></div>`;
      h += `<div class="row"><span>High</span><span>${pct(d.high)}</span></div>`;
      h += `<div class="row"><span>Low</span><span>${pct(d.low)}</span></div>`;
      h += `<div class="row"><span>Close</span><span>${pct(d.close)}</span></div>`;
      h += `<div class="row"><span>Pattern</span><span style="color:${sentCol};font-weight:700">${isHammer && !d.isForecast ? "🔨 Hammer (Volume/Share Decline)" : "▲ Rising Candle"}</span></div>`;
      h += `<div class="row"><span>Sentiment</span><span style="color:${sentCol};font-weight:700">● ${sentLabel} (${sent})</span></div>`;
      h += `<div class="row"><span>Change</span><span style="color:${sentCol};font-weight:700">${chgSign}${chg}%</span></div>`;
      if (!d.isForecast) {
        h += `<div class="row"><span>Volume (Stories)</span><span>${d.volume || 0}</span></div>`;
        if (d.origins) h += `<div class="row"><span>Origins</span><span>${d.origins}</span></div>`;
        if (d.sentimentBreakdown) {
          const sb = d.sentimentBreakdown;
          if (sb.pos || sb.neg || sb.neu || sb.mixed) {
            h += `<div class="tiny mute" style="margin-top:3px">${sb.pos} positive · ${sb.neg} negative · ${sb.neu + sb.mixed} neutral/mixed</div>`;
          }
        }
        if (!d.isForecast && (d.volume > 0 || d.stories?.length)) {
          h += `<div class="tiny" style="margin-top:6px;padding-top:4px;border-top:1px dashed rgba(255,255,255,0.22);color:#38bdf8;font-weight:700">👉 Click candle to view ${(d.stories?.length || d.volume || 0)} stories</div>`;
        }
      } else {
        h += `<div class="tiny mute" style="margin-top:3px">Forecast confidence corridor</div>`;
      }
      tip.show(h, e);
    };

    ov.onmouseleave = () => {
      chGroup.style.display = "none";
      tip.hide();
      if (latestCandle) updateTicker(latestCandle, lastValidIdx >= 0 ? lastValidIdx : 0);
    };

    ov.onclick = (e) => {
      const { i } = at(e);
      if (i < 0 || i >= slots) return;
      const d = allOhlc[i];
      if (!d || d.isForecast) return;

      // Visual indicator for selected candle
      svg.querySelectorAll(".candle-selection-highlight").forEach((el) => el.remove());
      const xPos = X(i);
      const hl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hl.setAttribute("class", "candle-selection-highlight");
      hl.setAttribute("x", xPos - bw / 2);
      hl.setAttribute("y", mT);
      hl.setAttribute("width", bw);
      hl.setAttribute("height", volBase - mT);
      hl.setAttribute("fill", "var(--brand, #007aff)");
      hl.setAttribute("opacity", "0.18");
      hl.setAttribute("stroke", "var(--brand, #007aff)");
      hl.setAttribute("stroke-width", "1.5");
      hl.setAttribute("stroke-dasharray", "3 2");
      hl.setAttribute("pointer-events", "none");
      svg.insertBefore(hl, chGroup);

      if (typeof opts.onCandleClick === "function") {
        opts.onCandleClick(d, i, S);
      }
    };

    svg.querySelectorAll(".trg").forEach((g) => {
      const t = S.triggers[+g.dataset.i];
      g.onmousemove = (e) => tip.show(`<b>Verified trigger ${+g.dataset.i + 1}</b>${esc(clip(t.title, 120))}<div style="opacity:.75;margin-top:3px">${esc(t.reason)} · ${esc(fmtT(t.t, "hour"))}</div><div style="opacity:.6">click to open</div>`, e);
      g.onmouseleave = tip.hide;
      g.onclick = () => window.open(t.url, "_blank", "noopener");
    });
  }

  // ---- social pulse line chart for X/Twitter tweet counts ----
  function socialChart(el, points, { baseline = null, title = "Hourly X (Twitter) Post Volume" } = {}) {
    if (!points?.length) { el.innerHTML = `<div class="empty">No X activity recorded yet.</div>`; return; }
    const W = 1000, H = 220, mL = 46, mR = 20, mT = 16, mB = 30;
    const t0 = points[0].t, t1 = points.at(-1).t;
    const maxV = Math.max(...points.map((p) => p.value), 1) * 1.15;
    const X = (t) => mL + ((t - t0) / Math.max(1, t1 - t0)) * (W - mL - mR);
    const Y = (v) => mT + (H - mT - mB) * (1 - v / maxV);
    const base = H - mB;

    let s = `<svg viewBox="0 0 ${W} ${H}">`;
    for (let k = 0; k <= 4; k++) {
      const y = mT + ((H - mT - mB) * k) / 4;
      s += `<line class="grid" x1="${mL}" x2="${W - mR}" y1="${y}" y2="${y}"/><text x="${mL - 6}" y="${y + 4}" text-anchor="end">${Math.round(maxV * (1 - k / 4))}</text>`;
    }
    // area fill
    const pathD = points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
    s += `<path d="${pathD}L${X(t1).toFixed(1)},${base}L${X(t0).toFixed(1)},${base}Z" fill="#32ade6" fill-opacity=".14"/>`;
    s += `<path d="${pathD}" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round"/>`;
    // baseline indicator
    if (baseline != null && baseline > 0) {
      const by = Y(baseline / 24);
      s += `<line x1="${mL}" x2="${W - mR}" y1="${by}" y2="${by}" stroke="#0369a1" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${W - mR}" y="${by - 4}" text-anchor="end" style="font-size:10px;fill:#0369a1">24h avg baseline</text>`;
    }
    // x time labels
    const every = Math.max(1, Math.ceil(points.length / 8));
    points.forEach((p, i) => {
      if (i % every === 0) s += `<text x="${X(p.t)}" y="${H - 8}" text-anchor="middle">${fmtT(p.t, "hour")}</text>`;
    });
    s += `<text x="${mL}" y="12" style="font-weight:600;fill:var(--ink)">${esc(title)}</text><text x="${W - mR}" y="12" text-anchor="end" class="tiny mute">Posts / hour</text></svg>`;
    el.innerHTML = s;
  }

  return { esc, clip, spark, ring, hbars, heat, momentum, candlestick, lineChart, radar, sentimentChart, socialChart, tip, fmtT, pct, PAL };
})();
