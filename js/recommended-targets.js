// js/recommended-targets.js
// Recommended Targets panel (objective + biased only via user strategy weights).

import { getCategoryWeights, getRoster, getLivePrices, getSettings, addAuctionTarget, addToRosterFromCsv, getAuctionTargets } from "./storage.js";
import {
  detectCatStats,
  getCatStat,
  getBaselineVal,
  getMarketEstimate,
  getPlayerKey,
} from "./auction-data.js";

const PLANNER_STORAGE_KEY = "hag_lineup_planner_v1";

// Keep these aligned with auction-data.js categories.
const HIT_CATS = ["OPS", "TB", "HR", "RBI", "R", "AVG", "SB"];
const PIT_CATS = ["ERA", "WHIP", "IP", "K", "QS", "SV", "HLD"];

const REC_FILTER_KEY = "hag_rec_filters_v1";

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(n) {
  return `$${Math.max(0, Math.round(num(n)))}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function loadRecFilters() {
  try {
    const raw = localStorage.getItem(REC_FILTER_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return {
      affordable_only: !!obj.affordable_only,
      max_price: obj.max_price != null && obj.max_price !== "" ? Number(obj.max_price) : null,
    };
  } catch {
    return { affordable_only: false, max_price: null };
  }
}

function saveRecFilters(next) {
  try {
    localStorage.setItem(REC_FILTER_KEY, JSON.stringify(next || {}));
  } catch {
    // ignore
  }
}

function computeAutoMaxBid() {
  const s = getSettings();
  const roster = getRoster() || [];
  const totalSlots = Math.max(0, num(s?.hitter_slots_total, 0)) + Math.max(0, num(s?.pitcher_slots_total, 0));
  const filled = roster.filter((p) => !!p.underContract).length;
  const remainingSlots = Math.max(1, totalSlots - filled);
  const remainingBudget = Math.max(0, num(s?.budget_remaining, 0));

  // Classic auction constraint: keep $1 for every remaining slot after this one.
  const maxBid = Math.max(0, Math.floor(remainingBudget - (remainingSlots - 1)));
  return { maxBid, remainingBudget, remainingSlots, totalSlots, filled };
}

function normPosList(pos) {
  return String(pos ?? "")
    .split(/[,/\s]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

function normType(t) {
  const s = String(t ?? "").trim().toLowerCase();
  return s === "pit" ? "pit" : "hit";
}

function isEligibleForSlot(player, slotKey) {
  const type = normType(player.type ?? player.Type ?? "");
  const posList = normPosList(player.POS ?? player.pos ?? player.Position ?? "");

  // Pitching slots
  if (slotKey.startsWith("P")) return type === "pit";

  // UT
  if (slotKey === "UT") return type === "hit";

  // OF duplicates
  if (slotKey === "OF1" || slotKey === "OF2") {
    return type === "hit" && (posList.includes("OF") || posList.includes("LF") || posList.includes("CF") || posList.includes("RF"));
  }

  // CI / MI
  if (slotKey === "CI") return type === "hit" && (posList.includes("1B") || posList.includes("3B"));
  if (slotKey === "MI") return type === "hit" && (posList.includes("2B") || posList.includes("SS"));

  // Standard
  return type === "hit" && posList.includes(slotKey);
}

function loadPlannerState() {
  try {
    const raw = localStorage.getItem(PLANNER_STORAGE_KEY);
    if (!raw) return { slots: {}, minors: [] };
    const parsed = JSON.parse(raw);
    return {
      slots: parsed?.slots && typeof parsed.slots === "object" ? parsed.slots : {},
      minors: Array.isArray(parsed?.minors) ? parsed.minors : [],
    };
  } catch {
    return { slots: {}, minors: [] };
  }
}

export function getEmptySlotKeys() {
  const state = loadPlannerState();
  const slots = state.slots || {};

  const hit = ["C","1B","2B","3B","SS","CI","MI","LF","CF","RF","OF1","OF2","UT"];
  const pit = Array.from({ length: 9 }).map((_, i) => `P${i + 1}`);

  const empty = [];
  for (const k of [...hit, ...pit]) {
    if (!slots[k]) empty.push(k);
  }
  return empty;
}

function needBoostForPlayer(player, emptySlots) {
  // Only boost if a required slot is currently empty.
  // Use max boost among eligible empty slots.
  let boost = 0;
  for (const k of emptySlots) {
    if (!isEligibleForSlot(player, k)) continue;

    // Tuneable boosts
    let b = 0;
    if (k.startsWith("P")) b = 6;
    else if (k === "UT") b = 4;
    else if (k === "OF1" || k === "OF2") b = 8;
    else if (k === "CI" || k === "MI") b = 10;
    else b = 10;

    boost = Math.max(boost, b);
  }
  return boost;
}

function getStablePlayerKey(p) {
  const name = String(p?.Name ?? p?.name ?? p?.player ?? "").trim();
  const type = normType(p?.type ?? p?.Type ?? "");
  return String(p?.player_key || getPlayerKey({ type, Name: name }) || "");
}

function getDisplayName(p) {
  return String(p?.Name ?? p?.name ?? p?.player ?? "").trim() || "—";
}

function getDisplayTeam(p) {
  return String(p?.Team ?? p?.team ?? "").trim();
}

function getDisplayPos(p) {
  return String(p?.POS ?? p?.pos ?? p?.Position ?? "").trim();
}

function pickFallbackPrice(p) {
  // Default fallback = Market Estimate (if present) else baseline value.
  const m = getMarketEstimate(p);
  if (m != null && m > 0) return m;
  return getBaselineVal(p, "proj") ?? 0;
}

function computeFitRaw(player, weights, hasCatStats) {
  // Objective "fit" uses ONLY user weights applied to raw category stats.
  // We normalize later so different stat magnitudes don't dominate.
  if (!player || !hasCatStats) return 0;
  const w = weights || {};
  const cats = normType(player.type ?? player.Type ?? "") === "pit" ? PIT_CATS : HIT_CATS;

  let sum = 0;
  let any = false;
  for (const cat of cats) {
    const ww = num(w[cat], 0);
    if (!ww) continue;
    const v = getCatStat(player, cat);
    if (v == null) continue;
    any = true;
    sum += v * ww;
  }
  return any && Number.isFinite(sum) ? sum : 0;
}

function scorePlayers(players, valueMode, opts = {}) {
  const weights = getCategoryWeights();
  const roster = getRoster();
  const rosterIds = new Set(roster.map((r) => String(r.id || "").trim()).filter(Boolean));

  // Exclude players already added to the Auction Board targets list.
  const targetKeys = new Set(
    (getAuctionTargets?.() || [])
      .map((t) => String(t?.player_key || "").trim())
      .filter(Boolean)
  );

  const emptySlots = getEmptySlotKeys();
  const livePrices = getLivePrices();
  // Some pools start with auction-only rows that don't have stat columns.
  // Scan a slice so we don't incorrectly think the dataset has no stats.
  let hasCatStats = false;
  const scanN = Math.min(200, Array.isArray(players) ? players.length : 0);
  for (let i = 0; i < scanN; i++) {
    if (detectCatStats(players[i])) { hasCatStats = true; break; }
  }

  const scored = [];
  const fitRaws = [];

  const affordableOnly = !!opts.affordableOnly;
  const maxPrice = Number.isFinite(Number(opts.maxPrice)) ? Number(opts.maxPrice) : null;

  for (const p of players || []) {
    const key = getStablePlayerKey(p);
    if (!key) continue;

    // Exclude rostered players
    if (rosterIds.has(key)) continue;

    // Exclude already-targeted players
    if (targetKeys.has(key)) continue;

    // $ value for pricing / delta (does NOT include strategy weighting)
    const baseVal = getBaselineVal(p, valueMode) ?? 0;

    // Strategy fit (raw), normalized later.
    const fitRaw = computeFitRaw(p, weights, hasCatStats);
    fitRaws.push(fitRaw);

    const live = livePrices[key];
    const price = (live != null && live !== "") ? num(live, 0) : pickFallbackPrice(p);

    const needBoost = needBoostForPlayer(p, emptySlots);

    // Affordability filter uses chosen price basis (live if present, else fallback)
    if (affordableOnly && maxPrice != null && price > maxPrice) continue;

    // Value edge uses $-based baseline vs price.
    const valueEdge = clamp(baseVal - price, -15, 15);

    scored.push({
      key,
      player: p,
      baseVal,
      fitRaw,
      price,
      valueEdge,
      needBoost,
      score: 0,
    });
  }

  // Normalize fitRaw to a 0..100 band so it's comparable across stat magnitudes.
  const finite = fitRaws.filter((x) => Number.isFinite(x));
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 0;
  const denom = max - min;

  for (const r of scored) {
    const fitNorm = denom > 0 ? (100 * (r.fitRaw - min) / denom) : 0;
    r.fitVal = Number.isFinite(fitNorm) ? fitNorm : 0;
    // Objective score: strategy fit + under/over + needs
    r.score = r.fitVal + (r.valueEdge * 0.9) + r.needBoost;
  }

  scored.sort((a, b) => b.score - a.score);
  return { scored, emptySlots, hasCatStats };
}

function slotChipText(emptySlots, p) {
  // Return the most relevant fill chip (single chip, objective).
  const hits = [];
  for (const k of emptySlots) {
    if (isEligibleForSlot(p, k)) hits.push(k);
  }
  if (!hits.length) return "";
  // Prefer MI/CI/C/SS/2B/3B/1B over OF/UT, and OF/UT over pitching
  const priority = (k) => {
    if (k === "MI" || k === "CI") return 1;
    if (k === "C" || k === "SS" || k === "2B" || k === "3B" || k === "1B") return 2;
    if (k === "OF1" || k === "OF2" || k === "LF" || k === "CF" || k === "RF") return 3;
    if (k === "UT") return 4;
    if (k.startsWith("P")) return 5;
    return 9;
  };
  hits.sort((a, b) => priority(a) - priority(b));
  const k = hits[0];
  if (k === "OF1" || k === "OF2") return "Fills OF";
  if (k.startsWith("P")) return "Fills P";
  return `Fills ${k}`;
}

function renderRows(container, rows, emptySlots, maxRows = 10, { showActions = false } = {}) {
  const top = rows.slice(0, maxRows);
  if (!top.length) {
    container.innerHTML = `<div class="small" style="opacity:.75;">No eligible players found.</div>`;
    return;
  }

  container.innerHTML = top
    .map((r) => {
      const p = r.player;
      const name = getDisplayName(p);
      const team = getDisplayTeam(p);
      const pos = getDisplayPos(p);
      const chip = slotChipText(emptySlots, p);
      const delta = r.baseVal - r.price;
      const deltaTxt = delta >= 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`;
      const teamTxt = team ? ` • ${team}` : "";
      const posTxt = pos ? ` • ${pos}` : "";

      const actions = showActions
        ? `
          <div class="recActions">
            <button class="ghost recActionBtn" type="button" data-rec-action="add-auction" data-player-key="${r.key}">+ Auction</button>
            <button class="ghost recActionBtn" type="button" data-rec-action="add-roster" data-player-key="${r.key}">+ Roster</button>
          </div>
        `
        : "";

      return `
        <div class="recRow">
          <div class="recMain">
            <div class="recName">${name}<span class="recMeta">${teamTxt}${posTxt}</span></div>
            <div class="recSub">
              <span class="chip">Adj ${money(r.baseVal)}</span>
              <span class="chip">Price ${money(r.price)}</span>
              <span class="chip chipDelta">Δ ${deltaTxt}</span>
              <span class="chip">Fit ${Math.round(r.fitVal)}</span>
              ${chip ? `<span class="chip chipNeed">${chip}</span>` : ""}
            </div>
          </div>
          ${actions}
        </div>
      `;
    })
    .join("");
}

export function mountRecommendedTargets({
  players,
  valueMode,
  fullContainerId = "recTargets",
  needsContainerId = "recNeeds",
  valuesContainerId = "recValues",
  fitsContainerId = "recFits",
} = {}) {
  const elFull = document.getElementById(fullContainerId);
  if (!elFull) return;

  const elNeeds = document.getElementById(needsContainerId);
  const elValues = document.getElementById(valuesContainerId);
  const elFits = document.getElementById(fitsContainerId);

  const mode = String(valueMode || "proj").toLowerCase() === "market" ? "market" : "proj";

  // Affordability controls (Auction Board only; safe no-ops elsewhere)
  const cb = document.getElementById("recAffordableOnly");
  const maxInput = document.getElementById("recMaxBid");
  const persisted = loadRecFilters();
  const DEFAULT_MAX = 9999;

  // Read current UI state or fall back to persisted.
  const affordableOnly = cb ? !!cb.checked : persisted.affordable_only;
  let maxPrice = null;
  if (maxInput) {
    const v = String(maxInput.value || "").trim();
    maxPrice = v ? num(v, DEFAULT_MAX) : DEFAULT_MAX;
  } else if (persisted.max_price != null) {
    maxPrice = num(persisted.max_price, DEFAULT_MAX);
  } else {
    maxPrice = DEFAULT_MAX;
  }

  // Self-heal UI on first mount
  if (cb && cb.dataset._init !== "1") {
    cb.checked = affordableOnly;
    cb.dataset._init = "1";
  }
  if (maxInput && maxInput.dataset._init !== "1") {
    // If user previously set a custom value, keep it; otherwise show blank and use Auto.
    if (persisted.max_price != null && Number.isFinite(Number(persisted.max_price))) {
      maxInput.value = String(Math.round(num(persisted.max_price, DEFAULT_MAX)));
    } else {
      maxInput.value = "";
    }
    maxInput.dataset._init = "1";
  }

  // Persist latest settings (so refresh keeps behavior)
  saveRecFilters({ affordable_only: affordableOnly, max_price: maxInput && String(maxInput.value || "").trim() ? Math.round(maxPrice) : null });

  const { scored, emptySlots } = scorePlayers(players || [], mode, { affordableOnly, maxPrice });

  // Bucket A: Fill Needs
  const needs = scored.filter((r) => r.needBoost > 0);

  // Bucket B: Best Values (best Δ among decent FitVal)
  const values = scored
    .slice()
    .sort((a, b) => (b.baseVal - b.price) - (a.baseVal - a.price));

  // Bucket C: Best Fits (highest fitVal)
  const fits = scored
    .slice()
    .sort((a, b) => b.fitVal - a.fitVal);

  if (elNeeds) renderRows(elNeeds, needs, emptySlots, 8, { showActions: true });
  if (elValues) renderRows(elValues, values, emptySlots, 8, { showActions: true });
  if (elFits) renderRows(elFits, fits, emptySlots, 8, { showActions: true });

  // One-time event delegation for quick-add actions
  if (elFull && elFull.dataset._recActionsBound !== "1") {
    elFull.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-rec-action]") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-rec-action");
      const key = btn.getAttribute("data-player-key");
      const map = elFull.__recMap;
      const row = map && key ? map.get(key) : null;
      if (!row) return;

      const p = row.player;
      const name = getDisplayName(p);
      const team = getDisplayTeam(p);
      const pos = getDisplayPos(p);
      const type = normType(p.type ?? p.Type ?? "");

      if (action === "add-auction") {
        const plan = Math.max(0, Math.round(num(row.baseVal, 0)));
        addAuctionTarget({
          name,
          type,
          team,
          pos,
          plan,
          max: plan > 0 ? plan + 5 : 0,
          tier: "B",
          player_key: row.key,
          // persist helpful fields for downstream displays
          val: row.baseVal,
        });
        window.hagRefreshAuction?.();
      }

      if (action === "add-roster") {
        addToRosterFromCsv({
          Name: name,
          Type: type,
          Team: team,
          POS: pos,
        });
        window.hagRefreshRoster?.();
        window.hagRefreshAuction?.();
      }
    });
    elFull.dataset._recActionsBound = "1";
  }

  // Store latest score map for the click handler
  elFull.__recMap = new Map(scored.map((r) => [r.key, r]));

  // Header helpers
  const elEmpty = document.getElementById("recEmptySlots");
  if (elEmpty) {
    const pretty = emptySlots
      .filter((k) => !k.startsWith("P"))
      .map((k) => (k === "OF1" || k === "OF2") ? "OF" : k)
      .join(", ");
    const pitEmpty = emptySlots.filter((k) => k.startsWith("P")).length;
    const extra = pitEmpty ? ` • P slots open: ${pitEmpty}` : "";
    elEmpty.textContent = pretty ? `Empty slots: ${pretty}${extra}` : `Empty slots: —${extra}`;
  }
}

export function mountRosterMiniRecommended({
  players,
  valueMode,
  containerId = "rosterRecMini",
} = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const mode = String(valueMode || "proj").toLowerCase() === "market" ? "market" : "proj";
  const { scored, emptySlots } = scorePlayers(players || [], mode);
  const needs = scored.filter((r) => r.needBoost > 0);

  el.innerHTML = `
    <div class="small" style="opacity:.8; margin-bottom:8px;" id="rosterRecEmpty">
      ${emptySlots.length ? `Empty slots: ${emptySlots.filter(k=>!k.startsWith('P')).map(k => (k==='OF1'||k==='OF2')?'OF':k).join(', ')}` : "Empty slots: —"}
    </div>
    <div id="${containerId}Rows"></div>
    <div class="small" style="opacity:.75; margin-top:10px;">
      Full list on <a href="auction.html">Auction Board</a>.
    </div>
  `;

  const rowsEl = document.getElementById(`${containerId}Rows`);
  if (!rowsEl) return;
  renderRows(rowsEl, needs.length ? needs : scored, emptySlots, 5, { showActions: true });

  // Bind quick-add actions for the roster mini panel
  if (el.dataset._recActionsBound !== "1") {
    el.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-rec-action]") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-rec-action");
      const key = btn.getAttribute("data-player-key");
      const map = el.__recMap;
      const row = map && key ? map.get(key) : null;
      if (!row) return;

      const p = row.player;
      const name = getDisplayName(p);
      const team = getDisplayTeam(p);
      const pos = getDisplayPos(p);
      const type = normType(p.type ?? p.Type ?? "");

      if (action === "add-auction") {
        const plan = Math.max(0, Math.round(num(row.baseVal, 0)));
        addAuctionTarget({
          name,
          type,
          team,
          pos,
          plan,
          max: plan > 0 ? plan + 5 : 0,
          tier: "B",
          player_key: row.key,
          val: row.baseVal,
        });
        window.hagRefreshAuction?.();
      }
      if (action === "add-roster") {
        addToRosterFromCsv({ Name: name, Type: type, Team: team, POS: pos });
        window.hagRefreshRoster?.();
        window.hagRefreshAuction?.();
      }
    });
    el.dataset._recActionsBound = "1";
  }

  el.__recMap = new Map(scored.map((r) => [r.key, r]));
}