// js/auction-data.js
// Loads auction values CSV with a robust parser (handles quoted commas, etc.)
// Also provides pricing helpers for the Auction Board (Base Val → Δ → Adj $).

import { DEFAULT_WEIGHTS } from "./storage.js";
import { normalizeName, getPlayerKey } from "./player-key.js";

function toNumberMaybe(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return "";

  const cleaned = s.replace(/[$,]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : s;
}

// Minimal CSV parser that handles quoted fields + commas inside quotes
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && c === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && next === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += c;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export async function loadAuctionPlayers() {
  const url = "./data/master.csv";
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(
      `Failed to load auction CSV: ${res.status} ${res.statusText} (${url})`
    );
  }

  const text = await res.text();
  const rows = parseCSV(text.trim());
  if (!rows.length) return [];

  const headers = rows[0].map((h) => String(h ?? "").trim());

  const players = rows.slice(1).map((values) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = toNumberMaybe(values[i]);
    });

    // --- New v3 schema compatibility -------------------------------------
    // The CSV schema was updated to use projection-first anchors:
    //   Proj Anchor       => projection value (base Val)
    //   Market Estimate   => projection + flags (market reference)
    //   Auction 25 Anchor => 2025 guide (imputed)
    //   Actual 25 Draft$  => 2025 actual
    // We keep legacy internal keys so the rest of the app remains stable.
    const proj = obj["Proj Anchor"] ?? obj["ProjAnchor"] ?? obj.proj_anchor;
    if (proj != null && proj !== "") obj.auction_value_26 = proj;

    const mkt = obj["Market Estimate"] ?? obj["MarketEstimate"] ?? obj.market_estimate;
    if (mkt != null && mkt !== "") obj.market_estimate = mkt;

    const a25 = obj["Auction 25 Anchor"] ?? obj["Auction25 Anchor"] ?? obj["Auction25Anchor"];
    if (a25 != null && a25 !== "") obj.auction_price_25_imputed = a25;

    const d25 = obj["Actual 25 Draft$"] ?? obj["Actual25 Draft$"] ?? obj["Actual25Draft$"];
    if (d25 != null && d25 !== "") obj.auction_price_25 = d25;

    const dispRole = obj["Display Role"] ?? obj["DisplayRole"];
    if (dispRole != null && dispRole !== "") obj.display_role = dispRole;

    const flags = obj["Flags"] ?? obj.flags;
    if (flags != null && flags !== "") obj.flags = flags;

    // --- Canonicalize core identity fields ---
    const nm = String(obj.player ?? obj.Player ?? obj.Name ?? obj.name ?? "").trim();
    obj.Name = nm;
    obj.name = nm;
    obj.player = nm;

    // Type normalization
    obj.type = String(obj.type ?? obj.Type ?? "").trim().toLowerCase();

    // POS normalization (supports POS / Pos / pos / Position)
    obj.POS = String(
      obj.POS ?? obj.Pos ?? obj.pos ?? obj.Position ?? obj.position ?? obj["Display Role"] ?? obj["DisplayRole"] ?? ""
    )
      .trim()
      .toUpperCase();
    obj.pos = obj.POS;

    obj.Team = String(obj.Team ?? obj.team ?? obj.Tm ?? obj.tm ?? "").trim();
    obj.team = obj.Team;

    // --- Shadow migration (legacy compatibility) ---
    // Older CSVs had auction_value_26_shadow. If present, promote it into
    // auction_value_26 only when the new/projection value is missing.
    const v26 = String(obj.auction_value_26 ?? "").trim();
    const sh = String(obj.auction_value_26_shadow ?? "").trim();
    if ((v26 === "" || v26 === "0") && sh !== "" && sh !== "0") {
      const n = Number(sh);
      if (Number.isFinite(n) && n > 0) obj.auction_value_26 = n;
    }

    // Force known text columns to be strings (prevents weird coercion)
    [
      "display_role",
      "role_25",
      "role_24",
      "flags",
      "market_estimate",
      "score_bucket",
      "tier",
      "draftable",
    ].forEach((k) => {
      if (obj[k] != null && obj[k] !== "") obj[k] = String(obj[k]).trim();
    });

    // Stable key + loose name normalization for joins
    obj.player_key = getPlayerKey({ type: obj.type, Name: obj.Name });
    obj._normName = normalizeName(obj.Name);

    return obj;
  });

    // --- Dedupe by stable key (prevents Otto López vs Otto Lopez duplicates) ---
  function hasDiacritics(s) {
    return /[\u0300-\u036f]/.test(String(s || "").normalize("NFD"));
  }

  function scoreRow(p) {
    const val = Number(p?.auction_value_26 ?? 0) || 0;
    const shadow =
      Number(p?.auction_price_25_imputed ?? 0) ||
      Number(p?.auction_price_25 ?? 0) ||
      0;

    // Prefer: real Val > shadow > accented display name > draftable true
    const accented = hasDiacritics(p?.Name) ? 1 : 0;
    const draftable = String(p?.draftable ?? "").toUpperCase() === "TRUE" ? 1 : 0;

    return val * 100000 + shadow * 100 + accented * 10 + draftable;
  }

  const byKey = new Map();
  for (const p of players) {
    const key = String(p?.player_key || "").trim();
    if (!key) continue;

    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, p);
    } else {
      byKey.set(key, scoreRow(p) > scoreRow(cur) ? p : cur);
    }
  }

  return Array.from(byKey.values());

}

/* ========================================================================== */
/*                               Pricing helpers                              */
/* ========================================================================== */

// NOTE: Number(null) === 0, which would incorrectly treat a missing CSV cell
// as a real 0. We want blanks/missing to fall back instead.
function num(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normType(t) {
  const s = String(t ?? "").trim().toLowerCase();
  return (s === "pit" || s === "pitcher") ? "pit" : "hit";
}

const ALL_CATS = ["OPS","TB","HR","RBI","R","AVG","SB","IP","QS","K","HLD","SV","ERA","WHIP"];
const HIT_CATS = ["OPS","TB","HR","RBI","R","AVG","SB"];
const PIT_CATS = ["IP","QS","K","HLD","SV","ERA","WHIP"];

/**
 * Returns the numeric value of a category column if present, otherwise null.
 * Supports keys like "OPS", "ops", "OPS_26", "ops_26".
 */
export function getCatStat(player, cat) {
  if (!player) return null;

  // Strategy component key (computed by auction-page.js).
  // This stores comparable 0..1 values so weights behave sensibly even if the
  // underlying CSV has raw stats rather than pre-normalized components.
  const kw1 = `${cat}__w`;
  const kw2 = `${cat.toLowerCase()}__w`;

  const k1 = cat;
  const k2 = cat.toLowerCase();
  const k3 = cat.toUpperCase();
  const k4 = `${cat}_26`;
  const k5 = `${cat.toLowerCase()}_26`;

  const candidates = [kw1, kw2, k1, k2, k3, k4, k5];

  for (const k of candidates) {
    const v = player[k];
    const n = Number(v);
    if (v != null && v !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Source-of-truth columns:
 * - Val (2026): auction_value_26
 * - Shadow (2025 reference): auction_price_25_imputed (fallback auction_price_25)
 */
export function getVal26(player) {
  const v = num(player?.auction_value_26, null);
  return v == null ? null : Math.max(0, v);
}

// New v3 reference value (projection + flags). Does NOT replace Adj.
export function getMarketEstimate(player) {
  const v = num(player?.market_estimate, null);
  return v == null ? null : Math.max(0, v);
}

// Baseline value used by the Auction Board engine.
// - proj: projection anchor (with shadow fallback)
// - market: market estimate (projection + flags). If missing, falls back to proj baseline.
export function getBaselineVal(player, valueMode = "proj") {
  const mode = String(valueMode || "proj").toLowerCase();
  if (mode === "market") {
    const m = getMarketEstimate(player);
    if (m != null && m > 0) return m;
    return getBaseVal26(player);
  }
  return getBaseVal26(player);
}

export function getShadow25(player) {
  const imp = num(player?.auction_price_25_imputed, null);
  if (imp != null) return Math.max(0, imp);
  const a25 = num(player?.auction_price_25, null);
  return a25 == null ? null : Math.max(0, a25);
}

/**
 * Strict: only returns true if the CSV actually contains category stat columns.
 * Requires at least 2 categories to avoid false positives.
 */
export function detectCatStats(samplePlayer) {
  if (!samplePlayer) return false;
  let found = 0;
  for (const cat of ALL_CATS) {
    if (getCatStat(samplePlayer, cat) != null) found++;
    if (found >= 2) return true;
  }
  return false;
}

/**
 * Base value used for pricing. This should always come from the CSV "auction_value_26".
 */
export function getBaseVal26(player) {
  // Pricing base for the app. Source-of-truth is Val (auction_value_26),
  // but when missing we fall back to Shadow (imputed/actual 2025 price) so
  // rookies/prospects still get a sensible default.
  const v = getVal26(player);
  if (v != null) return v;

  const sh = getShadow25(player);
  return sh != null ? sh : 0;
}

/**
 * Compute a weighted value using per-category component columns if present.
 * IMPORTANT: this assumes those per-category columns are already comparable components
 * (normalized contributions), NOT raw stats.
 *
 * If the CSV does not contain per-cat columns, this returns baseVal unchanged.
 */
export function getWeightedVal26(player, weights, hasCatStats, baseValOverride = null) {
  const baseVal = (baseValOverride != null) ? baseValOverride : getBaseVal26(player);
if (!player || !hasCatStats) return baseVal;

  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const cats = normType(player.type) === "pit" ? PIT_CATS : HIT_CATS;

  let baseScore = 0;
  let weightedScore = 0;
  let any = false;

  for (const cat of cats) {
    const v = getCatStat(player, cat);
    if (v == null) continue;
    any = true;

    const ww = num(w[cat], 0);
    baseScore += v;          // implicit weight=1
    weightedScore += v * ww; // weight applied
  }

  if (!any || baseScore === 0) return baseVal;

  const scaled = baseVal * (weightedScore / baseScore);
  return Number.isFinite(scaled) ? Math.max(0, scaled) : baseVal;
}

/**
 * Compute the auction-board pricing breakdown for a target row.
 *
 * Inputs:
 * - target: your saved auction target object (from storage.js)
 * - player: the matching CSV player row (from loadAuctionPlayers)
 * - weights: category weights (DEFAULT_WEIGHTS merged upstream or passed raw)
 * - opts:
 *    - hasCatStats: boolean (detectCatStats(players[0]) result)
 *    - caps: { strategyCap, deltaCap }
 *
 * Output:
 * {
 *   baseVal, weightedVal,
 *   plan,
 *   marketDelta, strategyDelta, totalDelta,
 *   adjRaw
 * }
 */
export function computeTargetPricing(target, player, weights, opts = {}) {
  const hasCatStats = !!opts.hasCatStats;

  const caps = opts.caps || {};
  const strategyCap = num(caps.strategyCap, 6); // max $ strategy can move Δ
  const deltaCap = num(caps.deltaCap, 15);      // max total Δ

  const valueMode = opts.valueMode || "proj";

  // Baseline value (depends on Value Mode)
  const baseValCsv = getBaselineVal(player, valueMode) ?? 0;

  // Strategy-weighted value (only moves if hasCatStats)
  const weightedVal = getWeightedVal26(player, weights, hasCatStats, baseValCsv);

  // User plan
  const plan = num(target?.plan, 0);

  // 🔁 Fallback for projection-only / rookie players:
  // If no auction value exists, anchor pricing to Plan.
  const baseVal = baseValCsv > 0 ? baseValCsv : plan;

  // Market delta (relative to pricing base)
  const marketDelta = baseVal - plan;

  // Strategy delta (relative to pricing base)
  const strategyDeltaRaw = weightedVal - baseVal;
  const strategyDelta = clamp(strategyDeltaRaw, -strategyCap, strategyCap);

  // Total delta (sanity capped)
  const totalDelta = clamp(marketDelta + strategyDelta, -deltaCap, deltaCap);

  // ✅ Final Adj recommendation (uncapped by Hard Max)
  const adjRaw = baseVal + totalDelta;

  return {
    baseVal,
    weightedVal,
    plan,
    marketDelta,
    strategyDelta,
    totalDelta,
    adjRaw
  };
}

// Back-compat re-exports so other modules can import from auction-data.
export { normalizeName, getPlayerKey } from "./player-key.js";
