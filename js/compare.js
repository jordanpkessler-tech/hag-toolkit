// js/compare.js
// Compact player comparison panel for the Auction Board.
// - Pin up to 4 players
// - Shows identity (team/pos), flags, and side-by-side pricing + key projection cats
// NOTE: Uses projection/auction master CSV data (NOT 2025 stats).

import { getSettings, getCategoryWeights, getAuctionTargets } from "./storage.js";
import { normalizeName, getPlayerKey } from "./player-key.js";
import { computeTargetPricing, detectCatStats } from "./auction-data.js";

const LS_KEY = "hag_compare_keys_v1";
const MAX_PLAYERS = 4;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(n) {
  return `$${Math.max(0, Math.round(num(n)))}`;
}

function normLoose(s) {
  // normalizeName strips diacritics: Acuña -> Acuna
  // then normalize punctuation/spacing so lookups are stable
  return normalizeName(String(s ?? ""))
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/[.'’]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastFirstName(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return String(name ?? "").trim();

  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);
  let suffix = "";
  let last = parts[parts.length - 1];
  let lastIdx = parts.length - 1;

  const lastLower = String(last).toLowerCase();
  if (suffixes.has(lastLower) && parts.length >= 3) {
    suffix = last;
    last = parts[parts.length - 2];
    lastIdx = parts.length - 2;
  }

  const first = parts.slice(0, lastIdx).join(" ");
  return suffix ? `${last}, ${first} ${suffix}` : `${last}, ${first}`;
}

function getPlayerName(p) {
  return String(p?.Name ?? p?.player ?? p?.name ?? "").trim();
}

function getTeam(p) {
  return String(p?.Team ?? p?.team ?? p?.Tm ?? p?.tm ?? "").trim();
}

function getPos(p) {
  return String(p?.POS ?? p?.Pos ?? p?.pos ?? p?.Position ?? "").trim();
}

function getFlags(p) {
  const f = String(p?.Flags ?? p?.flags ?? "").trim();
  if (!f) return [];
  return f
    .split(/[,;|]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function getStat(p, keys) {
  for (const k of keys) {
    if (p && Object.prototype.hasOwnProperty.call(p, k) && p[k] !== "") return p[k];
  }
  return "";
}

function formatStat(v) {
  if (v === "" || v == null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) {
    const isIntish = Math.abs(n - Math.round(n)) < 1e-9;
    if (isIntish) return String(Math.round(n));

    // Rate stats (AVG/OPS) should keep precision (e.g., 0.285, 1.006)
    const abs = Math.abs(n);
    if (abs > 0 && abs < 2) return n.toFixed(3);

    // Other non-integers: keep 1 decimal
    return n.toFixed(1);
  }
  return String(v);
}

function loadKeys() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

let _players = [];
let _byKey = new Map();
let _byLooseName = new Map();
let _normList = [];
let _suggestByKey = new Map(); // key -> { name, label }

function buildIndexes(players) {
  _players = players || [];
  _byKey = new Map();
  _byLooseName = new Map();
  _normList = [];
  _suggestByKey = new Map();

  for (const p of _players) {
    const name = getPlayerName(p);
    if (!name) continue;

    const key = getPlayerKey({
      Name: name,
      type: p?.type,
      POS: p?.POS ?? p?.Pos ?? p?.pos,
    });

    _byKey.set(key, p);

    // Canonical label for dropdown suggestions (one per key)
    if (!_suggestByKey.has(key)) {
      const t = getTeam(p);
      const pos = getPos(p);
      _suggestByKey.set(key, { name, label: [name, t, pos].filter(Boolean).join(" — ") });
    }

    // Primary name
    const n0 = normLoose(name);
    _byLooseName.set(n0, key);
    _normList.push({ n: n0, key });

    // Aliases so datalist can match by last name prefix (e.g. "Acuna, Ronald Jr.")
    const lf = lastFirstName(name);
    const n1 = normLoose(lf);
    _byLooseName.set(n1, key);
    _normList.push({ n: n1, key });

    // ASCII alias (diacritics stripped) for users typing without accents
    const n2 = normLoose(normalizeName(lf));
    _byLooseName.set(n2, key);
    _normList.push({ n: n2, key });
  }
}

function populateDatalist() {
  const dl = document.getElementById("cmpList");
  if (!dl) return;

  // Important:
  // - Aliases/normalization are for matching (see buildIndexes/addByName).
  // - The datalist should show ONE entry per player, and should NEVER use a
  //   lowercased/normalized string as the displayed value.
  // Otherwise Safari will show confusing duplicates like:
  //   "Tarik Skubal", "Skubal, Tarik", "skubal, tarik"
  // Users can still type last name (or no-diacritics) and hit Enter/Add.

  const seenKeys = new Set();
  const opts = [];

  for (const p of _players) {
    const n = getPlayerName(p);
    if (!n) continue;

    const key = getPlayerKey({
      Name: n,
      type: p?.type,
      POS: p?.POS ?? p?.Pos ?? p?.pos,
    });

    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const t = getTeam(p);
    const pos = getPos(p);
    const label = [n, t, pos].filter(Boolean).join(" — ");

    // Single canonical option per player
    opts.push(`<option value="${escapeHtml(n)}">${escapeHtml(label)}</option>`);
  }

  dl.innerHTML = opts.join("");
}

function hideSuggest() {
  const box = document.getElementById("cmpSuggest");
  if (!box) return;
  box.style.display = "none";
  box.innerHTML = "";
}

function renderSuggest(query) {
  const box = document.getElementById("cmpSuggest");
  if (!box) return;

  const q = normLoose(query);
  if (!q) return hideSuggest();

  const keys = [];
  const seen = new Set();

  // Match against all normalized aliases but show each key only once.
  for (const it of _normList) {
    if (it.n.includes(q)) {
      if (!seen.has(it.key)) {
        seen.add(it.key);
        keys.push(it.key);
        if (keys.length >= 12) break;
      }
    }
  }

  if (!keys.length) return hideSuggest();

  const rows = [];
  for (const key of keys) {
    const meta = _suggestByKey.get(key);
    if (!meta) continue;
    rows.push(`<div class="cmpSuggestItem" data-key="${escapeHtml(key)}">${escapeHtml(meta.label || meta.name)}</div>`);
  }

  if (!rows.length) return hideSuggest();

  box.innerHTML = rows.join("");
  box.style.display = "block";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTargetForKey(key) {
  const targets = getAuctionTargets() || [];
  return targets.find((t) => String(t?.key) === String(key)) || null;
}

function pricingFor(key, player) {
  const settings = getSettings();
  const weights = getCategoryWeights();
  const valueMode = String(settings?.value_mode ?? "proj").toLowerCase() === "market" ? "market" : "proj";

  const target = getTargetForKey(key) || { plan: 0 };
  const hasCatStats = detectCatStats(player);

  const out = computeTargetPricing(target, player, weights, {
    hasCatStats,
    valueMode,
    caps: settings?.caps
  });

  return {
    value: out.baseVal,
    delta: out.adjRaw - out.baseVal,
    adj: out.adjRaw,
    plan: num(target?.plan, 0),
    max: num(target?.max, 0),
    enforce: num(target?.enforce, 0)
  };
}

function getMetricRows(playersByKey) {
  // Auction math first, then strategy cats. Avoid any 2025 actual columns.
  const rows = [
    { label: "Val", kind: "money", get: (k, p) => pricingFor(k, p).value },
    { label: "Δ", kind: "signed", get: (k, p) => pricingFor(k, p).delta },
    { label: "Adj", kind: "money", get: (k, p) => pricingFor(k, p).adj },
    { label: "Plan", kind: "money", get: (k, p) => pricingFor(k, p).plan },
    { label: "Max", kind: "money", get: (k, p) => pricingFor(k, p).max },
  ];

  // Strategy-first categories
  const statDefs = [
    { label: "OPS", keys: ["OPS", "ops"] },
    { label: "TB", keys: ["TB", "Total Bases", "total_bases"] },
    { label: "HR", keys: ["HR", "Homeruns", "home_runs"] },
    { label: "R", keys: ["R", "Runs"] },
    { label: "RBI", keys: ["RBI"] },
    { label: "AVG", keys: ["AVG", "avg", "BA", "batting_avg"] },
    { label: "SB", keys: ["SB", "sb", "Stolen Bases", "stolen_bases"] },
    { label: "IP", keys: ["IP", "Innings", "innings"] },
    { label: "QS", keys: ["QS", "Quality Starts", "quality_starts"] },
    { label: "K", keys: ["K", "SO", "Strikeouts", "strikeouts"] },
    { label: "HLD", keys: ["HLD", "Holds", "Holds+" ,"holds"] },
  ];

  // Only include stats that exist for at least one selected player.
  for (const def of statDefs) {
    let any = false;
    for (const [key, p] of playersByKey) {
      if (getStat(p, def.keys) !== "") { any = true; break; }
    }
    if (any) {
      rows.push({
        label: def.label,
        kind: "stat",
        get: (_k, p) => getStat(p, def.keys)
      });
    }
  }

  return rows;
}

function render() {
  const panel = document.getElementById("cmpPanel");
  if (!panel) return;

  const keys = loadKeys();
  const selected = keys
    .map((k) => [k, _byKey.get(k)])
    .filter(([, p]) => !!p);

  if (!selected.length) {
    panel.innerHTML = `<div class="cmpEmpty small">Add up to ${MAX_PLAYERS} players to compare. Tip: use the input above, then click Add.</div>`;
    panel.style.setProperty("--cmpCols", 1);
    return;
  }

  panel.style.setProperty("--cmpCols", String(selected.length));

  const playersByKey = new Map(selected);
  const rows = getMetricRows(playersByKey);

  const headerCells = selected
    .map(([k, p]) => {
      const name = getPlayerName(p);
      const team = getTeam(p);
      const pos = getPos(p);
      const flags = getFlags(p);
      return `
        <div class="cmpCell">
          <div class="cmpNameRow">
            <div>
              <div class="cmpName">${escapeHtml(name)}</div>
              <div class="cmpMeta">${escapeHtml([team, pos].filter(Boolean).join(" • "))}</div>
            </div>
            <button class="cmpRemove" type="button" data-cmp-remove="${escapeHtml(k)}" aria-label="Remove">×</button>
          </div>
          ${flags.length ? `<div class="cmpFlags">${flags.map(f => `<span class="chip chipDelta">${escapeHtml(f)}</span>`).join("")}</div>` : ``}
        </div>
      `;
    })
    .join("");

  const gridRows = rows
    .map((r) => {
      // For stat rows, bold the best value across the compared players (ties bolded).
      let best = null;
      if (r.kind === "stat") {
        for (const [k, p] of selected) {
          const v = r.get(k, p);
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          if (best == null || n > best) best = n;
        }
      }

      const cells = selected
        .map(([k, p]) => {
          const v = r.get(k, p);

          if (r.kind === "money") return `<div class="cmpCell"><strong>${money(v)}</strong></div>`;
          if (r.kind === "signed") {
            const n = num(v, 0);
            const sign = n > 0 ? "+" : "";
            return `<div class="cmpCell"><strong>${sign}${n.toFixed(1)}</strong></div>`;
          }

          const txt = escapeHtml(formatStat(v));

          if (r.kind === "stat" && best != null) {
            const n = Number(v);
            const isBest = Number.isFinite(n) && Math.abs(n - best) < 1e-9;
            return `<div class="cmpCell">${isBest ? `<strong>${txt}</strong>` : txt}</div>`;
          }

          return `<div class="cmpCell">${txt}</div>`;
        })
        .join("");

      return `<div class="cmpMetric">${escapeHtml(r.label)}</div>${cells}`;
    })
    .join("");


  panel.innerHTML = `
    <div class="cmpGrid">
      <div></div>
      ${headerCells}
      ${gridRows}
    </div>
  `;

  // Wire remove buttons
  panel.querySelectorAll("[data-cmp-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.getAttribute("data-cmp-remove");
      removeKey(k);
    });
  });
}

function addByName(name) {
  // If user selected/pasted "Name — TEAM — POS", keep only the name part
  const clean = String(name ?? "").split("—")[0].trim();
  const q = normLoose(clean);
  if (!q) return false;

  // 1) Exact match
  let key = _byLooseName.get(q);

  // 2) Partial match fallback (lets you type "Acuna")
  if (!key) {
    let best = null;
    for (const item of _normList) {
      if (!item?.n) continue;
      if (!item.n.includes(q)) continue;

      const score = (item.n.startsWith(q) ? 0 : 1) * 1000 + item.n.length;
      if (!best || score < best.score) best = { key: item.key, score };
    }
    key = best?.key || null;
  }

  if (!key) return false;

  const keys = loadKeys();
  if (keys.includes(key)) return true;

  const next = [...keys, key].slice(-MAX_PLAYERS);
  saveKeys(next);
  render();
  return true;
}

function addByKey(key) {
  const k = String(key ?? "").trim();
  if (!k) return false;
  if (!_byKey.has(k)) return false;

  const keys = loadKeys();
  if (keys.includes(k)) return true;

  const next = [...keys, k].slice(-MAX_PLAYERS);
  saveKeys(next);
  render();
  return true;
}

function removeKey(key) {
  const keys = loadKeys().filter((k) => String(k) !== String(key));
  saveKeys(keys);
  render();
}

function clearAll() {
  saveKeys([]);
  render();
}

export function initCompare(players) {
  buildIndexes(players);
  const input = document.getElementById("cmpInput");
  const btnAdd = document.getElementById("cmpAdd");
  const btnClear = document.getElementById("cmpClear");
  const suggest = document.getElementById("cmpSuggest");

  // Custom suggestions (Safari-safe, accent-insensitive, no duplicates)
  if (input && suggest) {
    input.addEventListener("input", () => {
      // typing clears any previously picked key
      input.dataset.key = "";
      renderSuggest(input.value);
    });

    input.addEventListener("focus", () => {
      renderSuggest(input.value);
    });

    input.addEventListener("blur", () => {
      // allow click to register
      setTimeout(() => hideSuggest(), 120);
    });

    suggest.addEventListener("mousedown", (e) => {
      const item = e.target?.closest?.(".cmpSuggestItem");
      if (!item) return;
      const key = item.getAttribute("data-key") || "";
      const meta = _suggestByKey.get(key);
      if (meta) {
        input.value = meta.name; // canonical name (accented)
        input.dataset.key = key;
      }
      hideSuggest();
    });
  }

  if (btnAdd && input) {
    btnAdd.addEventListener("click", () => {
      const pickedKey = String(input.dataset.key || "").trim();
      const name = String(input.value || "").trim();
      if (!pickedKey && !name) return;

      if (pickedKey) {
        addByKey(pickedKey);
      } else {
        addByName(name);
      }

      input.value = "";
      input.dataset.key = "";
      hideSuggest();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btnAdd.click();
      }
    });
  }

  if (btnClear) btnClear.addEventListener("click", clearAll);

  // Keep the panel fresh if localStorage changes (multi-tab or other pages).
  window.addEventListener("storage", (e) => {
    if (e.key === LS_KEY) render();
  });

  render();
}
