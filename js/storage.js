// Tiny storage helper so every page reads/writes the same way.
import { getPlayerKey } from "./player-key.js";

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
export const DEFAULT_WEIGHTS = {
  // Hitting
  AVG: 1.0,
  OPS: 1.0,
  TB: 1.0,
  HR: 1.0,
  RBI: 1.0,
  R: 1.0,
  // We only track SB in the CSV (no CS / Net SB). Keep this key as SB.
  SB: 1.0,

  // Pitching
  ERA: 1.0,
  WHIP: 1.0,
  IP: 1.0,
  QS: 1.0,
  K: 1.0,
  SV: 1.0,
  HLD: 1.0
};

// Migration: older builds used the key "SBN" for stolen bases.
// We only have SB in the dataset; transparently map SBN -> SB.
function migrateWeights(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.SB == null && obj.SBN != null) {
    obj.SB = obj.SBN;
    delete obj.SBN;
  }
  return obj;
}
function normalizeCategoryWeights(partial) {
  const obj = migrateWeights(partial && typeof partial === "object" ? { ...partial } : {});
  const out = { ...DEFAULT_WEIGHTS };

  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const n = Number(obj[k]);
    out[k] = Number.isFinite(n) ? n : DEFAULT_WEIGHTS[k];
  }

  return out;
}

export function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// -------------------------
// Settings
// -------------------------
export function getSettings() {
  const s = load("hag_settings", {
    budget_total: 300,
    budget_remaining: 300,
    hitter_slots_total: 14,
    pitcher_slots_total: 9,

    // NEW — category strategy
    category_weights: { ...DEFAULT_WEIGHTS },
    category_weights_updated_at: null,

    // UI preference: which value column to show in Auction Board
    value_mode: "proj" // "proj" | "market"
  });

  // Self-heal + migrate strategy weights (belt + suspenders)
  s.category_weights = normalizeCategoryWeights(s.category_weights);

  return s;
}

export function getCategoryWeights() {
  const s = getSettings();
  return normalizeCategoryWeights(s.category_weights);
}

export function setCategoryWeights(nextWeights) {
  const s = getSettings();

  const merged = {
    ...DEFAULT_WEIGHTS,
    ...(s.category_weights || {}),
    ...(nextWeights || {})
  };

  const normalized = normalizeCategoryWeights(merged);

  save("hag_settings", {
    ...s,
    category_weights: normalized,
    category_weights_updated_at: Date.now()
  });

  return normalized;
}


export function getCategoryWeightsUpdatedAt() {
  const s = getSettings();
  return s.category_weights_updated_at ?? null;
}


export function setSettings(next) {
  const prev = getSettings();
  const merged = { ...prev, ...(next || {}) };

  // Never allow category weights to be partial or missing
  merged.category_weights = normalizeCategoryWeights(merged.category_weights);

  save("hag_settings", merged);
}

// -------------------------
// Roster + Contracts
// -------------------------
const ROSTER_KEY = "hag_roster_v1";

/**
 * Roster player shape:
 * {
 *   id: "hit|Juan Soto",
 *   name: "Juan Soto",
 *   type: "hit" | "pit",
 *   pos: "OF" | "SP" | "RP" | ...,
 *   underContract: boolean,
 *   contractYear: number,   // 1..contractTotal
 *   contractTotal: number,  // 1..5 (or whatever)
 *   price: number           // integer dollars
 * }
 */
export function getRoster() {
  const roster = load(ROSTER_KEY, []);

  // Migration: older builds used non-normalized ids (e.g., "hit|Shohei Ohtani").
  // Normalize ids to the current getPlayerKey() format and de-dupe.
  if (Array.isArray(roster) && roster.length) {
    const byId = new Map();

    for (const raw of roster) {
      const r = normalizeRosterPlayer(raw);
      const typeRaw = String(r.type ?? r.Type ?? "").trim().toLowerCase();
      const type = typeRaw === "pit" ? "pit" : "hit";
      const name = String(r.name ?? r.Name ?? "").trim();

      const nextId = getPlayerKey({ Type: type, Name: name });

      // Prefer any existing (newer) record; merge contract fields conservatively.
      const prev = byId.get(nextId);
      if (!prev) {
        byId.set(nextId, { ...r, id: nextId, type, name });
      } else {
        byId.set(nextId, normalizeRosterPlayer({
          ...prev,
          ...r,
          id: nextId,
          type,
          name,
          // keep the "most committed" contract markers
          underContract: Boolean(prev.underContract || r.underContract),
          contractYear: Number.isFinite(Number(prev.contractYear)) ? prev.contractYear : r.contractYear,
          contractTotal: Number.isFinite(Number(prev.contractTotal)) ? prev.contractTotal : r.contractTotal,
          price: Number.isFinite(Number(prev.price)) ? prev.price : r.price,
        }));
      }
    }

    const migrated = Array.from(byId.values());
    // Only write back if something changed (id migration or de-dupe)
    const changed =
      migrated.length !== roster.length ||
      migrated.some((r, i) => r.id !== roster[i]?.id);

    if (changed) setRoster(migrated);
    return migrated;
  }

  return roster;
}
export function setRoster(next) {
  save(ROSTER_KEY, next);
}

/**
 * Creates a stable roster id from CSV player fields.
 * Assumes CSV objects have Name and Type.
 */
export function makeRosterId(player) {
  // Stable roster id: type + normalized name (or id if present)
  return getPlayerKey(player);
}

function toInt(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(n, min, max) {
  const x = toInt(n, min);
  return Math.max(min, Math.min(max, x));
}

function normalizeRosterPlayer(p) {
  const underContract = !!p.underContract;

  const contractTotal = clampInt(p.contractTotal ?? 1, 1, 10);
  const contractYear = clampInt(p.contractYear ?? 1, 1, contractTotal);

  const price = Math.max(0, toInt(p.price ?? 0, 0));

  return {
    id: String(p.id),
    name: String(p.name ?? ""),
    type: p.type === "hit" || p.type === "pit" ? p.type : "hit",
    team: String(p.team ?? ""),     // ✅ NEW
    pos: String(p.pos ?? ""),
    underContract,
    contractYear,
    contractTotal,
    price,
  };
}

/**
 * Upsert a player from CSV into the roster with contract defaults.
 * - If already present: keeps existing contract fields unless missing.
 * - If new: defaults underContract=false, 1/1, price=0
 */
export function addToRosterFromCsv(csvPlayer) {
  const roster = getRoster();

  const typeRaw = String(csvPlayer?.Type ?? "").trim().toLowerCase();
const type = typeRaw === "pit" ? "pit" : "hit";
const name = String(csvPlayer?.Name ?? "").trim();
const team = String(csvPlayer?.Team ?? "").trim();   // ✅ NEW
const pos = String(csvPlayer?.POS ?? "").trim();

const id = getPlayerKey({ Type: type, Name: name });

  const existing = roster.find((r) => r.id === id);
  if (existing) {
    // Keep existing contract info; fill blanks for name/pos/type if needed
    const merged = normalizeRosterPlayer({
  ...existing,
  name: existing.name || name,
  team: existing.team || team,   // ✅ NEW
  pos: existing.pos || pos,
  type: existing.type || type,
});

    const next = roster.map((r) => (r.id === id ? merged : r));
    setRoster(next);
    return merged;
  }

  const created = normalizeRosterPlayer({
  id,
  name,
  type: type === "pit" ? "pit" : "hit",
  team,                 // ✅ NEW
  pos,
  underContract: false,
  contractYear: 1,
  contractTotal: 1,
  price: 0,
});

  setRoster([created, ...roster]);
  return created;
}

export function updateRosterPlayer(id, patch) {
  const roster = getRoster();
  const idx = roster.findIndex((r) => r.id === id);
  if (idx === -1) return null;

  const updated = normalizeRosterPlayer({ ...roster[idx], ...patch, id });
  const next = roster.slice();
  next[idx] = updated;

  setRoster(next);
  return updated;
}

export function removeRosterPlayer(id) {
  const roster = getRoster();
  const next = roster.filter((r) => r.id !== id);
  setRoster(next);
  return next.length !== roster.length;
}

/**
 * Recalculate budget_remaining based on:
 * budget_total - sum(price) for players where underContract === true
 */
export function recalcBudgetRemaining() {
  const settings = getSettings();
  const roster = getRoster();

  const spent = roster.reduce((sum, p) => {
    const under = !!p.underContract;
    const price = Math.max(0, toInt(p.price ?? 0, 0));
    return sum + (under ? price : 0);
  }, 0);

  const budgetTotal = Math.max(0, toInt(settings.budget_total ?? 0, 0));
  const remaining = Math.max(0, budgetTotal - spent);

  const nextSettings = { ...settings, budget_remaining: remaining };
  setSettings(nextSettings);

  return { spent, remaining, budgetTotal };
}

// ==============================
// Auction Targets (prep board)
// ==============================
const AUCTION_KEY = "hag_auction_targets_v1";

function loadAuctionTargets() {
  try {
    return JSON.parse(localStorage.getItem(AUCTION_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAuctionTargets(list) {
  localStorage.setItem(AUCTION_KEY, JSON.stringify(list));
}

export function getAuctionTargets() {
  return loadAuctionTargets();
}

export function addAuctionTarget(target) {
  const list = loadAuctionTargets();

  const id =
    (crypto?.randomUUID?.() ??
      `t_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  // Preserve *all* fields passed by the caller (e.g., pricing fields used by
  // the Dashboard) while still normalizing the core shape.
  const name = String(target?.name ?? "").trim();
  const type = String(target?.type ?? "hit").trim().toLowerCase();

  const created = {
    id,
    ...(target || {}),
    name,
    type, // "hit" | "pit"
    pos: target?.pos ?? "",
    tier: target?.tier ?? "B", // "A" | "B" | "C"
    plan: Number(target?.plan ?? 0),
    max: Number(target?.max ?? 0),
    enforce: Number(target?.enforce ?? 0),
    notes: target?.notes ?? "",

    // Stable join key (used by Dashboard + future joins)
    player_key: String(target?.player_key || getPlayerKey({ type, Name: name }) || ""),

    // Source-of-truth persisted numbers (optional but preferred)
    val: target?.val != null && target?.val !== "" ? Number(target.val) : undefined,
    shadow: target?.shadow != null && target?.shadow !== "" ? Number(target.shadow) : undefined,
    adj: target?.adj != null && target?.adj !== "" ? Number(target.adj) : undefined,
    delta: target?.delta != null && target?.delta !== "" ? Number(target.delta) : undefined,
  };

  list.unshift(created);
  saveAuctionTargets(list);

  // ✅ return created so UI can autofill deterministically
  return created;
}

export function updateAuctionTarget(id, patch) {
  const list = loadAuctionTargets();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const cur = list[idx];

  list[idx] = {
    ...cur,
    ...patch,
    plan: patch?.plan !== undefined ? Number(patch.plan) : cur.plan,
    max: patch?.max !== undefined ? Number(patch.max) : cur.max,
    enforce: patch?.enforce !== undefined ? Number(patch.enforce) : cur.enforce,
  };

  saveAuctionTargets(list);
}

export function removeAuctionTarget(id) {
  const list = loadAuctionTargets().filter((t) => t.id !== id);
  saveAuctionTargets(list);
}

export function clearAuctionTargets() {
  saveAuctionTargets([]);
}

// ==============================
// Live Draft Prices (optional)
// ==============================
// Stores per-player entered price during a live auction.
// Keyed by stable player_key (same key used by Auction Targets / CSV).
const LIVE_PRICE_KEY = "hag_live_prices_v1";

export function getLivePrices() {
  return load(LIVE_PRICE_KEY, {});
}

export function setLivePrice(playerKey, price) {
  const key = String(playerKey || "").trim();
  if (!key) return;
  const map = getLivePrices();
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) {
    delete map[key];
  } else {
    map[key] = Math.round(n);
  }
  save(LIVE_PRICE_KEY, map);
}

export function clearLivePrices() {
  save(LIVE_PRICE_KEY, {});
}
