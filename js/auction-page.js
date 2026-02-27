// js/auction-page.js
// Auction Board UI (targets + tier summary) + CSV-backed autocomplete/autofill
// + Strategy Weights (used when CSV includes category component columns)

import {
  getAuctionTargets,
  addAuctionTarget,
  updateAuctionTarget,
  removeAuctionTarget,
  clearAuctionTargets,
  getSettings,
  setSettings,
  DEFAULT_WEIGHTS
} from "./storage.js";

import { loadAuctionPlayers, computeTargetPricing, detectCatStats as detectCatStatsCsv } from "./auction-data.js";

console.log("[auction-page] LOADED v2 weights-test");

/* -------------------------- Delta Legend (static) -------------------------- */

function renderDeltaLegendKey() {
  const el = document.getElementById("deltaLegend");
  if (!el) return;

  const buckets = [
    { cls: "delta-pp", label: "Big +", hint: "≥ +8" },
    { cls: "delta-p",  label: "+",     hint: "+3 to +7.9" },
    { cls: "delta-0",  label: "Even",  hint: "-2.9 to +2.9" },
    { cls: "delta-n",  label: "–",     hint: "-3 to -7.9" },
    { cls: "delta-nn", label: "Big –", hint: "≤ -8" },
  ];

  el.innerHTML = `
    <div class="legendRow">
      ${buckets.map(b => `
        <span class="chip ${b.cls}" title="${b.hint}">
          ${b.label}<span class="chipSub">${b.hint}</span>
        </span>
      `).join("")}
    </div>
  `;

  // Useful signal that it actually ran
  console.log("[auction-page] deltaLegend rendered:", el.querySelectorAll(".chip").length);
}


function deltaClass(d) {
  const x = Number(d);
  if (!Number.isFinite(x)) return "delta-0";
  if (x >= 8) return "delta-pp";
  if (x >= 3) return "delta-p";
  if (x <= -8) return "delta-nn";
  if (x <= -3) return "delta-n";
  return "delta-0";
}

function deltaWhy(pricing) {
  const md = pricing.marketDelta ?? 0;
  const sd = pricing.strategyDelta ?? 0;
  const a = (md >= 0 ? `Market +${md.toFixed(1)}` : `Market ${md.toFixed(1)}`);
  const b = (sd >= 0 ? `Strat +${sd.toFixed(1)}` : `Strat ${sd.toFixed(1)}`);
  return `${a} | ${b}`;
}


// Debug hook (optional)
window.__renderDeltaLegendKey = renderDeltaLegendKey;

/* ----------------------------- chip helpers ------------------------------ */

function score25Tier(score) {
  if (score >= 4.5) return "elite";
  if (score >= 3.5) return "strong";
  if (score >= 2.5) return "viable";
  if (score >= 1.5) return "risk";
  return "avoid";
}

function deltaTier(delta) {
  if (delta >= 0.6) return "up-strong";
  if (delta >= 0.3) return "up";
  if (delta <= -0.6) return "down-strong";
  if (delta <= -0.3) return "down";
  return "flat";
}

// -------------------------
// Strategy Weights UI
// NOTE: weights only affect Val26 if the auction CSV includes per-category numeric columns
// (either raw category components or normalized contributions).
// -------------------------
const ALL_CATS = ["OPS","TB","HR","RBI","R","AVG","SBN","IP","QS","K","HLD","SV","ERA","WHIP"];
const HIT_CATS = ["OPS","TB","HR","RBI","R","AVG","SBN"];
const PIT_CATS = ["IP","QS","K","HLD","SV","ERA","WHIP"];
let HAS_CAT_STATS = false;

/* ----------------------------- small utilities ---------------------------- */

function norm(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase();
}

function normLoose(s) {
  return norm(s)
    .replace(/\s+/g, " ")
    .replace(/[.'’]/g, "")
    .trim();
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function money(n) {
  return `$${Math.max(0, Math.round(num(n)))}`;
}

function typeLabel(t) {
  return norm(t) === "pit" ? "pit" : "hit";
}

function approxEqual(a, b, eps = 1e-9) {
  return Math.abs(num(a) - num(b)) <= eps;
}

/* ---------------------- weights helpers + weighted value ------------------ */

function getWeightsSafe() {
  const s = getSettings();
  const w = s.category_weights || {};
  return { ...DEFAULT_WEIGHTS, ...w };
}

function weightsAreNeutral(weights) {
  const w = weights || {};
  for (const k of ALL_CATS) {
    if (!approxEqual(w[k] ?? DEFAULT_WEIGHTS[k] ?? 0, DEFAULT_WEIGHTS[k] ?? 0)) return false;
  }
  return true;
}

function getCatStat(p, cat) {
  if (!p) return null;

  // Common key possibilities
  const k1 = cat;                       // OPS
  const k2 = cat.toLowerCase();         // ops
  const k3 = cat.toUpperCase();         // OPS
  const k4 = `${cat}_26`;               // OPS_26
  const k5 = `${cat.toLowerCase()}_26`; // ops_26

  const candidates = [k1, k2, k3, k4, k5];

  for (const k of candidates) {
    if (p[k] != null && p[k] !== "" && Number.isFinite(Number(p[k]))) return Number(p[k]);
  }
  return null;
}

// Strict: only returns true if the CSV actually contains category stat columns
function detectCatStats(samplePlayer) {
  if (!samplePlayer) return false;
  let found = 0;

  // Require at least 2 cats to reduce false positives
  for (const cat of ALL_CATS) {
    const v = getCatStat(samplePlayer, cat);
    if (v != null) found++;
    if (found >= 2) return true;
  }
  return false;
}

/**
 * Compute a "weighted Val26" using per-category columns if present.
 * IMPORTANT: This assumes those category columns are already comparable components
 * (e.g., normalized scores / z-ish contributions), NOT raw stats.
 *
 * If you only have a single auction_value_26 (no per-cat columns), weights cannot
 * change value — we return the base value unchanged.
 */
function getWeightedVal26(p, weights) {
  const baseVal = num(p?.auction_value_26);
  if (!p || !HAS_CAT_STATS) return baseVal;

  const w = weights || DEFAULT_WEIGHTS;
  const cats = typeLabel(p.type) === "pit" ? PIT_CATS : HIT_CATS;

  let baseScore = 0;
  let weightedScore = 0;
  let any = false;

  for (const cat of cats) {
    const v = getCatStat(p, cat);
    if (v == null) continue;
    any = true;

    const ww = num(w[cat] ?? DEFAULT_WEIGHTS[cat] ?? 0);

    baseScore += v;          // implicit weight=1
    weightedScore += v * ww; // weight applied
  }

  if (!any || baseScore === 0) return baseVal;

  // Scale base dollars by ratio of weighted to base score
  const scaled = baseVal * (weightedScore / baseScore);
  return Number.isFinite(scaled) ? Math.max(0, scaled) : baseVal;
}

/* --------------------------- weights panel render -------------------------- */

function renderWeightsPanel(onChange) {
  const box = document.getElementById("catWeights");
  if (!box) return;

  const weights = getWeightsSafe();
  box.innerHTML = "";

  for (const cat of ALL_CATS) {
    const lab = document.createElement("div");
    lab.className = "small";
    lab.textContent = cat;

    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.1";
    inp.min = "0";
    inp.value = (weights[cat] ?? 0).toFixed(1);
    inp.dataset.cat = cat;
    inp.style.width = "90px";

    box.appendChild(lab);
    box.appendChild(inp);
  }

  const btnSave = document.getElementById("btnWeightsSave");
  const btnReset = document.getElementById("btnWeightsReset");

  // Prevent double-binding if renderWeightsPanel is called multiple times
  if (btnSave) btnSave.replaceWith(btnSave.cloneNode(true));
  if (btnReset) btnReset.replaceWith(btnReset.cloneNode(true));

  const btnSave2 = document.getElementById("btnWeightsSave");
  const btnReset2 = document.getElementById("btnWeightsReset");

  btnSave2?.addEventListener("click", () => {
    const next = {};
    box.querySelectorAll("input[data-cat]").forEach((el) => {
      const cat = el.dataset.cat;
      const val = Number(el.value);
      next[cat] = Number.isFinite(val) ? val : 0;
    });

    const s = getSettings();
    setSettings({ ...s, category_weights: { ...DEFAULT_WEIGHTS, ...next } });
    onChange?.();
  });

  btnReset2?.addEventListener("click", () => {
    const s = getSettings();
    setSettings({ ...s, category_weights: { ...DEFAULT_WEIGHTS } });
    renderWeightsPanel(onChange);
    onChange?.();

  const btnPresetBalanced = document.getElementById("btnWeightsPresetBalanced");
  const btnPresetHaG = document.getElementById("btnWeightsPresetHaG");

  if (btnPresetBalanced) btnPresetBalanced.replaceWith(btnPresetBalanced.cloneNode(true));
  if (btnPresetHaG) btnPresetHaG.replaceWith(btnPresetHaG.cloneNode(true));

  const btnPresetBalanced2 = document.getElementById("btnWeightsPresetBalanced");
  const btnPresetHaG2 = document.getElementById("btnWeightsPresetHaG");

  btnPresetBalanced2?.addEventListener("click", () => {
    const next = {};
    ALL_CATS.forEach((c) => (next[c] = 1.0));
    const s = getSettings();
    setSettings({ ...s, category_weights: { ...DEFAULT_WEIGHTS, ...next } });
    renderWeightsPanel(onChange);
    onChange?.();
  });

  btnPresetHaG2?.addEventListener("click", () => {
    const next = {
      // Hit
      AVG: 0.0, OPS: 1.3, TB: 1.2, HR: 1.2, RBI: 1.1, R: 1.1, SBN: 0.0,
      // Pit
      ERA: 0.0, WHIP: 0.0, IP: 1.3, QS: 1.2, K: 1.2, SV: 0.0, HLD: 1.3
    };
    const s = getSettings();
    setSettings({ ...s, category_weights: { ...DEFAULT_WEIGHTS, ...next } });
    renderWeightsPanel(onChange);
    onChange?.();
  });

  });
}

/* --------------------------- CSV pool + index ----------------------------- */

let AUCTION_PLAYERS = [];
let AUCTION_BY_NAME = new Map();
let AUCTION_BY_NAME_LOOSE = new Map();

function buildPlayerIndex(players) {
  AUCTION_BY_NAME = new Map();
  AUCTION_BY_NAME_LOOSE = new Map();

  for (const p of players) {
    const name = String(p?.Name ?? p?.player ?? p?.name ?? "").trim();
    if (!name) continue;

    const strictKey = norm(name);
    const looseKey = normLoose(name);

    if (!AUCTION_BY_NAME.has(strictKey)) AUCTION_BY_NAME.set(strictKey, p);
    if (!AUCTION_BY_NAME_LOOSE.has(looseKey)) AUCTION_BY_NAME_LOOSE.set(looseKey, p);
  }
}

function ensureNameDatalist(players) {
  const id = "playerNameList";
  let dl = document.getElementById(id);
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = id;
    document.body.appendChild(dl);
  }

  // cap for Safari performance
  const capped = players.slice(0, 2500);
  dl.innerHTML = capped
    .map((p) => {
      const n = String(p?.Name ?? p?.player ?? p?.name ?? "").trim();
      if (!n) return "";
      const safe = n.replace(/"/g, "&quot;");
      return `<option value="${safe}"></option>`;
    })
    .join("");
}

async function initAuctionPool() {
  try {
    AUCTION_PLAYERS = await loadAuctionPlayers();
    buildPlayerIndex(AUCTION_PLAYERS);
    ensureNameDatalist(AUCTION_PLAYERS);

    // Better detection: scan first N players to avoid a weird first-row miss
    HAS_CAT_STATS = false;
    const scanN = Math.min(50, AUCTION_PLAYERS.length);
    for (let i = 0; i < scanN; i++) {
      if (detectCatStatsCsv(AUCTION_PLAYERS[i])) {
        HAS_CAT_STATS = true;
        break;
      }
    }
  } catch (e) {
    console.error("[AUCTION] Failed to load auction CSV:", e);
    AUCTION_PLAYERS = [];
    AUCTION_BY_NAME = new Map();
    AUCTION_BY_NAME_LOOSE = new Map();
    HAS_CAT_STATS = false;
  }
}

function tierFromCsv(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  if (x <= 1.5) return "A";
  if (x <= 3.5) return "B";
  return "C";
}

function lookupPlayerByName(name) {
  const strict = norm(name);
  if (strict && AUCTION_BY_NAME.has(strict)) return AUCTION_BY_NAME.get(strict);

  const loose = normLoose(name);
  if (loose && AUCTION_BY_NAME_LOOSE.has(loose)) return AUCTION_BY_NAME_LOOSE.get(loose);

  // "Last, First" -> "First Last"
  const raw = String(name ?? "").trim();
  if (raw.includes(",")) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const flipped = `${parts.slice(1).join(" ")} ${parts[0]}`;

      const flippedStrict = norm(flipped);
      if (AUCTION_BY_NAME.has(flippedStrict)) return AUCTION_BY_NAME.get(flippedStrict);

      const flippedLoose = normLoose(flipped);
      if (AUCTION_BY_NAME_LOOSE.has(flippedLoose)) return AUCTION_BY_NAME_LOOSE.get(flippedLoose);
    }
  }

  return null;
}

/**
 * Auto-fill from your CSV columns:
 * - type
 * - auction_value_26 => plan
 * - auction_value_26_shadow => max
 * - tier (numeric -> A/B/C)
 * - draftable, flags -> notes
 */
function applyCsvAutofill(targetId, typedName) {
  const p = lookupPlayerByName(typedName);
  if (!p) return;

  const current = getAuctionTargets().find((t) => t.id === targetId) ?? {};
  const curPlan = num(current.plan);
  const curMax = num(current.max);

  const csvType = norm(p.type);
  const uiTier = tierFromCsv(p.tier);

  const v = num(p.auction_value_26);
  const s = num(p.auction_value_26_shadow);

  const patch = {};

  // Autofill pos from CSV display_role for pitchers (only if user hasn't set pos)
  const dispRole = String(p.display_role ?? p.role_25 ?? "").trim();
  if (!current.pos && dispRole) patch.pos = dispRole;

  if (csvType) patch.type = csvType;
  if (uiTier) patch.tier = uiTier;

  // Only fill plan/max if user hasn't already set them
  if (!curPlan && v) patch.plan = v;
  if (!curMax && (s || v)) patch.max = s || v;

  // Notes: show value/shadow + draftable + flags (no duplication)
  const bits = [];
  if (v > 0) bits.push(`Val ${money(v)}`);
  if (s > 0) bits.push(`Shad ${money(s)}`);

  const draftable = String(p.draftable ?? "").trim();
  if (draftable) bits.push(`Draftable ${draftable}`);

  const flags = String(p.flags ?? "").trim();
  if (flags) bits.push(`Flags: ${flags}`);

  if (bits.length) {
    const existing = String(current.notes ?? "").trim();
    const extra = bits.join(" • ");

    if (!existing) {
      patch.notes = extra;
    } else if (!existing.includes(extra)) {
      patch.notes = `${existing} | ${extra}`;
    }
  }

  updateAuctionTarget(targetId, patch);
}

/* -------------------- Model chips (works with your CSV today) -------------- */

function getModelChips(p) {
  if (!p) return [];

  const out = [];
  const push = (text, html = text) => out.push({ text, html });

  // Score25 + Delta are "always-present" model intelligence chips
  const s25 = num(p.score_25);
  const s24 = num(p.score_24);

  // --- Score25 (colored, labeled) ---
  if (s25 !== 0) {
    const tier = score25Tier(s25);
    push(
      `Score25 ${s25.toFixed(1)}`,
      `Score25 <span class="score-chip ${tier}">${s25.toFixed(1)}</span>`
    );

    // --- Δ25–24 (ALWAYS render so it never looks broken) ---
    if (s24 !== 0) {
      const delta = Number((s25 - s24).toFixed(1));
      const dt = deltaTier(delta);
      const sign = delta > 0 ? "+" : "";
      push(
        `Δ25–24: ${sign}${delta.toFixed(1)}`,
        `Δ25–24: <span class="delta-chip ${dt}">${sign}${delta.toFixed(1)}</span>`
      );
    } else {
      push(`Δ25–24: —`, `Δ25–24: <span class="delta-chip flat">—</span>`);
    }
  }

  // --- Val26 (weighted if possible) ---
  const weights = getWeightsSafe();
  const baseVal = num(p.auction_value_26);
  const wVal = getWeightedVal26(p, weights);

  if (baseVal > 0) {
    if (HAS_CAT_STATS && !weightsAreNeutral(weights) && Math.round(wVal) !== Math.round(baseVal)) {
      push(`Val26 ${money(wVal)}`, `Val26 <span style="opacity:.95">${money(wVal)}</span>`);
      push(`Base ${money(baseVal)}`, `Base <span style="opacity:.85">${money(baseVal)}</span>`);
    } else {
      push(`Val26 ${money(baseVal)}`);
      if (!HAS_CAT_STATS && !weightsAreNeutral(weights)) {
        push(`Wts N/A`, `Wts <span class="delta-chip flat">N/A</span>`);
      }
    }
  }

  const draftable = String(p.draftable ?? "").trim();
  if (draftable) push(`Draftable ${draftable}`);

  const flags = String(p.flags ?? "").trim();
  if (flags) push(`Flags: ${flags}`);

  return out;
}

/* ---------------------------- sorting + filters --------------------------- */

function sortTargets(list, sortKey) {
  const tierRank = (t) => (t === "A" ? 0 : t === "B" ? 1 : 2);
  const arr = [...list];

  switch (sortKey) {
    case "plan_desc":
      arr.sort(
        (a, b) =>
          num(b.plan) - num(a.plan) ||
          tierRank(a.tier) - tierRank(b.tier) ||
          norm(a.name).localeCompare(norm(b.name))
      );
      break;

    case "max_desc":
      arr.sort(
        (a, b) =>
          num(b.max) - num(a.max) ||
          tierRank(a.tier) - tierRank(b.tier) ||
          norm(a.name).localeCompare(norm(b.name))
      );
      break;

    case "name_asc":
      arr.sort(
        (a, b) =>
          norm(a.name).localeCompare(norm(b.name)) ||
          tierRank(a.tier) - tierRank(b.tier)
      );
      break;

    case "tier_plan_name":
    default:
      arr.sort(
        (a, b) =>
          tierRank(a.tier) - tierRank(b.tier) ||
          num(b.plan) - num(a.plan) ||
          norm(a.name).localeCompare(norm(b.name))
      );
      break;
  }

  return arr;
}

function applyFilters(list) {
  const fType = document.getElementById("fType")?.value ?? "all";
  const fTier = document.getElementById("fTier")?.value ?? "all";
  const fSort = document.getElementById("fSort")?.value ?? "tier_plan_name";

  let out = [...list];

  if (fType !== "all") out = out.filter((t) => typeLabel(t.type) === fType);
  if (fTier !== "all") out = out.filter((t) => (t.tier ?? "B") === fTier);

  return sortTargets(out, fSort);
}

/* ------------------------------ tier summary ------------------------------ */

function renderTierSummary(allTargets) {
  const el = document.getElementById("tierSummary");
  if (!el) return;

  const tiers = ["A", "B", "C"];
  const byTier = {};
  for (const t of tiers) byTier[t] = { count: 0, hit: 0, pit: 0, plan: 0, max: 0, adj: 0 };

  for (const t of allTargets) {
    const tier = t.tier ?? "B";
    if (!byTier[tier]) continue;

    byTier[tier].count += 1;

    const typ = typeLabel(t.type);
    if (typ === "hit") byTier[tier].hit += 1;
    else byTier[tier].pit += 1;

    const plan = num(t.plan);
    const maxv = num(t.max);

    // Adj $ is based on Base Val + Δ (market + strategy), capped by hard max.
    const weights = getWeightsSafe();
    const p = lookupPlayerByName(t.name ?? "");
    const pricing = computeTargetPricing(t, p, weights, { hasCatStats: HAS_CAT_STATS });
    const adjv = Number.isFinite(pricing.adjPrice) ? pricing.adjPrice : 0;

    if (plan > 0) byTier[tier].plan += plan;
    if (maxv > 0) byTier[tier].max += maxv;

    if (adjv > 0) byTier[tier].adj += adjv;
  }

  const total = { count: 0, hit: 0, pit: 0, plan: 0, max: 0, adj: 0 };
  for (const k of tiers) {
    total.count += byTier[k].count;
    total.hit += byTier[k].hit;
    total.pit += byTier[k].pit;
    total.plan += byTier[k].plan;
    total.max += byTier[k].max;
    total.adj += byTier[k].adj;
  }

  const row = (label, o, isLast = false) => `
    <div style="
      display:flex;
      justify-content:space-between;
      gap:12px;
      padding:6px 0;
      ${isLast ? "" : "border-bottom:1px solid rgba(255,255,255,0.10);"}
    ">
      <div style="min-width:50px;"><strong>${label}</strong></div>
      <div style="flex:1; text-align:right; opacity:.9;">
        ${o.count} (${o.hit} hit / ${o.pit} pit)
      </div>
      <div style="width:160px; text-align:right;">
        Plan: ${money(o.plan)}
      </div>
      <div style="width:150px; text-align:right;">
        Adj: ${money(o.adj)}
      </div>
      <div style="width:160px; text-align:right;">
        Max: ${money(o.max)}
      </div>
    </div>
  `;

  if (total.count === 0) {
    el.textContent = "Add targets above to see tier counts and planned spend.";
    return;
  }

  el.innerHTML = `
    ${row("A", byTier.A)}
    ${row("B", byTier.B)}
    ${row("C", byTier.C)}
    <div style="display:flex; justify-content:space-between; gap:12px; padding:8px 0; margin-top:6px;">
      <div style="min-width:50px;"><strong>Total</strong></div>
      <div style="flex:1; text-align:right; opacity:.9;">
        ${total.count} (${total.hit} / ${total.pit})
      </div>
      <div style="width:160px; text-align:right;">
        <strong>Plan: ${money(total.plan)}</strong>
      </div>
      <div style="width:150px; text-align:right;">
        <strong>Adj: ${money(total.adj)}</strong>
      </div>
      <div style="width:160px; text-align:right;">
        <strong>Max: ${money(total.max)}</strong>
      </div>
    </div>
  `;
}

/* -------------------------------- render UI ------------------------------ */

function render() {
  const tbody = document.getElementById("auctionTbody");
  const meta = document.getElementById("auctionMeta");
  if (!tbody) return;

  const all = getAuctionTargets();
  renderTierSummary(all);

  const filtered = applyFilters(all);

  if (meta) {
    const hit = all.filter((t) => typeLabel(t.type) === "hit").length;
    const pit = all.filter((t) => typeLabel(t.type) === "pit").length;
    const planSum = all.reduce((acc, t) => acc + num(t.plan), 0);
    const weightsNow = getWeightsSafe();
    const adjSum = all.reduce((acc,t)=>{
      const p = lookupPlayerByName(t.name ?? "");
      const pr = computeTargetPricing(t, p, weightsNow, { hasCatStats: HAS_CAT_STATS });
      return acc + (Number.isFinite(pr.adjPrice) ? pr.adjPrice : 0);
    },0);
    meta.textContent = `Targets: ${all.length} (hit ${hit} / pit ${pit}) • Planned: ${money(planSum)} • Adj: ${money(adjSum)}`;
  }

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="small" style="padding:12px;">
          No targets match your filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = "";

  for (const t of filtered) {
    const tr = document.createElement("tr");

    // Row-scoped CSV player record for this target (used by Pos + chips, etc.)
    const rowPlayer = lookupPlayerByName(t.name ?? "");

    // 1) Player (with datalist + model chips)
    {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = t.name ?? "";
      input.placeholder = "Player";
      input.style.width = "220px";
      input.setAttribute("list", "playerNameList");

      input.addEventListener("input", () => {
        applyCsvAutofill(t.id, input.value);
      });

      input.addEventListener("change", () => {
        const newName = input.value;
        updateAuctionTarget(t.id, { name: newName });
        applyCsvAutofill(t.id, newName);
        render();
      });

      td.appendChild(input);

      const p = lookupPlayerByName(input.value);
      if (p) window.__HAG_LAST_PLAYER = p;

      // Model chips
      const modelChips = getModelChips(p);
      if (modelChips.length) {
        const chips = document.createElement("div");
        chips.style.marginTop = "4px";
        chips.style.display = "flex";
        chips.style.gap = "6px";
        chips.style.flexWrap = "wrap";
        chips.style.opacity = "0.95";

        for (const chipData of modelChips.slice(0, 6)) {
          const chip = document.createElement("span");
          chip.className = "chip small";
          chip.style.padding = "2px 6px";
          chip.style.borderRadius = "10px";
          chip.style.border = "1px solid rgba(255,255,255,0.18)";
          chip.style.background = "rgba(255,255,255,0.06)";
          chip.innerHTML = chipData.html;

          if (chipData.html.startsWith("Δ25–24:")) {
            chip.style.background = "rgba(255,255,255,0.045)";
            chip.style.border = "1px solid rgba(255,255,255,0.12)";
          }

          chips.appendChild(chip);
        }

        td.appendChild(chips);
      }

      tr.appendChild(td);
    }

    // 2) Type
    {
      const td = document.createElement("td");
      const sel = document.createElement("select");
      sel.innerHTML = `
        <option value="hit">Hitter</option>
        <option value="pit">Pitcher</option>
      `;
      sel.value = typeLabel(t.type);
      sel.addEventListener("change", () => {
        updateAuctionTarget(t.id, { type: sel.value });
        render();
      });
      td.appendChild(sel);
      tr.appendChild(td);
    }

    // 3) Pos
    {
      const td = document.createElement("td");
      const input = document.createElement("input");

      const suggested =
        (rowPlayer && (rowPlayer.type === "pit" || rowPlayer.type === "Pitcher"))
          ? (rowPlayer.display_role || rowPlayer.role_25 || "")
          : "";

      input.value = (t.pos ?? "") || suggested;
      input.placeholder = suggested || "OF / SP / RP";
      input.style.width = "120px";

      input.addEventListener("change", () => {
        updateAuctionTarget(t.id, { pos: input.value });
        render();
      });

      td.appendChild(input);
      tr.appendChild(td);
    }

    // 4) Tier
    {
      const td = document.createElement("td");
      const sel = document.createElement("select");
      sel.innerHTML = `
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
      `;
      sel.value = t.tier ?? "B";
      sel.addEventListener("change", () => {
        updateAuctionTarget(t.id, { tier: sel.value });
        render();
      });
      td.appendChild(sel);
      tr.appendChild(td);
    }

    // 5) Val / Δ / Adj $ (computed)
    // Uses CSV base value + (market delta vs plan) + small capped strategy bias.
    const weightsNow = getWeightsSafe();
    const pricing = computeTargetPricing(t, rowPlayer, weightsNow, { hasCatStats: HAS_CAT_STATS });
    {
      // Val
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "small";
      td.textContent = money(pricing.baseVal);
      tr.appendChild(td);
    }

    {
      // Δ (total)
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = `small ${deltaClass(pricing.totalDelta)}`;
      td.title = deltaWhy(pricing);
      const x = pricing.totalDelta ?? 0;
      td.textContent = (x >= 0 ? `+${x.toFixed(1)}` : `${x.toFixed(1)}`);
      tr.appendChild(td);
    }

    {
      // Adj $
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "adj-cell";
      td.title = deltaWhy(pricing);
      td.textContent = money(pricing.adjPrice);
      tr.appendChild(td);
    }

    // 5) Plan $
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(num(t.plan));
      input.style.width = "90px";
      input.addEventListener("change", () => {
        updateAuctionTarget(t.id, { plan: num(input.value) });
        render();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    // 6) Hard Max $
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(num(t.max));
      input.style.width = "90px";
      input.addEventListener("change", () => {
        updateAuctionTarget(t.id, { max: num(input.value) });
        render();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    // 7) Enforce Up To $
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(num(t.enforce));
      input.style.width = "110px";
      input.addEventListener("change", () => {
        updateAuctionTarget(t.id, { enforce: num(input.value) });
        render();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    // 8) Notes
    {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = t.notes ?? "";
      input.placeholder = "Notes";
      input.style.width = "260px";
      input.addEventListener("change", () => {
        updateAuctionTarget(t.id, { notes: input.value });
        render();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }

    // 9) Action
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Remove";
      btn.addEventListener("click", () => {
        removeAuctionTarget(t.id);
        render();
      });
      td.appendChild(btn);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

/* ------------------------------ quick add UI ------------------------------ */

function readQuickAdd() {
  const name = document.getElementById("qName")?.value ?? "";
  const type = document.getElementById("qType")?.value ?? "hit";
  const pos = document.getElementById("qPos")?.value ?? "";
  const tier = document.getElementById("qTier")?.value ?? "B";
  const plan = num(document.getElementById("qPlan")?.value);
  const max = num(document.getElementById("qMax")?.value);

  return {
    name: name.trim(),
    type,
    pos: pos.trim(),
    tier,
    plan,
    max,
    enforce: 0,
    notes: ""
  };
}

function clearQuickAdd() {
  const ids = ["qName", "qPos", "qPlan", "qMax"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  document.getElementById("qName")?.focus?.();
}

function syncExistingTargetsFromCsv() {
  const all = getAuctionTargets();
  for (const t of all) {
    const name = String(t.name ?? "").trim();
    if (!name) continue;
    applyCsvAutofill(t.id, name);
  }
}

/* --------------------------------- init ---------------------------------- */

async function init() {
  await initAuctionPool();

  const qNameEl = document.getElementById("qName");
  if (qNameEl) qNameEl.setAttribute("list", "playerNameList");

  render();
  renderDeltaLegendKey();

  renderWeightsPanel(() => {
    render();
  });

  setTimeout(() => {
    syncExistingTargetsFromCsv();
    render();
  }, 0);

  document.getElementById("btnAddTarget")?.addEventListener("click", () => {
    const t = readQuickAdd();
    if (!t.name) return;

    if (!t.max && t.plan) t.max = t.plan;

    const created = addAuctionTarget(t);
    if (created?.id) applyCsvAutofill(created.id, created.name);

    clearQuickAdd();
    render();
  });

  document.getElementById("btnClearTargets")?.addEventListener("click", () => {
    clearAuctionTargets();
    render();
  });

  ["fType", "fTier", "fSort"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", render);
  });

  document.getElementById("qName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.getElementById("btnAddTarget")?.click();
    }
  });
}

init();
