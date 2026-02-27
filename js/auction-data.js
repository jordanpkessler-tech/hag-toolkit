// js/auction-data.js
// Loads auction values CSV with a robust parser (handles quoted commas, etc.)
// Also provides pricing helpers for the Auction Board (Base Val → Δ → Adj $).

import { DEFAULT_WEIGHTS } from "./storage.js";

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
  const url = "./data/auction_values_2026_all_players_with_shadow.csv";
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

    // Your CSV uses "player" and "type"
    obj.Name = String(obj.player ?? obj.Name ?? obj.name ?? "").trim();
    obj.name = obj.Name;
    obj.player = obj.Name; // keep it consistent
    obj.type = String(obj.type ?? "").trim().toLowerCase();

    // Force known text columns to be strings (prevents weird coercion)
    ["display_role","role_25","role_24","flags","score_bucket","tier","draftable"].forEach((k) => {
      if (obj[k] != null && obj[k] !== "") obj[k] = String(obj[k]).trim();
    });

    return obj;
  });

  return players;
}

/* ========================================================================== */
/*                               Pricing helpers                              */
/* ========================================================================== */

function num(v, fallback = 0) {
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

const ALL_CATS = ["OPS","TB","HR","RBI","R","AVG","SBN","IP","QS","K","HLD","SV","ERA","WHIP"];
const HIT_CATS = ["OPS","TB","HR","RBI","R","AVG","SBN"];
const PIT_CATS = ["IP","QS","K","HLD","SV","ERA","WHIP"];

/**
 * Returns the numeric value of a category column if present, otherwise null.
 * Supports keys like "OPS", "ops", "OPS_26", "ops_26".
 */
export function getCatStat(player, cat) {
  if (!player) return null;

  const k1 = cat;
  const k2 = cat.toLowerCase();
  const k3 = cat.toUpperCase();
  const k4 = `${cat}_26`;
  const k5 = `${cat.toLowerCase()}_26`;

  const candidates = [k1, k2, k3, k4, k5];

  for (const k of candidates) {
    const v = player[k];
    const n = Number(v);
    if (v != null && v !== "" && Number.isFinite(n)) return n;
  }
  return null;
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
  return Math.max(0, num(player?.auction_value_26, 0));
}

/**
 * Compute a weighted value using per-category component columns if present.
 * IMPORTANT: this assumes those per-category columns are already comparable components
 * (normalized contributions), NOT raw stats.
 *
 * If the CSV does not contain per-cat columns, this returns baseVal unchanged.
 */
export function getWeightedVal26(player, weights, hasCatStats) {
  const baseVal = getBaseVal26(player);
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
 *   plan, hardMax,
 *   marketDelta, strategyDelta, totalDelta,
 *   adjPrice
 * }
 */
export function computeTargetPricing(target, player, weights, opts = {}) {
  const hasCatStats = !!opts.hasCatStats;

  const caps = opts.caps || {};
  const strategyCap = num(caps.strategyCap, 6); // max $ strategy can move Δ
  const deltaCap = num(caps.deltaCap, 15);      // max total Δ

  const baseVal = getBaseVal26(player);
  const weightedVal = getWeightedVal26(player, weights, hasCatStats);

  // Market delta is always "value minus plan"
  const plan = num(target?.plan, 0);
  const hardMax = num(target?.max, 999);

  const marketDelta = baseVal - plan;

  // Strategy delta is a capped nudge:
  // difference between weighted and base value (if any per-cat stats exist)
  const strategyDeltaRaw = weightedVal - baseVal;
  const strategyDelta = clamp(strategyDeltaRaw, -strategyCap, strategyCap);

  const totalDelta = clamp(marketDelta + strategyDelta, -deltaCap, deltaCap);

  // "Adj $" is the bid recommendation anchored to base value,
  // then bounded by hard max (never exceeds hard max).
  const adjPrice = Math.min(baseVal + totalDelta, hardMax);

  return {
    baseVal,
    weightedVal,
    plan,
    hardMax,
    marketDelta,
    strategyDelta,
    totalDelta,
    adjPrice
  };
}
