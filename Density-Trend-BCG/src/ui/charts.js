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
      s += `<text x="${nowX + 6}" y="${mT + 8}" style="fill:var(--forecast);font-weight:600">Forecast · pilot extrapolation, not validated · 80% band</text>`;
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

  return { esc, clip, spark, ring, hbars, heat, momentum, lineChart, radar, sentimentChart, socialChart, tip, fmtT, pct, PAL };
})();
