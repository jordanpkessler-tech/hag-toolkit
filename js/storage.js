// Tiny storage helper so every page reads/writes the same way.
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
  AVG: 0.0,
  OPS: 1.3,
  TB: 1.2,
  HR: 1.2,
  RBI: 1.1,
  R: 1.1,
  SBN: 0.0,

  // Pitching
  ERA: 0.0,
  WHIP: 0.0,
  IP: 1.3,
  QS: 1.2,
  K: 1.2,
  SV: 0.0,
  HLD: 1.3
};

export function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// -------------------------
// Settings
// -------------------------
export function getSettings() {
  return load("hag_settings", {
    budget_total: 300,
    budget_remaining: 300,
    hitter_slots_total: 14,
    pitcher_slots_total: 9,

    // NEW — category strategy
    category_weights: { ...DEFAULT_WEIGHTS }
  });
}
export function getCategoryWeights() {
  const s = getSettings();
  return { ...DEFAULT_WEIGHTS, ...(s.category_weights || {}) };
}

export function setCategoryWeights(nextWeights) {
  const s = getSettings();
  const merged = { ...DEFAULT_WEIGHTS, ...(s.category_weights || {}), ...(nextWeights || {}) };
  save("hag_settings", { ...s, category_weights: merged });
  return merged;
}


export function setSettings(next) {
  save("hag_settings", next);
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
  return load(ROSTER_KEY, []);
}

export function setRoster(next) {
  save(ROSTER_KEY, next);
}

/**
 * Creates a stable roster id from CSV player fields.
 * Assumes CSV objects have Name and Type.
 */
export function makeRosterId(player) {
  const type = String(player?.Type ?? "").trim().toLowerCase();
  const name = String(player?.Name ?? "").trim();
  return `${type || "unk"}|${name}`;
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
  // Enforce safe defaults + valid contract formatting
  const underContract = !!p.underContract;

  const contractTotal = clampInt(p.contractTotal ?? 1, 1, 10);
  const contractYear = clampInt(p.contractYear ?? 1, 1, contractTotal);

  const price = Math.max(0, toInt(p.price ?? 0, 0));

  return {
    id: String(p.id),
    name: String(p.name ?? ""),
    type: p.type === "hit" || p.type === "pit" ? p.type : "hit",
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

  const type = String(csvPlayer?.Type ?? "").trim().toLowerCase();
  const name = String(csvPlayer?.Name ?? "").trim();
  const pos = String(csvPlayer?.POS ?? "").trim();

  const id = `${type}|${name}`;

  const existing = roster.find((r) => r.id === id);
  if (existing) {
    // Keep existing contract info; fill blanks for name/pos/type if needed
    const merged = normalizeRosterPlayer({
      ...existing,
      name: existing.name || name,
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

  const created = {
    id,
    name: target?.name ?? "",
    type: target?.type ?? "hit", // "hit" | "pit"
    pos: target?.pos ?? "",
    tier: target?.tier ?? "B", // "A" | "B" | "C"
    plan: Number(target?.plan ?? 0),
    max: Number(target?.max ?? 0),
    enforce: Number(target?.enforce ?? 0),
    notes: target?.notes ?? "",
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
