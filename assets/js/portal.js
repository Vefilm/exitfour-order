/* ==========================================================================
   VEFILM Equipment Portal
   Renders the catalog, runs the tier logic, the totals and the day readout.

   Reading order is deliberate: the answer first, then the decisions, then
   the day, then the list, then the order. Every technical figure is paired
   with a plain sentence; the figure itself is demoted to a `fine` line.

   State lives in the URL hash so a configured build is shareable by link
   with no backend. Every fact, price and figure comes from catalog.json.
   ========================================================================== */

const CFG = {
};

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const money = n =>
  n == null ? null : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const money0 = n =>
  n == null ? null : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const hrs = n => (n >= 100 ? Math.round(n) : n.toFixed(1)) + " h";

/* Hours as a producer says them, not as a spreadsheet prints them. */
function plainHours(n) {
  let h = Math.floor(n + 1e-9);
  let m = Math.round((n - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hour${h === 1 ? "" : "s"}`;
  if (m === 30) return h === 1 ? "an hour and a half" : `${h} and a half hours`;
  return `${h} h ${m} min`;
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* Almost every line is a B&H page, but one is bought direct, so the link has
   to name where it actually goes rather than promising B&H and landing else-
   where. Used by both the row link and the "View at" line inside the spec. */
const vendorOf = url => (/kondorblue/.test(url) ? "Kondor Blue" : "B&amp;H");

/* Status marks carry a word and a glyph, never colour alone. */
const MARK = { ok: "✓", warn: "?", short: "!" };
const mark = (kind, word) =>
  `<span class="stat stat--${kind}"><i aria-hidden="true">${MARK[kind]}</i>${word}</span>`;

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */
const state = {
  tier: "high",
  overrides: {},        // itemId -> "high" | "standard"
  dropped: new Set(),   // itemIds excluded from the build
  optional: false,      // include optional sections
  choices: {},          // decisionId -> chosen option index
  scenario: null,       // day type id
  segs: null,           // [{formatId, hours}] overriding the scenario default
  poweredH: null,       // camera-hot hours; 12 is the max day, not the typical one
};

const scenario = () => CATALOG.designTargets.scenarios.find(s => s.id === state.scenario)
                    || CATALOG.designTargets.scenarios[0];
const fmtById  = id => CATALOG.designTargets.formats.find(f => f.id === id);
const PL       = () => CATALOG.designTargets.plain || {};
const VD       = () => CATALOG.meta.verdict || {};

/* A day is two formats: a 4K interview block and 1080 for everything else.
   Modelling it as one rate was wrong, so media is computed per segment. */
const segments = () => scenario().segments.map((seg, i) => {
  const o = state.segs && state.segs[i];
  return { ...seg, formatId: (o && o.formatId) || seg.formatId,
                   hours:    (o && o.hours != null) ? o.hours : seg.hours };
});
const recordHours = () => segments().reduce((a, s) => a + s.hours, 0);
const poweredHours = () => state.poweredH != null ? state.poweredH : scenario().poweredHours;
const gbNeeded    = () => segments().reduce((a, s) => a + s.hours * (fmtById(s.formatId).gbPerHour || 0), 0);

/* Cumulative consumption, one vertex per segment. The slope changes when
   the format does, which is the whole point of the curve. */
function mediaCurve() {
  const pts = [{ x: 0, y: 0 }];
  let x = 0, y = 0;
  segments().filter(s => s.hours > 0).forEach(s => {
    x += s.hours; y += s.hours * (fmtById(s.formatId).gbPerHour || 0);
    pts.push({ x, y, seg: s.label });
  });
  return pts;
}
/* Where a cumulative curve reaches a ceiling, interpolated inside the segment */
function crossAt(pts, cap) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.y >= cap && a.y <= cap) {
      const t = (cap - a.y) / (b.y - a.y || 1);
      return a.x + t * (b.x - a.x);
    }
  }
  return null;
}

let CATALOG = null;

/* Which tier actually applies to an item, falling back when a tier is absent */
function tierFor(item) {
  const want = state.overrides[item.id] || state.tier;
  return item.tiers[want] ? want : (item.tiers.high ? "high" : "standard");
}
function offerFor(item) { return item.tiers[tierFor(item)]; }

function lineTotal(item) {
  if (state.dropped.has(item.id)) return 0;
  const o = offerFor(item);
  return o && o.price != null ? o.price * item.qty : 0;
}

/* What the whole build costs if every line took one tier, ignoring per-line
   overrides. Used only to price the High End / Standard choice honestly. */
function totalForTier(tier) {
  let sum = 0;
  for (const p of CATALOG.packages)
    for (const s of p.sections) {
      if (s.optional && !state.optional) continue;
      for (const it of s.items) {
        if (state.dropped.has(it.id)) continue;
        const o = it.tiers[tier] || it.tiers.high || it.tiers.standard;
        if (o && o.price != null) sum += o.price * it.qty;
      }
    }
  return sum;
}

/* --------------------------------------------------------------------------
   URL hash, so a build survives a link
   -------------------------------------------------------------------------- */
function writeHash() {
  const p = new URLSearchParams();
  p.set("t", state.tier === "standard" ? "s" : "h");
  if (state.optional) p.set("opt", "1");
  const ov = Object.entries(state.overrides).map(([k, v]) => `${k}:${v[0]}`);
  if (ov.length) p.set("o", ov.join(","));
  if (state.dropped.size) p.set("d", [...state.dropped].join(","));
  const ch = Object.entries(state.choices).map(([k, v]) => `${k}:${v}`);
  if (ch.length) p.set("ch", ch.join(","));
  p.set("sc", scenario().id);
  p.set("sg", segments().map(g => `${g.formatId}@${g.hours}`).join(","));
  if (state.poweredH != null) p.set("ph", state.poweredH);
  history.replaceState(null, "", "#" + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("t") === "s") state.tier = "standard";
  if (p.get("opt") === "1") state.optional = true;
  (p.get("o") || "").split(",").filter(Boolean).forEach(pair => {
    const [id, t] = pair.split(":");
    if (id && t) state.overrides[id] = t === "s" ? "standard" : "high";
  });
  (p.get("d") || "").split(",").filter(Boolean).forEach(id => state.dropped.add(id));
  if (p.get("sc")) state.scenario = p.get("sc");
  if (p.get("sg")) state.segs = p.get("sg").split(",").map(t => {
    const [formatId, h] = t.split("@");
    return { formatId, hours: Number(h) };
  });
  if (p.get("ph")) state.poweredH = Number(p.get("ph"));
  (p.get("ch") || "").split(",").filter(Boolean).forEach(pair => {
    const [id, i] = pair.split(":");
    if (id) state.choices[id] = Number(i);
  });
}

/* --------------------------------------------------------------------------
   Day planner model
   Series colors are validated against the dark panel surface for the
   lightness band, chroma floor, CVD separation and contrast. Do not
   substitute by eye. #c26a00 amber / #1f6fd0 blue, re-validated against the
   warm blush surface: worst adjacent CVD dE 26.7 protan, 31.6 normal vision.
   -------------------------------------------------------------------------- */
const SERIES = { fx3: "#c26a00", fx9: "#1f6fd0" };

/* Everything the gauges, charts, verdict and bot all read from. One source
   of truth for the arithmetic so the page can never disagree with itself. */
function model() {
  const dayH = poweredHours();
  const curve = mediaCurve();
  const needGb = gbNeeded();
  const recH = recordHours();

  return CATALOG.cameras.map(cam => {
    const loadW = cam.bodyWatts
                + (cam.accessoryLoads || []).reduce((a, l) => a + l.watts, 0);

    const wh = (cam.powerItems || []).reduce((a, id) => {
      const it = findItem(id);
      if (!it || state.dropped.has(it.id) || !it.wh) return a;
      return a + it.wh * (it.cells || 1) * it.qty;
    }, 0) + (cam.ownedPower || []).reduce((a, id) => a + ((findOwned(id) || {}).wh || 0), 0);

    const gb = (cam.mediaItems || []).reduce((a, id) => {
      const it = findItem(id);
      if (!it || state.dropped.has(it.id) || !it.gb) return a;
      return a + it.gb * (it.cells || 1) * it.qty;
    }, 0) + (cam.ownedMedia || []).reduce((a, id) => {
      const o = findOwned(id) || {};
      return a + (o.gb || 0) * (o.count || 1);
    }, 0);

    /* Media runway is where the segmented curve reaches this camera's cards.
       Null means the cards outlast the day as configured. */
    const mediaRunwayH = crossAt(curve, gb);

    return {
      cam, loadW, wh, gb, curve, needGb, dayH, recH,
      powerRunwayH: loadW ? wh / loadW : 0,
      mediaRunwayH,
      powerShortWh: Math.max(0, Math.round(dayH * loadW - wh)),
      mediaShortGb: Math.max(0, Math.round(needGb - gb)),
      powerOk: loadW ? wh / loadW >= dayH : true,
      mediaOk: gb >= needGb,
    };
  });
}

function findItem(id) {
  for (const p of CATALOG.packages)
    for (const s of p.sections)
      for (const i of s.items) if (i.id === id) return i;
  return null;
}
function findOwned(id) { return CATALOG.owned.find(o => o.id === id); }

/* Every line the consultant has flagged for a client answer. */
function flaggedItems() {
  const out = [];
  for (const p of CATALOG.packages)
    for (const s of p.sections) {
      if (s.optional && !state.optional) continue;
      for (const it of s.items)
        if (it.openQuestion && !state.dropped.has(it.id)) out.push({ pkg: p, item: it });
    }
  return out;
}

/* --------------------------------------------------------------------------
   1. THE ANSWER
   Three tiles, above the fold: does it cover the day, what does it cost,
   what is still open. Nothing here needs a camera department to read.
   -------------------------------------------------------------------------- */
function renderVerdict() {
  const v = VD();
  const rows = model();
  const allOk = rows.every(m => m.powerOk && m.mediaOk);
  const failing = rows.filter(m => !m.powerOk || !m.mediaOk);

  /* Cost */
  const grand = liveSubtotal();
  const tax = grand * CATALOG.meta.salesTax.rate;
  const stdTotal = totalForTier("standard");
  const highTotal = totalForTier("high");
  const saving = highTotal - stdTotal;

  /* Open decisions */
  const decisions = CATALOG.openDecisions || [];
  const openCount = decisions.filter(d => state.choices[d.id] == null).length;
  const flags = flaggedItems().length;

  const coverBody = allOk
    ? `<p class="answer__line">${esc(v.coveredLine || "")}</p>`
    : `<p class="answer__line">${esc(v.shortLine || "")}</p>
       <ul class="answer__list">${failing.map(m => `<li>${esc(m.cam.name)} &mdash; ${
         !m.powerOk ? (m.wh ? `battery runs out after ${plainHours(m.powerRunwayH)}` : "has no battery in the build") : ""}${
         !m.powerOk && !m.mediaOk ? " and " : ""}${
         !m.mediaOk ? (m.gb ? `cards fill after ${m.mediaRunwayH != null ? plainHours(m.mediaRunwayH) : "the day"}` : "has no cards in the build") : ""}</li>`).join("")}</ul>`;

  /* Name the binding constraint rather than listing four numbers for two
     cameras. A reader wants to know what runs out first and by how much;
     everything else is slack and belongs further down. Margin is expressed
     as a fraction of what the day asks for, so battery hours and card
     gigabytes can be compared on the same scale. */
  const fine = (() => {
    const margins = [];
    rows.forEach(m => {
      if (m.dayH > 0) margins.push({
        cam: m.cam.name.replace("Sony ", ""), what: "battery",
        slack: m.powerRunwayH / m.dayH - 1,
        got: hrs(m.powerRunwayH), need: `${m.dayH} h`,
      });
      if (m.needGb > 0) margins.push({
        cam: m.cam.name.replace("Sony ", ""), what: "cards",
        slack: m.gb / m.needGb - 1,
        got: `${m.gb} GB`, need: `${Math.round(m.needGb)} GB`,
      });
    });
    if (!margins.length) return "";
    margins.sort((a, b) => a.slack - b.slack);
    const t = margins[0];
    return t.slack < 0
      ? `Tightest is ${t.cam} ${t.what}: ${t.got} against the ${t.need} this day asks for.`
      : `Most of the kit has room to spare. The tightest is ${t.cam} ${t.what}, at ${t.got} against the ${t.need} this day asks for.`;
  })();

  $("#verdictEyebrow").textContent = v.eyebrow || "";

  $("#verdict").innerHTML = `
    <article class="answer answer--${allOk ? "ok" : "short"}" data-state="${allOk ? "ok" : "short"}">
      <p class="answer__k">Does it cover the day</p>
      <p class="answer__big">${mark(allOk ? "ok" : "short", allOk ? (v.coveredTitle || "Covered") : (v.shortTitle || "Short"))}</p>
      ${coverBody}
      <p class="fine">${fine}</p>
    </article>

    <article class="answer answer--cost">
      <p class="answer__k">${esc(v.costTitle || "Cost")}</p>
      <p class="answer__big answer__big--num">${money0(grand)}</p>
      <p class="answer__line">${esc(v.costLine || "")} ${money0(grand + tax)} with NYC tax, which drops off if EXIT FOUR links a tax certificate.</p>
      <p class="fine">${money(grand)} + ${money(tax)} tax. Every line at High End is ${money0(highTotal)}; every line at Standard is ${money0(stdTotal)}, a difference of ${money0(saving)}.</p>
    </article>

    <article class="answer answer--${openCount ? "warn" : "ok"}" data-state="${openCount ? "warn" : "ok"}">
      <p class="answer__k">Still open</p>
      <p class="answer__big">${openCount
        ? mark("warn", String(openCount))
        : mark("ok", String(0))}</p>
      <p class="answer__line">${openCount
        ? esc(openCount === 1 ? (v.openLineOne || "") : (v.openLineMany || ""))
        : esc(v.openNoneLine || "")}</p>
      <p class="answer__line answer__line--sub">${flags} ${esc(flags === 1 ? (v.flagLineOne || "") : (v.flagLineMany || ""))}</p>
      <a class="answer__go" href="#decisions">Go to the decisions &rarr;</a>
    </article>
  `;

  $("#verdictFoot").textContent =
    `${CATALOG.meta.priceDisclaimer || ""} Prices verified ${CATALOG.meta.pricesVerifiedOn || "pending"}.`;

  $("#barStatus").innerHTML = mark(allOk ? "ok" : "short",
    allOk ? (VD().coveredTitle || "Covered") : (VD().shortTitle || "Short"));
}

/* --------------------------------------------------------------------------
   2. DECISIONS
   A short guided flow. The tier choice is a real decision with a real price
   difference, so it is step one rather than a switch in the header.
   -------------------------------------------------------------------------- */
/* Every line where the two tiers actually differ, with what the cheaper one
   gives up. The tradeoff strings are the consultant's, written in specs. */
function tierDeltas() {
  const out = [];
  for (const p of CATALOG.packages)
    for (const s of p.sections) {
      if (s.optional && !state.optional) continue;
      for (const it of s.items) {
        if (state.dropped.has(it.id)) continue;
        const h = it.tiers.high, st = it.tiers.standard;
        if (!st || !h) continue;
        out.push({
          item: it,
          saves: (h.price != null && st.price != null) ? (h.price - st.price) * it.qty : 0,
          tradeoff: st.tradeoff || "",
        });
      }
    }
  return out.sort((a, b) => b.saves - a.saves);
}

/* The aggregate consequence of the cheaper build, next to the switch itself.
   Open by default when Standard is live, because then it is the current state. */
function changesPanel() {
  const d = tierDeltas();
  const kept = (() => {
    const out = [];
    for (const p of CATALOG.packages)
      for (const s of p.sections) {
        if (s.optional && !state.optional) continue;
        for (const it of s.items)
          if (!state.dropped.has(it.id) && !it.tiers.standard && it.noStandard)
            out.push(it);
      }
    return out;
  })();
  if (!d.length) return "";
  const total = d.reduce((a, x) => a + x.saves, 0);
  const std = state.tier === "standard";

  return `
    <details class="changes" ${std ? "open" : ""}>
      <summary class="disc__sum changes__sum">
        ${std ? "What the cheaper build gives up" : `What would change on the cheaper build`}
        <b>${d.length} line${d.length === 1 ? "" : "s"} &middot; ${money0(total)}</b>
      </summary>
      <div class="disc__body">
        <ul class="changes__list">
          ${d.map(x => `
            <li class="change">
              <p class="change__k">${esc(x.item.name)}</p>
              <p class="change__t">${esc(x.tradeoff || "Cheaper equivalent.")}</p>
              <span class="change__v">saves ${money(x.saves)}</span>
            </li>`).join("")}
        </ul>
        ${kept.length ? `
          <p class="changes__kept"><b>${kept.length} line${kept.length === 1 ? " has" : "s have"} no cheaper option and do not change:</b>
          ${kept.map(it => esc(it.name)).join("; ")}.</p>` : ""}
      </div>
    </details>`;
}

function renderSteps() {
  const host = $("#steps");
  host.innerHTML = "";
  const t = CATALOG.meta.tiers;
  const highTotal = totalForTier("high");
  const stdTotal = totalForTier("standard");
  const overridden = Object.keys(state.overrides).length;

  /* Step 1: how much to spend per line */
  const step1 = document.createElement("article");
  step1.className = "step glass";
  step1.dataset.done = "true";
  step1.innerHTML = `
    <div class="step__head">
      <span class="step__n">1</span>
      <div>
        <h3 class="step__q">How much do you want to spend per line?</h3>
        <p class="step__why">Most lines have a cheaper alternative that does the same job. Pick a starting point here, then change any individual line further down.</p>
      </div>
      <span class="step__state">${mark("ok", "Set")}</span>
    </div>
    <div class="opts">
      ${["high", "standard"].map(k => `
        <button class="opt" data-tier="${k}" aria-pressed="${state.tier === k}">
          <span class="opt__label">${esc(t[k].label)}</span>
          <p class="opt__detail">${esc(t[k].plain || t[k].rule)}</p>
          <span class="opt__price">${money0(k === "high" ? highTotal : stdTotal)}</span>
          <span class="opt__sub">${k === "standard"
            ? `saves ${money0(highTotal - stdTotal)}`
            : `every line at its best version`}</span>
        </button>`).join("")}
    </div>
    ${changesPanel()}
    ${overridden ? `<p class="step__note">${overridden} line${overridden > 1 ? "s have" : " has"} been changed individually, so the live total differs from both figures above. <button class="ghostlink" id="clearOv">Clear those changes</button></p>` : ""}
  `;
  $$(".opt", step1).forEach(b => b.addEventListener("click", () => { state.tier = b.dataset.tier; render(); }));
  host.append(step1);
  const clr = $("#clearOv", step1);
  if (clr) clr.addEventListener("click", () => { state.overrides = {}; render(); });

  /* Steps 2..n: the open decisions from the catalog */
  (CATALOG.openDecisions || []).forEach((d, idx) => {
    const chosen = state.choices[d.id];
    const done = chosen != null;
    const el = document.createElement("article");
    el.className = "step glass";
    el.dataset.done = String(done);
    el.innerHTML = `
      <div class="step__head">
        <span class="step__n">${idx + 2}</span>
        <div>
          <h3 class="step__q">${esc(d.plainTitle || d.question)}</h3>
          <p class="step__why">${esc(d.plainWhy || d.question)}</p>
        </div>
        <span class="step__state">${done
          ? mark("ok", "Chosen")
          : mark("warn", "Open")}</span>
      </div>
      <div class="opts">
        ${d.options.map((o, i) => `
          <button class="opt" data-i="${i}" aria-pressed="${chosen === i}">
            <span class="opt__label">${esc(o.label)}</span>
            <p class="opt__detail">${esc(o.detail)}</p>
            <span class="opt__price">${money0(o.price)}</span>
            <span class="opt__sub">${money(o.price)}</span>
          </button>`).join("")}
      </div>
      <button class="opt opt--none" data-i="none" aria-pressed="${chosen == null}">
        <span class="opt__label">Not now</span>
        <span class="opt__detail">Leave it off the order and come back to it. Nothing else in the kit depends on it.</span>
      </button>
      <details class="disc disc--sm">
        <summary class="disc__sum">What I found</summary>
        <div class="disc__body">
          <p class="item__desc">${esc(d.note || "")}</p>
          ${d.unknown ? `<p class="item__desc"><em>${esc(d.unknown)}</em></p>` : ""}
          ${d.warning ? `<div class="item__note item__note--warn">${esc(d.warning)}</div>` : ""}
          ${d.options.filter(o => o.parts).map(o => `
            <p class="fine"><b>${esc(o.label)}</b> ${money(o.price)}: ${o.parts.map(esc).join("; ")}.${o.note ? " " + esc(o.note) : ""}</p>`).join("")}
        </div>
      </details>`;
    $$(".opt", el).forEach(b => b.addEventListener("click", () => {
      if (b.dataset.i === "none") delete state.choices[d.id];
      else state.choices[d.id] = Number(b.dataset.i);
      render();
    }));
    host.append(el);
  });

  const total = (CATALOG.openDecisions || []).length + 1;
  const settled = 1 + (CATALOG.openDecisions || []).filter(d => state.choices[d.id] != null).length;
  $("#flowProgress").innerHTML = `${settled} of ${total} settled`;
}

function renderFlags() {
  const list = flaggedItems();
  $("#flagsSummary").innerHTML =
    `${list.length} line${list.length === 1 ? "" : "s"} I have flagged for a quick answer`;
  $("#flags").innerHTML = list.length ? `
    <ul class="flags">
      ${list.map(({ pkg, item }) => `
        <li class="flag">
          <p class="flag__q">${esc(item.flagLabel || item.name)}</p>
          <p class="flag__where">${esc(pkg.name)} ${esc(item.ref)} &middot; ${esc(item.name)}</p>
          <p class="flag__body">${esc(item.openQuestion)}</p>
        </li>`).join("")}
    </ul>` : `<p class="item__desc">Nothing outstanding.</p>`;
}

/* --------------------------------------------------------------------------
   3. THE DAY — the instrument
   One box where hours, media and battery are visibly the same arithmetic.
   Move a control and every lane responds: media and power both derive from
   hours, so the relationship is the thing being drawn, not two side charts.

   Controls are built once and then synced, so a slider keeps focus and the
   bars can animate between states instead of being rebuilt mid-drag.
   -------------------------------------------------------------------------- */

/* ---- SVG chart: cumulative consumption against a capacity ceiling ----
   Series carry `points` rather than a slope, so a day that changes format
   partway through draws as a curve whose gradient changes with it. */
function lineChart({ title, unit, xMax, xLabel, target, targetLabel, series, vertexLabels }) {
  const W = 560, H = 300, P = { t: 26, r: 78, b: 44, l: 62 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;

  const yMax = Math.max(
    ...series.map(s => Math.max(s.capacity, s.points[s.points.length - 1].y))
  ) * 1.12 || 1;

  const X = h => P.l + (h / xMax) * iw;
  const Y = v => P.t + ih - (v / yMax) * ih;
  const fmt = v => v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v);

  const g = [];
  Array.from({ length: 5 }, (_, i) => (yMax / 4) * i).forEach(v => g.push(
    `<line class="ax__grid" x1="${P.l}" y1="${Y(v)}" x2="${P.l + iw}" y2="${Y(v)}"/>`,
    `<text class="ax__lab" x="${P.l - 10}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`
  ));
  Array.from({ length: 7 }, (_, i) => (xMax / 6) * i).forEach(h => g.push(
    `<text class="ax__lab" x="${X(h)}" y="${P.t + ih + 20}" text-anchor="middle">${h % 1 ? h.toFixed(1) : h}</text>`
  ));
  g.push(`<line class="ax__line" x1="${P.l}" y1="${P.t + ih}" x2="${P.l + iw}" y2="${P.t + ih}"/>`);
  g.push(`<text class="ax__title" x="${P.l + iw / 2}" y="${H - 6}" text-anchor="middle">${xLabel}</text>`);
  g.push(`<text class="ax__title" x="${P.l - 46}" y="${P.t - 12}" text-anchor="start">${unit}</text>`);

  if (target != null && target <= xMax) {
    /* The rule can sit anywhere the sliders put it. Near the right edge its
       label would run into the ceiling labels in the margin, so it flips to
       the other side of its own rule instead. */
    const late = X(target) > P.l + iw * 0.72;
    g.push(`<line class="ax__target" x1="${X(target)}" y1="${P.t - 4}" x2="${X(target)}" y2="${P.t + ih}"/>`);
    g.push(`<text class="ax__targetlab" x="${X(target) + (late ? -5 : 5)}" y="${P.t + 6}" text-anchor="${late ? "end" : "start"}">${targetLabel}</text>`);
  }

  /* Two cameras can carry the same number of cards, which puts their ceiling
     lines on exactly the same y. The lines may coincide; their labels must
     not: the repeated ceiling figure is drawn once, and the "clears it" notes
     stack upward so the margin holds one label per line of text. */
  const dupAt = si => series.slice(0, si).filter(o => Math.abs(o.capacity - series[si].capacity) < 0.5).length;

  series.forEach((s, si) => {
    g.push(`<line class="ax__cap" stroke="${s.color}" x1="${P.l}" y1="${Y(s.capacity)}" x2="${P.l + iw}" y2="${Y(s.capacity)}"/>`);
    if (!dupAt(si))
      g.push(`<text class="ax__caplab" fill="${s.color}" x="${P.l + iw + 6}" y="${Y(s.capacity) + 4}">${fmt(s.capacity)}</text>`);
  });

  const same = JSON.stringify(series[0].points.map(p => p.y));
  const shared = series.length > 1 && series.every(s => JSON.stringify(s.points.map(p => p.y)) === same);

  const path = pts => "M " + pts.map(p => `${X(p.x)} ${Y(p.y)}`).join(" L ");

  if (shared) {
    g.push(`<path class="mark__line mark__line--shared" d="${path(series[0].points)}"/>`);
    /* Name each segment at its own vertex, so the gradient change is legible */
    if (vertexLabels) series[0].points.slice(1).forEach((pt, i) => {
      if (!pt.seg) return;
      g.push(`<circle class="mark__vertex" cx="${X(pt.x)}" cy="${Y(pt.y)}" r="3"/>`);
      /* A short second block puts its vertex almost on top of the first, so
         the names alternate above and below the curve rather than stacking. */
      g.push(`<text class="mark__rate" x="${X(pt.x)}" y="${Y(pt.y) + (i % 2 ? 18 : -10)}" text-anchor="${i ? "end" : "middle"}">${pt.seg}</text>`);
    });
  }

  series.forEach((s, si) => {
    if (!shared) g.push(`<path class="mark__line" stroke="${s.color}" d="${path(s.points)}"/>`);
    const cross = crossAt(s.points, s.capacity);
    if (cross != null && cross <= xMax) {
      const dy = si % 2 ? 20 : -13;
      g.push(`<circle class="mark__ring" cx="${X(cross)}" cy="${Y(s.capacity)}" r="6.5" fill="${s.color}"/>`);
      g.push(`<text class="mark__lab" fill="${s.color}" x="${X(cross)}" y="${Y(s.capacity) + dy}" text-anchor="middle">${s.name.replace("Sony ", "")} ${cross.toFixed(1)} h</text>`);
    } else {
      g.push(`<text class="mark__lab" fill="${s.color}" x="${P.l + iw + 6}" y="${Y(s.capacity) - 9 - dupAt(si) * 13}">${s.name.replace("Sony ", "")} clears it</text>`);
    }
  });

  g.push(`<line class="chart__cross" x1="0" y1="${P.t}" x2="0" y2="${P.t + ih}" style="opacity:0"/>`);
  g.push(`<rect class="chart__hit" x="${P.l}" y="${P.t}" width="${iw}" height="${ih}" fill="transparent"/>`);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart__svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  svg.innerHTML = g.join("");

  const fig = document.createElement("figure");
  fig.className = "chart";
  fig.innerHTML = `
    <figcaption class="chart__title">${title}</figcaption>
    <div class="chart__legend">
      ${series.map(s => `<span class="lg"><i style="background:${s.color}"></i>${s.name}<em>${fmt(s.capacity)} ${unit} on the build</em></span>`).join("")}
    </div>`;
  fig.append(svg);

  const tip = document.createElement("div");
  tip.className = "chart__tip";
  fig.append(tip);

  /* Value of a cumulative curve at an arbitrary x */
  const at = (pts, x) => {
    for (let i = 1; i < pts.length; i++) {
      const A = pts[i - 1], B = pts[i];
      if (x <= B.x) return A.y + ((x - A.x) / (B.x - A.x || 1)) * (B.y - A.y);
    }
    const L = pts[pts.length - 1], K = pts[pts.length - 2] || { x: 0, y: 0 };
    const slope = (L.y - K.y) / (L.x - K.x || 1);
    return L.y + (x - L.x) * slope;
  };

  const hit = svg.querySelector(".chart__hit"), cross = svg.querySelector(".chart__cross");
  hit.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect();
    const h = Math.max(0, Math.min(xMax, (((e.clientX - r.left) / r.width * W) - P.l) / iw * xMax));
    cross.setAttribute("x1", X(h)); cross.setAttribute("x2", X(h));
    cross.style.opacity = "1"; tip.style.opacity = "1";
    tip.style.left = `${(X(h) / W) * 100}%`;
    tip.innerHTML = `<strong>${h.toFixed(1)} h &middot; ${fmt(at(series[0].points, h))} ${unit}</strong>`
      + series.map(s => {
          const pctv = (at(s.points, h) / s.capacity) * 100;
          return `<span><i style="background:${s.color}"></i>${s.name}
                  <em>${pctv > 100 ? "over capacity" : Math.round(pctv) + "% used"}</em></span>`;
        }).join("");
  });
  hit.addEventListener("pointerleave", () => { cross.style.opacity = "0"; tip.style.opacity = "0"; });
  return fig;
}

/* Round a raw axis step up to something a human reads: 1, 2, 5, 10... */
function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = (raw || 1) / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/* How far the cards last if the day simply kept going at its last rate.
   Flagged as an estimate so the drawing can mark it as such. */
function mediaRunway(m) {
  const segs = segments().filter(s => s.hours > 0);
  const recH = recordHours();
  if (m.mediaRunwayH != null) return { h: m.mediaRunwayH, est: false };
  const lastRate = segs.length ? (fmtById(segs[segs.length - 1].formatId).gbPerHour || 0) : 0;
  if (!lastRate) return { h: Infinity, est: true };
  return { h: recH + (m.gb - m.needGb) / lastRate, est: true };
}

/* One lane per thing that can run out. Media lanes are measured against the
   rolling hours, power lanes against the powered hours: the two rules on the
   drawing say which is which. */
function simLanes() {
  const rows = model();
  const dayH = poweredHours(), recH = recordHours();
  const lanes = [];

  rows.forEach(m => {
    lanes.push({
      id: m.cam.id + "-pow",
      group: m.cam.name.replace("Sony ", ""),
      k: "Battery",
      color: SERIES[m.cam.id],
      needH: dayH,
      runH: m.wh ? m.powerRunwayH : 0,
      ok: m.powerOk,
      value: m.wh ? hrs(m.powerRunwayH) : "0 h",
      sub: `needs ${dayH} h`,
      est: false,
      solidH: null,
    });
    const mr = mediaRunway(m);
    lanes.push({
      id: m.cam.id + "-med",
      group: m.cam.name.replace("Sony ", ""),
      k: "Cards",
      color: SERIES[m.cam.id],
      needH: recH,
      runH: m.gb ? mr.h : 0,
      ok: m.mediaOk,
      value: !m.gb ? "0 h" : (isFinite(mr.h) ? hrs(mr.h) : "no limit"),
      sub: `needs ${recH} h`,
      est: mr.est,
      solidH: m.gb ? Math.min(mr.h, recH) : 0,
    });
  });

  return lanes;
}

/* ---- Controls: built once, then synced. Rebuilding them mid-drag would
   throw away the slider's focus and the bar animations with it. ---- */
function buildControls() {
  const d = CATALOG.designTargets;
  const ctl = $("#plannerControls");
  if (ctl.dataset.built) return;
  ctl.dataset.built = "1";

  const choices = d.segmentFormatChoices || {};
  const segs = segments();

  ctl.innerHTML = `
    <div class="ctl__group ctl__group--day">
      <span class="ctl__label">What kind of day is it</span>
      <div class="ctl__segs" id="scSegs">
        ${d.scenarios.map(x => `<button class="ctl__seg" data-sc="${x.id}">${esc(x.label)}</button>`).join("")}
      </div>
    </div>

    ${segs.map((g, i) => {
      const opts = choices[g.label] || d.formats.map(f => f.id);
      return `
      <div class="ctl__group ctl__group--wide">
        <span class="ctl__label">${esc(g.label)} <b data-h="${i}"></b> in <b data-res="${i}"></b></span>
        <div class="ctl__pair">
          <input class="ctl__range" data-seg="${i}" type="range" min="0" max="10" step="0.5" aria-label="${esc(g.label)} hours">
          <select class="ctl__select" data-segfmt="${i}" aria-label="${esc(g.label)} recording format">
            ${opts.map(id => `<option value="${id}">${esc(fmtById(id).label)}</option>`).join("")}
          </select>
        </div>
        <span class="fine" data-rate="${i}"></span>
      </div>`;
    }).join("")}

    <div class="ctl__group ctl__group--wide">
      <span class="ctl__label">Cameras switched on for <b data-pow></b> of a <b>${d.maxPoweredHours} h</b> max day</span>
      <input class="ctl__range" id="powRange" type="range" min="4" max="${d.maxPoweredHours}" step="0.5" aria-label="Hours the cameras are powered">
      <span class="fine">Powered time, not rolling time. A camera drains whether or not it is recording.</span>
    </div>
  `;

  const commit = () => { state.segs = segments().map(g => ({ formatId: g.formatId, hours: g.hours })); };

  $$("[data-sc]", ctl).forEach(b => b.addEventListener("click", () => {
    state.scenario = b.dataset.sc; state.segs = null; state.poweredH = null; render();
  }));
  $$("[data-seg]", ctl).forEach(r => r.addEventListener("input", e => {
    commit(); state.segs[+e.target.dataset.seg].hours = Number(e.target.value); render();
  }));
  $$("[data-segfmt]", ctl).forEach(sel => sel.addEventListener("change", e => {
    commit(); state.segs[+e.target.dataset.segfmt].formatId = e.target.value; render();
  }));
  $("#powRange").addEventListener("input", e => { state.poweredH = Number(e.target.value); render(); });
}

function syncControls() {
  const ctl = $("#plannerControls");
  const sc = scenario();
  const segs = segments();

  $$("[data-sc]", ctl).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sc === sc.id)));

  segs.forEach((g, i) => {
    const f = fmtById(g.formatId);
    const r = $(`[data-seg="${i}"]`, ctl);
    if (r && document.activeElement !== r) r.value = g.hours;
    else if (r) r.value = g.hours;
    const sel = $(`[data-segfmt="${i}"]`, ctl);
    if (sel) sel.value = g.formatId;
    $(`[data-h="${i}"]`, ctl).textContent   = `${g.hours} h`;
    $(`[data-res="${i}"]`, ctl).textContent = f.res;
    $(`[data-rate="${i}"]`, ctl).textContent = `${f.gbPerHour} GB per hour at ${f.mbps} Mb/s`;
  });

  const pow = $("#powRange", ctl);
  pow.value = poweredHours();
  $("[data-pow]", ctl).textContent = `${poweredHours()} h`;
}

/* ---- The runway drawing. Built once, then only widths, labels and label
   placement move, so every change is a transition rather than a redraw.
   All geometry is expressed in percent, so the drawing reflows with its
   container; only the rule labels need measuring, and those are re-measured
   on every resize rather than captured once. ---- */
function simGeometry() {
  const lanes = simLanes();
  const dayH = poweredHours(), recH = recordHours();
  /* Keep the axis honest but readable: never let one enormous runway
     squash the lanes that matter into the first inch of the drawing. */
  const finite = lanes.map(l => l.runH).filter(h => isFinite(h) && h > 0);
  const anchor = Math.max(dayH, recH, 1);
  const xMax = Math.max(anchor * 1.12, Math.min(Math.max(...finite, 0) * 1.06, anchor * 1.9));
  const pct = h => Math.max(0, Math.min(100, (h / xMax) * 100));
  return { lanes, dayH, recH, xMax, pct };
}

/* The two vertical rules can land arbitrarily close, because the client sets
   both hours with sliders. Their labels are therefore laid out by measurement
   at render time: clamped inside the plot, merged when the rules coincide,
   and stacked onto a second row when the text would otherwise collide. */
function layoutRules() {
  const host = $("#runway");
  const ov = $(".rw__overlay", host);
  if (!ov) return;
  const { dayH, recH, pct } = simGeometry();
  const rec = $(".rw__rule--rec", host), day = $(".rw__rule--day", host);
  const recB = $("b", rec), dayB = $("b", day);

  rec.style.left = pct(recH) + "%";
  day.style.left = pct(dayH) + "%";
  rec.hidden = recH <= 0;
  rec.dataset.row = "0"; day.dataset.row = "0";
  recB.textContent = `last take · ${recH} h`;
  dayB.textContent = `end of day · ${dayH} h`;
  recB.style.transform = ""; dayB.style.transform = "";

  const W = ov.getBoundingClientRect().width;
  if (!W) return;                       /* not laid out yet, e.g. in a closed tab */

  const xr = (pct(recH) / 100) * W, xd = (pct(dayH) / 100) * W;

  /* Two rules within a couple of pixels are one moment in the day: say so
     once rather than printing two labels over each other. */
  if (!rec.hidden && Math.abs(xr - xd) < 6) {
    rec.hidden = true;
    dayB.textContent = `last take and end of day · ${dayH} h`;
  }

  /* Keep each label inside the drawing, then test the boxes that result.
     Capping the label at the plot width first is what makes that a guarantee
     rather than a hope: on a narrow phone a label could be wider than the plot
     it belongs to, and `W - w` then went negative, so the clamp floored at 0
     and the label ran out of the drawing to the right. Capped, w <= W always,
     so 0 <= left and left + w <= W both hold at every width. */
  const place = (el, x) => {
    el.style.maxWidth = Math.floor(W) + "px";
    const w = el.getBoundingClientRect().width;
    const left = Math.max(0, Math.min(Math.max(0, W - w), x - w / 2));
    el.style.transform = `translateX(${Math.round(left - x)}px)`;
    return [left, left + w];
  };
  const boxD = place(dayB, xd);
  if (rec.hidden) return;
  const boxR = place(recB, xr);

  const GAP = 10;
  if (boxR[1] + GAP > boxD[0] && boxD[1] + GAP > boxR[0]) rec.dataset.row = "1";
}

function renderRunway() {
  const host = $("#runway");
  const { lanes, dayH, recH, xMax, pct } = simGeometry();
  const step = niceStep(xMax / 6);

  if (host.dataset.built !== String(lanes.length)) {
    host.dataset.built = String(lanes.length);
    host.innerHTML = `
      <div class="rw__overlay" aria-hidden="true">
        <i class="rw__rule rw__rule--rec"><b></b></i>
        <i class="rw__rule rw__rule--day"><b></b></i>
      </div>
      ${lanes.map(l => `
        <div class="rw__lane" data-lane="${l.id}">
          <span class="rw__k"><b></b><em></em></span>
          <div class="rw__plot">
            <div class="rw__bar"></div>
            <div class="rw__tail"></div>
            <span class="rw__cap"></span>
          </div>
          <span class="rw__v"><span class="rw__mark"></span><b></b><em></em></span>
        </div>`).join("")}
      <div class="rw__lane rw__lane--axis">
        <span class="rw__k"></span>
        <div class="rw__axis"></div>
        <span class="rw__v"></span>
      </div>`;
  }

  lanes.forEach(l => {
    const row = $(`[data-lane="${l.id}"]`, host);
    row.dataset.state = l.ok ? "ok" : "short";
    row.dataset.est = String(!!l.est);
    $(".rw__k b", row).textContent = l.group;
    $(".rw__k em", row).textContent = l.k;
    const end = isFinite(l.runH) ? pct(l.runH) : 100;
    const solid = l.solidH == null ? end : Math.min(end, pct(l.solidH));
    const plot = $(".rw__plot", row);
    plot.style.setProperty("--c", l.color);
    const bar = $(".rw__bar", row);
    bar.style.width = solid + "%";
    /* The tail is arithmetic, not stock: it is what the cards would still
       hold if the day simply kept rolling at the same rate. */
    const tail = $(".rw__tail", row);
    tail.style.left = solid + "%";
    tail.style.width = Math.max(0, end - solid) + "%";
    tail.hidden = end - solid < 0.4;
    const cap = $(".rw__cap", row);
    cap.style.left = end + "%";
    cap.dataset.over = String(!isFinite(l.runH) || l.runH > xMax);
    $(".rw__mark", row).innerHTML = l.needH
      ? mark(l.ok ? "ok" : "short", l.ok ? "Covered" : "Short") : "";
    $(".rw__v b", row).textContent = l.value;
    $(".rw__v em", row).textContent = l.sub;
    row.setAttribute("aria-label", `${l.group} ${l.k}: ${l.value}, ${l.sub}, ${l.ok ? "covered" : "short"}`);
  });

  const ticks = [];
  for (let h = 0; h <= xMax + 0.001; h += step) ticks.push(h);
  $(".rw__axis", host).innerHTML = ticks
    .map(h => `<i style="left:${pct(h)}%">${h % 1 ? h.toFixed(1) : h}</i>`).join("");

  layoutRules();
}

/* The label layout is the only measured thing on the page, so it is the only
   thing that has to be told when the window changes shape. */
let rulesFrame = 0;
function relayoutRules() {
  cancelAnimationFrame(rulesFrame);
  rulesFrame = requestAnimationFrame(layoutRules);
}
function watchRunway() {
  addEventListener("resize", relayoutRules);
  addEventListener("orientationchange", relayoutRules);
  if ("ResizeObserver" in window) {
    /* Labels are absolutely positioned, so laying them out cannot change the
       observed box: no feedback loop. */
    new ResizeObserver(relayoutRules).observe($("#runway"));
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayoutRules);
}

/* ---- The arithmetic, written out. This is the whole argument for the
   size of the order, and it is four multiplications. ---- */
function renderEquations() {
  const host = $("#equations");
  const rows = model();
  const dayH = poweredHours(), recH = recordHours();
  const segs = segments().filter(s => s.hours > 0);

  const mediaSum = segs.map(s => `${s.hours} h × ${fmtById(s.formatId).gbPerHour} GB/h`).join("  +  ") || "0 h";

  host.innerHTML = rows.map(m => {
    const powerHead = m.powerOk
      ? `Enough battery for the full ${dayH}-hour day, with ${plainHours(Math.max(0, m.powerRunwayH - dayH))} spare`
      : m.wh ? `Battery runs out after ${plainHours(m.powerRunwayH)}`
             : `No battery in the build for this camera`;
    const mediaHead = m.mediaOk
      ? `Enough cards for all ${recH} hour${recH === 1 ? "" : "s"} of recording`
      : m.gb ? `Cards fill up after ${m.mediaRunwayH != null ? plainHours(m.mediaRunwayH) : "the day"}`
             : `No cards in the build for this camera`;

    return `
      <article class="eq">
        <p class="eq__cam"><i class="gauge__dot" style="background:${SERIES[m.cam.id]}"></i>${esc(m.cam.name)}</p>

        <div class="eq__row" data-state="${m.powerOk ? "ok" : "short"}">
          <p class="eq__plain">${mark(m.powerOk ? "ok" : "short", m.powerOk ? "Covered" : "Short")} ${powerHead}</p>
          <p class="eq__math">
            <span>${dayH} h powered</span><span class="eq__op">×</span><span>${m.loadW.toFixed(1)} W</span>
            <span class="eq__op">=</span><span class="eq__need">${Math.round(dayH * m.loadW)} Wh needed</span>
            <span class="eq__vs">against</span><span class="eq__have">${m.wh} Wh on the build</span>
          </p>
        </div>

        <div class="eq__row" data-state="${m.mediaOk ? "ok" : "short"}">
          <p class="eq__plain">${mark(m.mediaOk ? "ok" : "short", m.mediaOk ? "Covered" : "Short")} ${mediaHead}</p>
          <p class="eq__math">
            <span>${mediaSum}</span>
            <span class="eq__op">=</span><span class="eq__need">${Math.round(m.needGb)} GB needed</span>
            <span class="eq__vs">against</span><span class="eq__have">${m.gb} GB on the build</span>
          </p>
        </div>
      </article>`;
  }).join("");
}

function renderPlanner() {
  const d = CATALOG.designTargets;
  const sc = scenario();
  const segs = segments();
  const rows = model();
  const p = PL();

  buildControls();
  syncControls();
  renderRunway();
  renderEquations();

  /* The one-sentence version of the whole instrument */
  const parts = segs.filter(g => g.hours > 0)
    .map(g => `${g.hours} h of ${g.label.toLowerCase()} in ${fmtById(g.formatId).res}`);
  const allOk = rows.every(m => m.powerOk && m.mediaOk);
  $("#daySum").innerHTML =
    `<b>${esc(sc.label)}.</b> ${parts.length ? parts.join(", ") + ", " : ""}cameras switched on for ${poweredHours()} hours. ` +
    (allOk
      ? `Both cameras get through it on battery and on cards.`
      : `${rows.filter(m => !m.powerOk || !m.mediaOk).map(m => esc(m.cam.name)).join(" and ")} does not get through it.`) +
    ` <span class="fine fine--inline">${Math.round(gbNeeded())} GB per camera across ${recordHours()} h of recording.</span>`;

  $("#scenarioNote").textContent = `${sc.detail} ${sc.acNote}`;
  $("#basisNote").textContent = d.powerBasis;
  if (p.detailToggle) $("#detailToggle").textContent = p.detailToggle;

  const cHost = $("#charts"); cHost.innerHTML = "";
  const curve = mediaCurve();

  if (recordHours() > 0) cHost.append(lineChart({
    title: "Media consumed while rolling",
    unit: "GB",
    xLabel: "Hours of recording",
    xMax: Math.max(recordHours(), ...rows.map(m => m.mediaRunwayH || 0)) * 1.08 || 1,
    target: recordHours(),
    targetLabel: `${recordHours()} h rolling`,
    vertexLabels: true,
    series: rows.map(m => ({ id: m.cam.id, name: m.cam.name, color: SERIES[m.cam.id], points: curve, capacity: m.gb })),
  }));

  cHost.append(lineChart({
    title: "Power drawn while the camera is hot",
    unit: "Wh",
    xLabel: "Hours powered",
    xMax: Math.max(poweredHours(), ...rows.map(m => m.powerRunwayH)) * 1.05,
    target: poweredHours(),
    targetLabel: `${poweredHours()} h powered`,
    series: rows.map(m => ({
      id: m.cam.id, name: m.cam.name, color: SERIES[m.cam.id], capacity: m.wh,
      points: [{ x: 0, y: 0 }, { x: poweredHours() * 1.6, y: m.loadW * poweredHours() * 1.6 }],
    })),
  }));

  $("#plannerTable").innerHTML = `
    <table class="dtable">
      <caption>The same figures as numbers</caption>
      <thead><tr><th>Camera</th><th>Draw</th><th>Power on build</th><th>Runs out</th><th>Media on build</th><th>Media needed</th><th>Fills at</th></tr></thead>
      <tbody>
        ${rows.map(m => `<tr>
          <th scope="row"><i class="gauge__dot" style="background:${SERIES[m.cam.id]}"></i>${esc(m.cam.name)}</th>
          <td>${m.loadW.toFixed(1)} W</td>
          <td>${m.wh} Wh</td>
          <td>${m.powerRunwayH.toFixed(1)} h${m.powerOk ? "" : ` (short ${m.powerShortWh} Wh)`}</td>
          <td>${m.gb} GB</td>
          <td>${Math.round(m.needGb)} GB</td>
          <td>${m.mediaOk ? "clears the day" : (m.mediaRunwayH != null ? m.mediaRunwayH.toFixed(1) + " h" : "&mdash;") + ` (short ${m.mediaShortGb} GB)`}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

/* --------------------------------------------------------------------------
   4. THE LIST
   Name, one plain sentence, price. Everything else on demand.
   -------------------------------------------------------------------------- */
/* What this particular line loses, or why it cannot be cheaper. Sits with the
   switch, not inside the spec, because it is the consequence of the choice. */
function consequenceStrip(item, t) {
  const h = item.tiers.high, s = item.tiers.standard;
  const saving = (h && s && h.price != null && s.price != null)
    ? (h.price - s.price) * item.qty : 0;

  if (t === "standard" && s) {
    return `<div class="cons cons--live">
      <span class="cons__k">On the cheaper one</span>
      <p class="cons__t">${esc(s.tradeoff || "Cheaper equivalent for the same job.")}</p>
    </div>`;
  }
  if (s) {
    return `<details class="cons cons--offer">
      <summary class="cons__sum">Cheaper option saves ${money(saving)} &mdash; see what changes</summary>
      <p class="cons__t">${esc(s.tradeoff || "Cheaper equivalent for the same job.")}</p>
    </details>`;
  }
  if (item.noStandard) {
    return `<details class="cons cons--none">
      <summary class="cons__sum">No cheaper option &mdash; why</summary>
      <p class="cons__t">${esc(item.noStandard)}</p>
    </details>`;
  }
  return "";
}

function itemNode(item) {
  const o = offerFor(item);
  const t = tierFor(item);
  const dropped = state.dropped.has(item.id);
  const hasStd = !!item.tiers.standard;

  const el = document.createElement("article");
  el.className = "item glass";
  el.dataset.itemId = item.id;
  el.dataset.excluded = String(dropped);
  if (item.openQuestion) el.dataset.flag = "true";

  const chips = [];
  if (item.qty > 1)                 chips.push(["chip chip--gold", `${item.qty} ×`]);
  if (item.unit !== "each" && item.unit !== "mixed") chips.push(["chip", item.unit]);
  if (t === "standard")             chips.push(["chip chip--gold", "Standard"]);
  if (o && o.condition === "used")  chips.push(["chip chip--warn", "B&H used"]);
  /* Anything that is not simply in stock decides whether a line makes the
     shoot, so it belongs on the card and not inside the spec disclosure. */
  if (o && o.stock && o.stock !== "In Stock")
    chips.push(["chip chip--warn", esc(o.stock)]);
  if (item.atCounter)               chips.push(["chip chip--warn", "Buy at the counter"]);
  if (item.openQuestion)            chips.push(["chip chip--warn", "Needs an answer"]);

  /* Specs that used to shout from the card now sit in the fine line */
  const spec = [];
  if (o && o.sku)   spec.push(`B&amp;H item ${esc(String(o.sku).replace(/-REG$/, ""))}`);
  if (item.wh)      spec.push(`${item.wh} Wh × ${(item.cells || 1) * item.qty}`);
  if (item.gb)      spec.push(`${item.gb} GB × ${(item.cells || 1) * item.qty}`);
  if (item.watts)   spec.push(`draws ${item.watts} W`);
  if (o && o.stock) spec.push(esc(o.stock));
  if (o && o.verified) spec.push(`price checked ${esc(o.verified)}`);

  /* The product shot. Knocked out to transparency, so it sits on the card
     rather than punching a white rectangle into it. Decorative: the name
     beside it already carries the meaning, so it stays out of the a11y tree. */
  /* A line with no shot still gets the well, empty. Dropping the column
     instead pulls the whole row 112px left, and the ref numbers stop forming
     a column you can run a finger down, which is how this sheet gets read. */
  const fig = document.createElement("div");
  fig.className = o && o.image ? "item__shot" : "item__shot item__shot--none";
  if (o && o.image)
    fig.innerHTML = `<img src="${esc(o.image)}" alt="" loading="lazy" decoding="async" width="460" height="460">`;
  el.append(fig);

  const body = document.createElement("div");
  body.className = "item__main";
  body.innerHTML = `
    <p class="item__top"><span class="item__ref">${esc(item.ref)}</span> ${
      o && o.url
        ? `<a class="item__name item__go" href="${esc(o.url)}" target="_blank" rel="noopener">${
            esc(o && o.name ? o.name : item.name)
          }<span class="item__go-i" aria-hidden="true">&#8599;</span><span class="sr-only"> — opens the product page at ${
            vendorOf(o.url)
          } in a new tab</span></a>`
        : `<span class="item__name">${esc(o && o.name ? o.name : item.name)}</span>`
    }</p>
    ${item.plain ? `<p class="item__plain">${esc(item.plain)}</p>` : ""}
    ${chips.length ? `<div class="item__chips">${chips.map(([c, x]) => `<span class="${c}">${x}</span>`).join("")}</div>` : ""}
    ${consequenceStrip(item, t)}
    <details class="disc disc--sm">
      <summary class="disc__sum">Full spec</summary>
      <div class="disc__body">
        <p class="item__desc">${esc(item.desc)}</p>
        ${spec.length ? `<p class="fine">${spec.join(" &middot; ")}</p>` : ""}
        ${Array.isArray(o && o.bundle) && o.bundle.length ? `
        <p class="fine"><b>This line is more than one item number.</b> Ordering it means:</p>
        <ul class="item__bundle">${o.bundle.map(b =>
          `<li>${b.qty} &times; ${esc(b.name)} &mdash; <span class="mono">${esc(b.sku)}</span>, ${money(b.price)} each</li>`).join("")}</ul>` : ""}
        ${o && o.url ? `<a class="item__link" href="${esc(o.url)}" target="_blank" rel="noopener">View at ${vendorOf(o.url)} &rarr;</a>` : ""}
      </div>
    </details>
    ${item.openQuestion ? `<div class="item__note"><b>${esc(item.flagLabel || "Needs an answer")}</b> ${esc(item.openQuestion)}</div>` : ""}
  `;

  const buy = document.createElement("div");
  buy.className = "item__buy";
  const price = o && o.price != null
    ? `<div class="item__price">${money(o.price * item.qty)}</div>
       ${item.qty > 1 ? `<div class="item__unit">${money(o.price)} each</div>` : ""}`
    : `<div class="item__price item__price--counter">At counter</div>
       <div class="item__unit">not in the total</div>`;

  const saving = (() => {
    const h = item.tiers.high, s = item.tiers.standard;
    if (t === "standard" && h && s && h.price != null && s.price != null && s.price < h.price)
      return `<div class="item__was">${money(h.price * item.qty)}</div>
              <div class="item__save">saves ${money((h.price - s.price) * item.qty)}</div>`;
    return "";
  })();

  buy.innerHTML = `
    ${price}
    ${saving}
    <div class="override" role="group" aria-label="Version for this line">
      <button data-tier="high"     aria-pressed="${t === "high"}">Best</button>
      <button data-tier="standard" aria-pressed="${t === "standard"}" ${hasStd ? "" : `disabled title="${esc(item.noStandard || "No cheaper alternative")}"`}>Cheaper</button>
    </div>
    <button class="item__drop">${dropped ? "Add back" : "Remove"}</button>
  `;

  el.append(body, buy);

  /* Choosing the tier the whole build is already on is not an override: it is
     putting the line back. Recording it anyway made step one announce that a
     line had been changed individually when nothing had. */
  $$(".override button", buy).forEach(b => b.addEventListener("click", () => {
    if (b.dataset.tier === state.tier) delete state.overrides[item.id];
    else state.overrides[item.id] = b.dataset.tier;
    render();
  }));
  $(".item__drop", buy).addEventListener("click", () => {
    state.dropped.has(item.id) ? state.dropped.delete(item.id) : state.dropped.add(item.id);
    render();
  });

  return el;
}

function sectionNode(sec) {
  if (sec.optional && !state.optional) return null;
  const sum = sec.items.reduce((a, i) => a + lineTotal(i), 0);
  const el = document.createElement("section");
  el.className = "sec";
  el.innerHTML = `
    <div class="sec__head sec__head--sm">
      <span class="sec__num">${sec.num}</span>
      <h4 class="sec__name">${esc(sec.name)}</h4>
      ${sec.optional ? `<span class="sec__badge">Optional</span>` : ""}
      <span class="sec__rule"></span>
      <span class="sec__sum">${money(sum)}</span>
    </div>
    <div class="items"></div>
  `;
  const holder = $(".items", el);
  sec.items.forEach(i => holder.append(itemNode(i)));
  return el;
}

function packageNode(pkg) {
  const live = pkg.sections.filter(s => !s.optional || state.optional);
  const sum = live.flatMap(s => s.items).reduce((a, i) => a + lineTotal(i), 0);
  const count = live.flatMap(s => s.items).filter(i => !state.dropped.has(i.id)).length;

  const el = document.createElement("section");
  el.className = "pkg";
  el.id = "pkg-" + pkg.id;
  el.innerHTML = `
    <div class="wrap">
      <details class="pkg__wrap" open>
        <summary class="pkg__head">
          <h3 class="pkg__name">${esc(pkg.name)}</h3>
          <span class="pkg__id">${count} line${count === 1 ? "" : "s"}</span>
          <span class="pkg__sum">${money(sum)}</span>
        </summary>
        ${pkg.plainIntro ? `<p class="pkg__intro">${esc(pkg.plainIntro)}</p>` : ""}
        <div class="pkg__body"></div>
      </details>
    </div>
  `;
  const body = $(".pkg__body", el);
  pkg.sections.forEach(s => { const n = sectionNode(s); if (n) body.append(n); });
  return el;
}

/* --------------------------------------------------------------------------
   5. Totals and the B&H handoff
   -------------------------------------------------------------------------- */
function activeLines() {
  const out = [];
  for (const p of CATALOG.packages)
    for (const s of p.sections) {
      if (s.optional && !state.optional) continue;
      for (const i of s.items) if (!state.dropped.has(i.id)) out.push({ pkg: p, item: i, offer: offerFor(i) });
    }
  return out;
}

function liveSubtotal() {
  let grand = CATALOG.packages.reduce((a, p) => a +
    p.sections.filter(s => !s.optional || state.optional)
              .flatMap(s => s.items)
              .reduce((b, i) => b + lineTotal(i), 0), 0);
  (CATALOG.openDecisions || []).forEach(d => {
    const i = state.choices[d.id];
    if (i != null && d.options[i]) grand += d.options[i].price;
  });
  return grand;
}

function skuBlock() {
  /* One row per item number, never one row per line. The same part can appear
     on two lines (the FX3 and the FX9 both take the same brick, the two
     monitors are the same monitor), and this block is pasted straight into
     B&H Quick Order. If that form treats a repeated number as "set quantity"
     rather than "add to quantity", a duplicated row silently orders 1 instead
     of 7. Summing here is correct under either behaviour. */
  const merged = new Map();
  const add = (sku, qty, name) => {
    const k = String(sku).replace(/-REG$/, "");
    const at = merged.get(k);
    if (at) {
      at.qty += qty;
      if (!at.names.includes(name)) at.names.push(name);
    } else {
      merged.set(k, { qty, names: [name] });
    }
  };

  activeLines()
    .filter(l => l.offer && l.offer.sku && l.offer.price != null)
    .forEach(l => {
      /* Some lines are a bundle the vendor does not sell as one item number:
         4.1 on the cheaper tier is two batteries and a charger. Emitting the
         line's own number once would order a third of what the line prices. */
      if (Array.isArray(l.offer.bundle) && l.offer.bundle.length)
        l.offer.bundle.forEach(b => add(b.sku, b.qty * l.item.qty, b.name));
      else
        add(l.offer.sku, l.item.qty, l.item.name);
    });

  const rows = [...merged].map(([sku, r]) =>
    `${sku.padEnd(12)} ${String(r.qty).padStart(2)}   ${r.names.join(" + ")}`);
  const counter = activeLines().filter(l => !l.offer || l.offer.price == null);
  let out = rows.join("\n");
  if (counter.length)
    out += "\n\nAt counter, not priced:\n" + counter.map(l => `  ${l.item.ref}  ${l.item.name}`).join("\n");
  return out;
}

function renderTotals() {
  const host = $("#totals");
  const perPkg = CATALOG.packages.map(p => ({
    name: p.name,
    sum: p.sections.filter(s => !s.optional || state.optional)
                   .flatMap(s => s.items)
                   .reduce((a, i) => a + lineTotal(i), 0),
  }));

  const picked = (CATALOG.openDecisions || [])
    .filter(d => state.choices[d.id] != null)
    .map(d => ({ d, o: d.options[state.choices[d.id]] }));

  const grand = liveSubtotal();
  const tax = grand * CATALOG.meta.salesTax.rate;
  const counterCount = activeLines().filter(l => !l.offer || l.offer.price == null).length;

  host.innerHTML = `
    ${perPkg.map(p => `<div class="totals__row"><span class="totals__k">${esc(p.name)}</span><span class="totals__v">${money(p.sum)}</span></div>`).join("")}
    ${picked.map(p => `<div class="totals__row"><span class="totals__k">${esc(p.d.plainTitle || p.d.question.split(".")[0])} &middot; ${esc(p.o.label)}</span><span class="totals__v">${money(p.o.price)}</span></div>`).join("")}
    <div class="totals__row totals__row--grand"><span class="totals__k">Before tax</span><span class="totals__v">${money(grand)}</span></div>
    <div class="totals__row"><span class="totals__k">NYC sales tax at ${(CATALOG.meta.salesTax.rate * 100).toFixed(3)}%</span><span class="totals__v">${money(tax)}</span></div>
    <div class="totals__row totals__row--pay"><span class="totals__k">What you would pay today</span><span class="totals__v">${money(grand + tax)}</span></div>
    <p class="fine">
      Sales tax: ${esc(CATALOG.meta.salesTax.note)}
      ${counterCount ? ` ${counterCount} line${counterCount > 1 ? "s are" : " is"} bought at the counter and not counted above.` : ""}
      ${esc(CATALOG.meta.priceDisclaimer || "")}
    </p>
  `;
  $("#barTotal").textContent = money0(grand);
  $("#skus").textContent = skuBlock();
}

/* --------------------------------------------------------------------------
   Main render
   -------------------------------------------------------------------------- */
function render() {
  const pkgHost = $("#packages");
  const open = new Set($$("#packages details.pkg__wrap[open]").map(d => d.closest(".pkg").id));
  /* The list is rebuilt from scratch on every change, so anything the reader
     had opened inside a line has to be carried across by hand. Without this,
     nudging a slider in the day planner shuts the spec he was reading.
     Keyed by line and by the disclosure's own class, so a tier switch that
     genuinely replaces one strip with another does not restore the wrong one. */
  const discKey = d => d.closest(".item").dataset.itemId + "|" + d.className;
  const openDiscs = new Set($$("#packages .item details[open]").map(discKey));
  const hadState = pkgHost.children.length > 0;
  pkgHost.innerHTML = "";
  CATALOG.packages.forEach(p => {
    const n = packageNode(p);
    if (hadState) $(".pkg__wrap", n).open = open.has(n.id);
    pkgHost.append(n);
  });
  if (hadState) $$("#packages .item details").forEach(d => { if (openDiscs.has(discKey(d))) d.open = true; });

  renderPlanner();
  renderSteps();
  renderFlags();
  renderTotals();
  renderVerdict();

  $("#optToggle").setAttribute("aria-pressed", String(state.optional));
  $("#optToggle").textContent = state.optional ? "Drop the optional 360 block" : "Add the optional 360 block";
  writeHash();
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
async function boot() {
  const inline = $("#catalog-data");
  CATALOG = inline ? JSON.parse(inline.textContent) : await (await fetch("./data/catalog.json")).json();

  state.scenario = state.scenario || CATALOG.designTargets.defaultScenario;
  readHash();

  /* Header and hero copy from the catalog, never hardcoded */
  const m = CATALOG.meta;
  $("#heroTitle").textContent = m.client.company;
  $("#heroSub").textContent =
    `An audit of what you own, what is missing, and what to buy. Prepared by ${m.consultant.name}, ${m.consultant.company}. Everything here is ordered from ${m.vendor.name}.`;
  $("#heroMeta").innerHTML = [
    `Prepared for ${esc(m.client.contacts.map(c => c.name).join(" and "))}`,
    `Issued ${esc(m.issued)}`,
    esc(m.docId),
  ].join(" &middot; ");
  $("#b2bNote").textContent = (m.vendor.notes || []).slice(-1)[0] || "";

  $("#optToggle").addEventListener("click", () => { state.optional = !state.optional; render(); });
  $("#resetBtn").addEventListener("click", () => {
    state.overrides = {}; state.dropped.clear(); state.choices = {};
    state.optional = false; state.tier = "high";
    state.segs = null; state.poweredH = null;
    state.scenario = CATALOG.designTargets.defaultScenario;
    render();
  });
  $("#copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(skuBlock());
      $("#copyBtn").textContent = "Copied";
      setTimeout(() => ($("#copyBtn").textContent = "Copy item numbers"), 1800);
    } catch {
      $("#skus").closest("details").open = true;
      $("#skus").scrollIntoView({ block: "center" });
      getSelection().selectAllChildren($("#skus"));
    }
  });

  render();
  watchRunway();
}

boot();
