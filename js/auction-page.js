// js/auction-page.js
// Auction Board UI (targets + tier summary) + CSV-backed autocomplete/autofill
// (Strategy Weights removed — stub left to add back later)
import {
  DEFAULT_WEIGHTS,
  getSettings,
  setSettings,
  getCategoryWeights,
  getCategoryWeightsUpdatedAt,
  getRoster,
  getLivePrices,
  setLivePrice,
  getAuctionTargets,
  addAuctionTarget,
  updateAuctionTarget,
  removeAuctionTarget,
  clearAuctionTargets
} from "./storage.js";

import { mountRecommendedTargets } from "./recommended-targets.js";
import { mountAllocationVisualizer } from "./allocation.js";
import { initCompare } from "./compare.js";

import { loadPlayers as loadProjectionPlayers } from "./projections-data.js";

import {
  loadAuctionPlayers,
  computeTargetPricing,
  detectCatStats as detectCatStatsCsv
,
  getBaseVal26,
  getMarketEstimate,
  getBaselineVal
} from "./auction-data.js";

import { normalizeName, getPlayerKey } from "./player-key.js";

console.log("[auction-page] LOADED v4.1 (picker POS + Ohtani collapsed)");

// -------------------------
// Notes cleanup (1.4)
// -------------------------
const NOTE_STRIP_PATTERNS = [
  /^val\s*\$?\d+/i,       // "Val $57"
  /^val26\s*\$?\d+/i,     // "Val26 $57" (just in case)
  /^adj\s*\$?\d+/i,       // "Adj $62"
  /^tier\s*[a-c]/i,       // "Tier A"
  /^role\s*[:\-]/i,       // "Role: SP"
  /^score/i               // "Score25 4.2"
];

function cleanNotes(notes) {
  if (!notes) return "";
  return String(notes)
    .split(/[;,|]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => !NOTE_STRIP_PATTERNS.some(rx => rx.test(line)))
    .join("; ");
}

/* ----------------------------- small utilities ---------------------------- */
function isStrategyActive(weights) {
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const a = Number(weights?.[k]);
    const b = Number(DEFAULT_WEIGHTS[k]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(a - b) >= 0.0001) return true;
  }
  return false;
}

function getValueMode() {
  const s = getSettings();
  const m = String(s?.value_mode ?? "proj").toLowerCase();
  return m === "market" ? "market" : "proj";
}

function rosterBadgeText(rosterEntry) {
  if (!rosterEntry) return "";
  const y = Number(rosterEntry?.contractYear);
  const t = Number(rosterEntry?.contractTotal);
  const hasFrac = Number.isFinite(y) && Number.isFinite(t) && t > 0;
  return hasFrac ? `ROSTERED (${y}/${t})` : "ROSTERED";
}

function formatSaved(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "—";
  }
}

function hydrateStrategyHeaderBadge() {
  const elStatus = document.getElementById("hdrStrategy");
  const elSaved  = document.getElementById("hdrStrategySaved");
  if (!elStatus && !elSaved) return;

  const weights = getCategoryWeights();
  const active = isStrategyActive(weights);

  if (elStatus) {
    elStatus.textContent = `Strategy: ${active ? "Active" : "Neutral"}`;
    elStatus.classList.toggle("strategy-active", active);
    elStatus.classList.toggle("strategy-neutral", !active);
  }

  if (elSaved) {
    const ts = getCategoryWeightsUpdatedAt();
    elSaved.textContent = `Saved: ${formatSaved(ts)}`;
  }
}

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

// Normalize type strings to the app's canonical values.
function normType(t) {
  const x = norm(t);
  return x === "pit" || x === "pitch" || x === "pitcher" ? "pit" : "hit";
}

// Ohtani handling: Auction board treats Ohtani as ONE auction decision.
// - Only one entry in picker
// - POS forced to "DH/SP"
// - Type forced to "hit"
function isOhtani(p) {
  const name = String(p?.Name ?? p?.player ?? p?.name ?? "").trim().toLowerCase();
  return name === "shohei ohtani";
}

function isOhtaniPitchRow(p) {
  return isOhtani(p) && normType(p?.type) === "pit";
}

/* ------------------------------- CSV loader ------------------------------- */

async function loadCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();

  // Simple CSV parser (OK for clean data w/ no quoted commas)
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (cols[i] ?? "").trim()));
    return row;
  });
}

/* --------------------------- 2025 stats (POS) ----------------------------- */

const STATS_CSV_URL = "./data/2025_stats.csv"; // <-- must match /data filename exactly
let statsByName = new Map();
let statsByNameLoose = new Map();

async function loadStats2025() {
  const rows = await loadCSV(STATS_CSV_URL);

  statsByName = new Map();
  statsByNameLoose = new Map();

  for (const r of rows) {
    const name = String(r?.Name ?? r?.name ?? "").trim();
    if (!name) continue;
    statsByName.set(name, r);
    statsByNameLoose.set(normLoose(name), r);
  }

  console.log(`[stats] loaded ${rows.length} rows from ${STATS_CSV_URL}`);
  console.log("[stats] sample:", rows[0]);
}

function lookupStatsByName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;

  // exact
  const exact = statsByName.get(raw);
  if (exact) return exact;

  // loose
  const loose = statsByNameLoose.get(normLoose(raw));
  if (loose) return loose;

  // "Last, First" -> "First Last" fallback
  if (raw.includes(",")) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const flipped = `${parts.slice(1).join(" ")} ${parts[0]}`.trim();
      const ex2 = statsByName.get(flipped);
      if (ex2) return ex2;
      const lo2 = statsByNameLoose.get(normLoose(flipped));
      if (lo2) return lo2;
    }
  }

  return null;
}

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
  const md = Number(pricing.marketDelta ?? 0);
  const sd = Number(pricing.strategyDelta ?? 0);

  const market = (md >= 0 ? `Plan +${md.toFixed(1)}` : `Plan ${md.toFixed(1)}`);
  const strat  = (sd >= 0 ? `Strategy +${sd.toFixed(1)}` : `Strategy ${sd.toFixed(1)}`);

  const stratDollars = (sd >= 0 ? `+$${sd.toFixed(1)}` : `-$${Math.abs(sd).toFixed(1)}`);

  return `Δ = Adj − Value. ${market} | ${strat} (strategy effect ${stratDollars})`;
}

function strategyMark(sd) {
  const x = Number(sd ?? 0);
  if (!Number.isFinite(x) || Math.abs(x) < 0.05) return "↔";
  return x > 0 ? "↗" : "↘";
}

// Debug hook
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

/* ------------------------------ Strategy (ON) ------------------------------ */
// Strategy weights now live on a separate Strategy page. Auction board just reads them.
const STRATEGY_ENABLED = true;

// Fallback helper so the page never hard-crashes if strategy plumbing changes.
function applyStrategyValue(baseValue) {
  return baseValue;
}

function getStrategyWeights() {
  return getCategoryWeights();
}

function strategyOptions() {
  return {
    hasCatStats: STRATEGY_ENABLED && HAS_CAT_STATS,
    valueMode: getValueMode(),
  };
}

// Build comparable 0..1 category components for weighting.
const STRAT_CATS_HIT = ["OPS","TB","HR","RBI","R","AVG","SB"];
const STRAT_CATS_PIT = ["IP","QS","K","HLD","SV","ERA","WHIP"];
const STRAT_LOWER_BETTER = new Set(["ERA","WHIP"]);

function computePercentiles(players, cats, type) {
  const pool = players.filter(p => typeLabel(p.type) === type);
  for (const cat of cats) {
    const vals = [];
    for (const p of pool) {
      const v = Number(p?.[cat]);
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < 25) continue;

    const sorted = [...vals].sort((a,b)=>a-b);
    const n = sorted.length;

    function pctRank(x) {
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= x) lo = mid + 1; else hi = mid;
      }
      const rank = Math.max(0, lo - 1);
      const p = (n <= 1) ? 0.5 : (rank / (n - 1));
      return STRAT_LOWER_BETTER.has(cat) ? (1 - p) : p;
    }

    for (const p of pool) {
      const v = Number(p?.[cat]);
      if (!Number.isFinite(v)) continue;
      p[`${cat}__w`] = Number(pctRank(v).toFixed(4));
    }
  }
}

function buildStrategyComponents(players) {
  computePercentiles(players, STRAT_CATS_HIT, "hit");
  computePercentiles(players, STRAT_CATS_PIT, "pit");
}

/* --------------------------- Auction pool + index ------------------------- */

let AUCTION_PLAYERS = [];
let AUCTION_BY_NAME = new Map();
let AUCTION_BY_NAME_LOOSE = new Map();
let HAS_CAT_STATS = false;

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
    // 1) Load auction-value rows (pricing/tier/flags)
    const auctionOnlyRaw = await loadAuctionPlayers();

    // Normalize auction rows
    const auctionOnly = auctionOnlyRaw.map((row) => {
      const a = { ...row };
      const nm = String(a.player ?? a.Name ?? a.name ?? "").trim();
      a.player = nm;
      a.Name = nm;
      a.name = nm;
      a.type = typeLabel(a.type ?? a.Type ?? "");
      return a;
    });

    // 2) Load projection rows (per-category stats)
    let projOnlyRaw = [];
    try {
      const projRes = await loadProjectionPlayers();
      if (Array.isArray(projRes)) projOnlyRaw = projRes;
      else if (projRes && Array.isArray(projRes.players)) projOnlyRaw = projRes.players;
      else projOnlyRaw = [];
    } catch (e) {
      console.warn("[AUCTION] Could not load projections CSV:", e);
      projOnlyRaw = [];
    }

    const projOnly = projOnlyRaw.map((row) => {
      const p = { ...row };
      const nm = String(p.Name ?? p.name ?? p.player ?? "").trim();
      p.Name = nm;
      p.name = nm;
      p.player = nm;
      p.type = typeLabel(p.type ?? p.Type ?? "");
      return p;
    });

    // 3) Merge by loose name + type; append projection-only players
    const projMap = new Map();
    for (const p of projOnly) {
      if (!p.Name) continue;
      const key = `${normalizeName(p.Name)}|${typeLabel(p.type)}`;
      if (!projMap.has(key)) projMap.set(key, p);
    }

    const merged = [];
    const seen = new Set();
    const idxByKey = new Map();

    const statCols = ["PA","AVG","OPS","TB","HR","RBI","R","SB","ERA","WHIP","IP","QS","K","SV","HLD","POS"];

    for (const a of auctionOnly) {
      if (!a.Name) continue;
      const key = `${normalizeName(a.Name)}|${typeLabel(a.type)}`;
      const p = projMap.get(key);

      if (p) {
        for (const c of statCols) {
          if (p[c] != null && p[c] !== "") a[c] = p[c];
        }
      }

       const existingIdx = idxByKey.get(key);
  if (existingIdx != null) {
    const existing = merged[existingIdx];

    // prefer the row that actually has an auction value
    const ev = num(existing.auction_value_26);
    const nv = num(a.auction_value_26);

    const winner = (nv > ev) ? a : existing;
    const loser  = (nv > ev) ? existing : a;

    // fill any missing fields from the loser into the winner
    for (const c of ["tier","flags","POS","display_role", ...statCols]) {
      if ((winner[c] == null || winner[c] === "") && (loser[c] != null && loser[c] !== "")) {
        winner[c] = loser[c];
      }
    }

    merged[existingIdx] = winner;
    continue;
  }

  idxByKey.set(key, merged.length);
  merged.push(a);
  seen.add(key);
    }

    for (const p of projOnly) {
      if (!p.Name) continue;
      const key = `${normalizeName(p.Name)}|${typeLabel(p.type)}`;
      if (seen.has(key)) continue;

      const a = { ...p };
      a.Name = p.Name;
      a.name = p.Name;
      a.player = p.Name;
      a.type = typeLabel(p.type);

      if (a.auction_value_26 == null || a.auction_value_26 === "") a.auction_value_26 = 0;
      if (a.tier == null) a.tier = "";
      if (a.flags == null) a.flags = "";


      merged.push(a);
    }

    buildStrategyComponents(merged);

    AUCTION_PLAYERS = merged;
    buildPlayerIndex(AUCTION_PLAYERS);
    ensureNameDatalist(AUCTION_PLAYERS);

    HAS_CAT_STATS = false;
    const scanN = Math.min(150, AUCTION_PLAYERS.length);
    for (let i = 0; i < scanN; i++) {
      if (detectCatStatsCsv(AUCTION_PLAYERS[i])) {
        HAS_CAT_STATS = true;
        break;
      }
    }

    console.log(
      `[AUCTION] loaded ${AUCTION_PLAYERS.length} players (auction=${auctionOnly.length}, proj=${projOnly.length}). HAS_CAT_STATS=${HAS_CAT_STATS}`
    );
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

  const raw = String(name ?? "").trim();
  if (raw.includes(",")) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const flipped = `${parts.slice(1).join(" ")} ${parts[0]}`.trim();

      const flippedStrict = norm(flipped);
      if (AUCTION_BY_NAME.has(flippedStrict)) return AUCTION_BY_NAME.get(flippedStrict);

      const flippedLoose = normLoose(flipped);
      if (AUCTION_BY_NAME_LOOSE.has(flippedLoose)) return AUCTION_BY_NAME_LOOSE.get(flippedLoose);
    }
  }

  return null;
}
function getAnchorVal(p) {
  return num(p?.auction_value_26);
}

// "Shadow" pricing: a secondary reference price (usually 2025 actual/imputed)
// used to auto-fill Hard Max and show context on targets.
function getShadowVal(p) {
  // Prefer explicit imputed column; fallback to actual 2025 auction price.
  const imp = num(p?.auction_price_25_imputed, null);
  if (imp != null) return Math.max(0, imp);
  const a25 = num(p?.auction_price_25, 0);
  return Math.max(0, a25);
}


function posLabel(p) {
  const pos = String(p.POS ?? p.Pos ?? p.pos ?? "").trim();
  return pos ? pos.toUpperCase() : "—";
}

function typeShort(p) {
  const t = String(p.type ?? p.Type ?? "").trim().toLowerCase();
  if (t === "hit" || t === "hitter") return "H";
  if (t === "pit" || t === "pitch" || t === "pitcher") return "P";
  return "";
}

// Decide if we need (H)/(P) disambiguation in the dropdown
function buildNameCounts(players) {
  const counts = new Map();
  for (const p of players) {
    const name = String(p.Name ?? p.name ?? p.player ?? "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function formatSearchLabel(p, nameCounts) {
  const name = String(p.Name ?? p.name ?? p.player ?? "").trim();
  const pos = posLabel(p);
  const needsType = (nameCounts?.get(name) || 0) > 1;
  const suffix = needsType ? ` (${typeShort(p)})` : "";
  return `${name} — ${pos}${suffix}`;
}

/* ---------------------- CSV -> target autofill helpers -------------------- */

function applyCsvAutofill(targetId, typedName) {
  const p = lookupPlayerByName(typedName);
  if (!p) return;

  const current = getAuctionTargets().find((t) => t.id === targetId) ?? {};
  const curPlan = num(current.plan);
  const curMax = num(current.max);

  const csvType = norm(p.type);
  const uiTier = tierFromCsv(p.tier);

  // Primary value used across the Auction Board:
  // - auction_value_26 if present
  // - otherwise fallback to auction_price_25_imputed (when available)
  const mode = getValueMode();
  const vProj = getBaseVal26(p);
  const vMkt = getMarketEstimate(p);
  const v = getBaselineVal(p, mode);
  const s = getShadowVal(p);
  const m = vMkt;

  const patch = {};

  const statsRow = lookupStatsByName(typedName);
  const statsPOS = String(statsRow?.POS ?? "").trim();
  if (!current.pos && statsPOS) patch.pos = statsPOS;

  const dispRole = String(p.display_role ?? p.role_25 ?? "").trim();
  if (!patch.pos && !current.pos && dispRole) patch.pos = dispRole;

  if (isOhtani(p)) {
    patch.type = "hit";
    patch.pos = "DH/SP";
  } else {
    if (csvType) patch.type = csvType;
  }

  if (uiTier) patch.tier = uiTier;

  if (v > 0 && curPlan === 0) patch.plan = v;
  if (!curMax && (s || v)) patch.max = s || v;

  // Persist stable key + pricing fields for the Dashboard.
  patch.player_key = String(p?.player_key || getPlayerKey({ type: (patch.type || csvType || current.type || "unk"), Name: typedName }) || "");
  patch.val = Math.round(v || 0);
  patch.shadow = Math.round(s || 0);

  // Compute Adj/Δ using the same logic as the Auction Board.
  try {
    const weights = getStrategyWeights();
    const opts = strategyOptions();
    const planForPricing = Number(patch.plan ?? current.plan ?? v ?? 0);
    const pricing = computeTargetPricing({ plan: planForPricing, max: Number(patch.max ?? current.max ?? 0) }, p, weights, opts);
    const adjRaw = Number(pricing?.adjRaw);
    if (Number.isFinite(adjRaw)) {
      patch.adj = Math.round(adjRaw);
      patch.delta = Math.round(adjRaw - (v || 0));
    }
  } catch {
    // no-op; Dashboard will show — if not available
  }

  const bits = [];
  if (vProj > 0) bits.push(`Proj ${money(vProj)}`);
  if (vMkt != null && Number(vMkt) > 0) bits.push(`Mkt ${money(vMkt)}`);
  if (v > 0) bits.push(`Val ${money(v)}`);
  if (s > 0) bits.push(`Shad ${money(s)}`);

  const draftable = String(p.draftable ?? "").trim();
  if (draftable) bits.push(`Draftable ${draftable}`);

  const flags = String(p.flags ?? "").trim();
  if (flags) bits.push(`Flags: ${flags}`);

  if (bits.length) {
    const existing = String(current.notes ?? "").trim();
    const extra = bits.join(" • ");
    if (!existing) patch.notes = extra;
    else if (!existing.includes(extra)) patch.notes = `${existing} | ${extra}`;
  }

  updateAuctionTarget(targetId, patch);
}

/* -------------------- Model chips (strategy removed) ---------------------- */

function getModelChips(p) {
  if (!p) return [];

  const out = [];
  const push = (text, html = text) => out.push({ text, html });

  const s25 = num(p.score_25);
  const s24 = num(p.score_24);

  if (s25 !== 0) {
    const tier = score25Tier(s25);
    push(
      `Score25 ${s25.toFixed(1)}`,
      `Score25 <span class="score-chip ${tier}">${s25.toFixed(1)}</span>`
    );

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

  const mode = getValueMode();
  const baseVal = getBaselineVal(p, mode);
  const projVal = getBaseVal26(p);
  const mktVal = getMarketEstimate(p);
  const shadVal = getShadowVal(p);
  if (baseVal > 0) {
  const shown = applyStrategyValue(baseVal);
  push(`${money(shown)}`);
}
  if (mktVal != null && Number(mktVal) > 0) push(`Mkt ${money(mktVal)}`);
  if (shadVal > 0) push(`Shad ${money(shadVal)}`);

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
      // FIXED: was num(b.max) - num(b.max)
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

    const p = lookupPlayerByName(t.name ?? "");
    const weights = getStrategyWeights();
    const pricing = computeTargetPricing(t, p, weights, strategyOptions());

    const adjv = Number.isFinite(pricing.adjRaw) ? pricing.adjRaw : 0;

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

  // Always refresh auxiliary panels (they should not depend on having any targets).
  // If we return early below (e.g., zero targets), these would otherwise never render/update.
  try {
    mountRecommendedTargets({
      players: AUCTION_PLAYERS,
      valueMode: getValueMode(),
    });
  } catch (e) {
    console.warn("[rec] failed to render recommended targets", e);
  }

  try {
    mountAllocationVisualizer({});
  } catch (e) {
    console.warn("[alloc] failed to render allocation", e);
  }

  if (meta) {
    const updatedAt = getCategoryWeightsUpdatedAt();
    const stratTag = updatedAt
      ? `Strategy: Active (${new Date(updatedAt).toLocaleString()})`
      : `Strategy: Default`;

    const hit = all.filter((t) => typeLabel(t.type) === "hit").length;
    const pit = all.filter((t) => typeLabel(t.type) === "pit").length;
    const planSum = all.reduce((acc, t) => acc + num(t.plan), 0);

    const weights = getStrategyWeights();
    const opts = strategyOptions();

    const adjSum = all.reduce((acc, t) => {
      const p = lookupPlayerByName(t.name ?? "");
      const pr = computeTargetPricing(t, p, weights, opts);
      return acc + (Number.isFinite(pr.adjRaw) ? pr.adjRaw : 0);
    }, 0);

    meta.textContent = "";
}

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" class="small" style="padding:12px;">
          No targets match your filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = "";

  const weightsNow = getStrategyWeights();
  const opts = strategyOptions();
  const rosterMap = new Map(
    (getRoster() || []).map((r) => [normalizeName(r?.name || ""), r])
  );

  for (const t of filtered) {
    const tr = document.createElement("tr");

    // Row-level polish: plan over max highlight
    const planNum = num(t.plan);
    const maxNum  = num(t.max);
    if (planNum > 0 && maxNum > 0 && planNum >= maxNum) tr.classList.add("planOverMax");

    // Preload records
    const rowPlayer = lookupPlayerByName(t.name ?? "");
    const statsRow = lookupStatsByName(t.name ?? "");

    // 1) Player (with datalist + model chips)
    {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = t.name ?? "";
      input.placeholder = "Player";
      input.style.width = "220px";
      input.style.flex = "0 0 220px";
      input.setAttribute("list", "playerNameList");

      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.alignItems = "center";
      topRow.style.gap = "8px";

      const badge = document.createElement("span");
      badge.className = "hag-badge hag-badge--rostered";

      function syncRosterBadge(name) {
        const key = normalizeName(name || "");
        const entry = rosterMap.get(key);
        if (!entry) {
          badge.style.display = "none";
          badge.textContent = "";
          return;
        }
        badge.style.display = "inline-flex";
        badge.textContent = rosterBadgeText(entry);
      }

      syncRosterBadge(input.value);

      input.addEventListener("input", () => {
        applyCsvAutofill(t.id, input.value);
        syncRosterBadge(input.value);
      });

      input.addEventListener("change", () => {
        const newName = input.value;
        updateAuctionTarget(t.id, { name: newName });
        applyCsvAutofill(t.id, newName);
        syncRosterBadge(newName);
        render();
      });

      topRow.appendChild(input);
      topRow.appendChild(badge);
      td.appendChild(topRow);

      const p = lookupPlayerByName(input.value);
      if (p) window.__HAG_LAST_PLAYER = p;

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

      const statsPOS = String(statsRow?.POS ?? "").trim();
      const pitchPOS =
        (rowPlayer && norm(rowPlayer.type) === "pit")
          ? String(rowPlayer.display_role ?? rowPlayer.role_25 ?? "").trim()
          : "";

      const suggested = (isOhtani(rowPlayer) ? "DH/SP" : (statsPOS || pitchPOS || ""));
      input.value = (t.pos ?? "") || suggested;
      input.placeholder = suggested || "OF / SS / SP / RP";
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
    const pricing = computeTargetPricing(t, rowPlayer, weightsNow, opts);

    // Val (polish: valCell + num)
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "small valCell num";
      const mode = getValueMode();
      const projVal = getBaseVal26(rowPlayer);
      const mktVal = getMarketEstimate(rowPlayer);
      const baseShown = Number(pricing.baseVal ?? 0);
      td.textContent = money(baseShown);
      const modeLabel = mode === "market" ? "Market Estimate" : "Proj Anchor";
      td.title = `${modeLabel}: ${money(baseShown)}${projVal != null ? `\nProj Anchor: ${money(projVal)}` : ""}${mktVal != null ? `\nMarket Estimate: ${money(mktVal)}` : ""}`;
      tr.appendChild(td);
    }

    // Δ (polish: deltaChip)
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "small num";
      td.title = deltaWhy(pricing);

      const x = Number(pricing.totalDelta ?? 0);
      const cls = deltaClass(x);
      td.innerHTML = `<span class="deltaChip ${cls}">${x >= 0 ? `+${x.toFixed(1)}` : `${x.toFixed(1)}`}</span>`;
      tr.appendChild(td);
    }

    // Adj (polish: adjCell + num, keep strategy mark)
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "adj-cell adjCell num";
      td.title = deltaWhy(pricing);

      const mark = strategyMark(pricing.strategyDelta);
      td.innerHTML = `${money(pricing.adjRaw)} <span class="strat-mark">${mark}</span>`;
      tr.appendChild(td);
    }

    // 6) Plan $
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "planCell num";
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

    // 7) Hard Max $
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "hardMaxCell num";
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

    // 8) Enforce Up To $
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

    // 9) Notes
    {
      const td = document.createElement("td");
      const input = document.createElement("input");

      input.value = cleanNotes(t.notes ?? "");
      input.placeholder = "—";
      input.style.width = "260px";

      input.addEventListener("change", () => {
        const cleaned = cleanNotes(input.value);
        input.value = cleaned;
        updateAuctionTarget(t.id, { notes: cleaned });
        render();
      });

      td.appendChild(input);
      tr.appendChild(td);
    }

    // 10) Live $ (optional) — keyed by stable player_key
    {
      const td = document.createElement("td");
      td.style.textAlign = "right";
      td.className = "num";

      const key = String(t?.player_key || "").trim();
      const liveMap = getLivePrices();
      const cur = (key && liveMap && liveMap[key] != null) ? Number(liveMap[key]) : "";

      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = "—";
      input.value = cur === "" ? "" : String(cur);
      input.style.width = "90px";

      input.addEventListener("change", () => {
        setLivePrice(key, input.value);
        render();
      });

      td.appendChild(input);
      tr.appendChild(td);
    }

    // 11) Action
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

/* ------------------------ Recommended Targets Tabs ------------------------ */

function initRecTabs() {
  const btns = Array.from(document.querySelectorAll("[data-rec-tab]"));
  if (!btns.length) return;
  btns.forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.getAttribute("data-rec-tab");
      btns.forEach((x) => x.classList.toggle("active", x === b));

      const needs = document.getElementById("recNeeds");
      const values = document.getElementById("recValues");
      const fits = document.getElementById("recFits");
      if (!needs || !values || !fits) return;

      needs.style.display = tab === "needs" ? "block" : "none";
      values.style.display = tab === "values" ? "block" : "none";
      fits.style.display = tab === "fits" ? "block" : "none";
    });
  });
}

/* --------------------- Recommended Targets Controls --------------------- */

function initRecControls() {
  const cb = document.getElementById("recAffordableOnly");
  const max = document.getElementById("recMaxBid");
  if (!cb && !max) return;

  const onChange = () => {
    // The recommender reads these controls directly.
    render();
  };

  cb?.addEventListener("change", onChange);
  max?.addEventListener("change", onChange);
}

/* ------------------------------ Player Picker ----------------------------- */

let PICK_SELECTED_NAME = "";
let PICK_SELECTED_PLAYER = null;
const PICK_MAX_RESULTS = 14;
const PICK_HARDMAX_BUFFER = 5;

function setPickSelected(player) {
  PICK_SELECTED_PLAYER = player || null;
  PICK_SELECTED_NAME = player ? String(player?.Name ?? player?.player ?? player?.name ?? "").trim() : "";

  const el = document.getElementById("pickSelected");
  if (el) el.textContent = PICK_SELECTED_NAME || "—";

  const wrap = document.getElementById("pickResults");
  if (!wrap) return;
  wrap.querySelectorAll(".pickItem").forEach((btn) => {
    const n = String(btn?.dataset?.name ?? "");
    btn.classList.toggle("isSelected", PICK_SELECTED_NAME && n === PICK_SELECTED_NAME);
  });
}

// --- POS normalizer (handles "OF OF", "OF/OF", AND "OFOF" style duplicates) ---
function normalizePosText(pos) {
  const raw0 = String(pos ?? "").trim().toUpperCase();
  if (!raw0) return "";

  const cleaned = raw0
    .replace(/[\s,;|]+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");

  if (cleaned.includes("/")) {
    const parts = cleaned.split("/").map(s => s.trim()).filter(Boolean);
    const uniq = [];
    for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
    return uniq.join("/");
  }

  const raw = cleaned;

  const TOKENS = ["C","1B","2B","3B","SS","OF","LF","CF","RF","DH","UT","SP","RP","P"];

  for (const t of TOKENS) {
    if (raw.length > t.length && raw.length % t.length === 0) {
      const k = raw.length / t.length;
      if (k >= 2 && t.repeat(k) === raw) return t;
    }
  }

  if (raw.length % 2 === 0) {
    const half = raw.length / 2;
    const a = raw.slice(0, half);
    const b = raw.slice(half);
    if (a === b) return a;
  }

  return raw;
}

function fmtPickSub(player) {
  const v = getBaseVal26(player);
  const tier = String(player?.tier ?? "").trim();

  const bits = [];

  const roleRaw = String(player?.display_role ?? player?.role_25 ?? "").trim();
  const role = normalizePosText(roleRaw);
  if (!isOhtani(player) && role) bits.push(role);

  if (v) bits.push(money(v));
  if (tier) bits.push(`Tier ${tier}`);

  return bits.join(" • ");
}

function pickMatches(q) {
  const query = normalizeName(q);
  if (!query) return [];

  const out = [];
  for (const p of AUCTION_PLAYERS) {
    if (isOhtaniPitchRow(p)) continue;

    const n = String(p?.Name ?? p?.player ?? p?.name ?? "").trim();
    if (!n) continue;

    const key = normalizeName(n);
    const i = key.indexOf(query);
    if (i === -1) continue;

    const score = (i === 0 ? 2 : 1);
    out.push({ p, n, score });
    if (out.length > 6000) break;
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const av = getBaseVal26(a.p);
    const bv = getBaseVal26(b.p);
    if (bv !== av) return bv - av;
    return a.n.localeCompare(b.n);
  });

  return out.slice(0, PICK_MAX_RESULTS).map((x) => x.p);
}

function renderPickResults(q) {
  const wrap = document.getElementById("pickResults");
  if (!wrap) return;

  if (!normLoose(q)) {
    wrap.innerHTML = `<div class="small" style="opacity:.75; padding:6px 2px;">Type to search…</div>`;
    return;
  }

  const matches = pickMatches(q);
  if (!matches.length) {
    wrap.innerHTML = `<div class="small" style="opacity:.75; padding:6px 2px;">No matches.</div>`;
    return;
  }

  wrap.innerHTML = matches
    .map((p) => {
      const name = String(p?.Name ?? p?.player ?? p?.name ?? "").trim();
      const safe = name.replace(/"/g, "&quot;");

      const statsRow = lookupStatsByName(name);
      const statsPOS = normalizePosText(statsRow?.POS);
      const csvPOS   = normalizePosText(p?.POS ?? p?.pos);

      const rawPos = isOhtani(p) ? "DH/SP" : (statsPOS || csvPOS || "—");
      const posMain = normalizePosText(rawPos);

      const sub = fmtPickSub(p).replace(/"/g, "&quot;");

      const team = String(statsRow?.Team ?? p?.Team ?? p?.team ?? "").trim() || "—";
      return `<button type="button" class="pickItem" data-name="${safe}">${safe} • ${team}<span class="sub"> • ${sub}</span></button>`;
    })
    .join("");

  wrap.querySelectorAll(".pickItem").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = String(btn?.dataset?.name ?? "");
      const p = lookupPlayerByName(name);
      setPickSelected(p);
      const input = document.getElementById("pickQuery");
      if (input) input.value = name;
    });
  });

  setPickSelected(PICK_SELECTED_PLAYER);
}

function buildTargetFromPlayer(p) {
  const name = String(p?.Name ?? p?.player ?? p?.name ?? "").trim();

  let type = normType(p?.type);
  const tier = tierFromCsv(p?.tier) || "B";

  const statsRow = lookupStatsByName(name);
  const statsPOS = String(statsRow?.POS ?? "").trim();
  const rolePOS = String(p?.display_role ?? p?.role_25 ?? "").trim();

  let pos = statsPOS || rolePOS || "";

  if (isOhtani(p)) {
    type = "hit";
    pos = "DH/SP";
  }

  const baseVal = getBaseVal26(p);
  const shadow = getShadowVal(p);


  const weights = getStrategyWeights();
  const opts = strategyOptions();

  const pricing = computeTargetPricing(
    { plan: baseVal, max: (shadow || 0) },
    p,
    weights,
    opts
  );

  const plan = baseVal;

  const hardMax = Math.max(
  Math.round(plan),
  Math.round(plan) + PICK_HARDMAX_BUFFER
);

  const bits = [];
  if (baseVal > 0) bits.push(`${money(baseVal)}`);
  if (shadow > 0) bits.push(`Shad ${money(shadow)}`);
  const flags = String(p?.flags ?? "").trim();
  if (flags) bits.push(`Flags: ${flags}`);

  return {
    player_key: String(p?.player_key || getPlayerKey({ type, Name: name }) || ""),
    name,
    type,
    pos,
    tier,
    plan: Math.round(plan),
    max: Math.round(hardMax),
    enforce: 0,
    notes: bits.join(" • "),
    // Persist pricing so Dashboard doesn't need to recompute
    val: Math.round(baseVal),
    shadow: Math.round(shadow || 0),
    adj: Math.round(pricing?.adjRaw ?? baseVal),
    delta: Math.round((pricing?.adjRaw ?? baseVal) - baseVal)
  };
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
  // Compare panel uses AUCTION_PLAYERS (master projections/auction CSV), not 2025 stats.
  try { initCompare(AUCTION_PLAYERS); } catch (e) { console.warn("[COMPARE] init failed", e); }
  await loadStats2025();

  const pickInput = document.getElementById("pickQuery");
  if (pickInput) {
    pickInput.addEventListener("input", () => {
      setPickSelected(lookupPlayerByName(pickInput.value));
      renderPickResults(pickInput.value);
    });

    pickInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();

      if (!PICK_SELECTED_PLAYER) {
        const matches = pickMatches(pickInput.value);
        if (matches.length) {
          setPickSelected(matches[0]);
          pickInput.value = String(matches[0]?.Name ?? matches[0]?.player ?? matches[0]?.name ?? "").trim();
        }
      }

      document.getElementById("btnPickAdd")?.click();
    });

    renderPickResults("");
  }

  renderColumnKey();
  renderDeltaLegendKey();
  hydrateStrategyHeaderBadge();
  initRecTabs();
  initRecControls();

  // Allow other panels (e.g., Recommended Targets quick-add) to request a rerender.
  window.hagRefreshAuction = render;

  // Value Mode toggle (Proj Anchor vs Market Estimate).
  // This changes the baseline used by the strategy engine, so Value/Adj/Δ all recalc.
  const valueModeSel = document.getElementById("valueMode");
  if (valueModeSel) {
    valueModeSel.value = getValueMode();
    valueModeSel.addEventListener("change", () => {
      setSettings({ value_mode: valueModeSel.value });
      renderColumnKey();
      render();
    });
  }

  function renderColumnKey() {
    const el = document.getElementById("columnKey");
    if (!el) return;

    const mode = getValueMode();
    const valLabel = "Value";
    const valDesc = mode === "market"
      ? "Market Estimate (projection + flags)"
      : "Proj Anchor (pure projection value)";
    const deltaNote = "Δ is always computed as (Adj − Value), using the selected baseline.";

    el.innerHTML = `
      <div class="columnKeyGrid">
        <div class="k">${valLabel}</div><div class="v">${valDesc}</div>
        <div class="k">Δ</div><div class="v">Strategy delta <span style="opacity:.8">(Adj − Value)</span></div>
        <div class="k">Adj</div><div class="v">Strategy-adjusted value</div>
        <div class="k">Plan $</div><div class="v">Intended bid target</div>
        <div class="k">Max $</div><div class="v">Absolute bid ceiling</div>
      </div>
      <div class="columnKeyNote">Adj = Value + Δ • <span style="opacity:.85">${deltaNote}</span></div>
    `;
  }

  syncExistingTargetsFromCsv();
  render();

  document.getElementById("btnPickAdd")?.addEventListener("click", () => {
    const input = document.getElementById("pickQuery");
    const typed = String(input?.value ?? "").trim();
    const p = PICK_SELECTED_PLAYER || lookupPlayerByName(typed);
    if (!p) return;

    const t = buildTargetFromPlayer(p);
    const created = addAuctionTarget(t);
    if (created?.id) applyCsvAutofill(created.id, created.name);

    if (input) input.value = "";
    setPickSelected(null);
    renderPickResults("");
    render();
  });

  document.getElementById("btnClearTargets")?.addEventListener("click", () => {
    clearAuctionTargets();
    render();
  });

  ["fType", "fTier", "fSort"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", render);
  });

  console.log("[auction-page] init complete");
}

init();
