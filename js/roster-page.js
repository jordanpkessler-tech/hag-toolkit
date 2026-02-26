import {
  addToRosterFromCsv,
  getRoster,
  updateRosterPlayer,
  removeRosterPlayer,
  getSettings,
  recalcBudgetRemaining
} from "./storage.js";
import { getPlayerKey, normalizeName } from "./player-key.js";
import { hydrateHeader } from "./nav.js";
import { mountRosterMiniRecommended } from "./recommended-targets.js";

// ✅ Update this if your CSV filename differs
const CSV_PATH = "./data/master.csv";

// ==============================
// Lineup Planner (Fantrax slots)
// ==============================

const PLANNER_STORAGE_KEY = "hag_lineup_planner_v1";

const HITTING_SLOTS = [
  { key: "C", label: "C" },
  { key: "1B", label: "1B" },
  { key: "2B", label: "2B" },
  { key: "3B", label: "3B" },
  { key: "SS", label: "SS" },
  { key: "CI", label: "CI" },
  { key: "MI", label: "MI" },
  { key: "LF", label: "LF" },
  { key: "CF", label: "CF" },
  { key: "RF", label: "RF" },
  { key: "OF1", label: "OF" },
  { key: "OF2", label: "OF" },
  { key: "UT", label: "UT" }
];

const PITCHING_SLOTS = Array.from({ length: 9 }).map((_, i) => ({
  key: `P${i + 1}`,
  label: `P${i + 1}`
}));

function loadPlannerState() {
  try {
    const raw = localStorage.getItem(PLANNER_STORAGE_KEY);
    if (!raw) return { slots: {}, minors: [] };
    const parsed = JSON.parse(raw);
    return {
      slots: parsed?.slots && typeof parsed.slots === "object" ? parsed.slots : {},
      minors: Array.isArray(parsed?.minors) ? parsed.minors : []
    };
  } catch {
    return { slots: {}, minors: [] };
  }
}

function savePlannerState(state) {
  localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify(state));
}

function normPosList(pos) {
  return String(pos ?? "")
    .split(/[,/\s]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

function isEligibleForSlot(player, slotKey) {
  const type = String(player.type ?? player.Type ?? "").toLowerCase();
  const posList = normPosList(player.pos ?? player.POS ?? "");

  // Pitching
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

  // Standard hitting slots
  return type === "hit" && posList.includes(slotKey);
}

function buildPlayerLabel(p) {
  const team = p.team ? ` • ${p.team}` : "";
  const pos = p.pos ? ` • ${p.pos}` : "";
  const price = p.underContract ? ` • $${Number(p.price ?? 0)}` : "";
  return `${p.name}${team}${pos}${price}`;
}

function renderPlanner(roster) {
  const hitWrap = document.getElementById("plannerHit");
  const pitWrap = document.getElementById("plannerPit");
  const benchHit = document.getElementById("benchHit");
  const benchPit = document.getElementById("benchPit");
  const minorsList = document.getElementById("minorsList");
  const minorsAddSelect = document.getElementById("minorsAddSelect");
  const minorsAddBtn = document.getElementById("minorsAddBtn");

  if (!hitWrap || !pitWrap || !benchHit || !benchPit || !minorsList || !minorsAddSelect || !minorsAddBtn) return;

  const state = loadPlannerState();

  // Clean up state if players were removed from roster
  const rosterIds = new Set(roster.map((p) => p.id));
  for (const k of Object.keys(state.slots)) {
    if (state.slots[k] && !rosterIds.has(state.slots[k])) delete state.slots[k];
  }
  state.minors = state.minors.filter((id) => rosterIds.has(id));

  // If a player is on minors, unassign them from any slot
  const minorsSet = new Set(state.minors);
  for (const k of Object.keys(state.slots)) {
    if (state.slots[k] && minorsSet.has(state.slots[k])) delete state.slots[k];
  }

  // Assigned players set
  const assignedIds = new Set(Object.values(state.slots).filter(Boolean));

  // Helpers to update state
  const setSlot = (slotKey, playerIdOrEmpty) => {
    const next = loadPlannerState();
    next.minors = Array.isArray(next.minors) ? next.minors : [];
    next.slots = next.slots && typeof next.slots === "object" ? next.slots : {};

    if (!playerIdOrEmpty) {
      delete next.slots[slotKey];
      savePlannerState(next);
      renderPlanner(roster);
      return;
    }

    // Prevent duplicates: remove player from any other slot first
    for (const k of Object.keys(next.slots)) {
      if (k !== slotKey && next.slots[k] === playerIdOrEmpty) delete next.slots[k];
    }

    // If player is in minors, remove from minors
    next.minors = next.minors.filter((id) => id !== playerIdOrEmpty);
    next.slots[slotKey] = playerIdOrEmpty;
    savePlannerState(next);
    renderPlanner(roster);
  };

  const moveToMinors = (playerId) => {
    const next = loadPlannerState();
    next.minors = Array.isArray(next.minors) ? next.minors : [];
    next.slots = next.slots && typeof next.slots === "object" ? next.slots : {};

    // Unassign from slots
    for (const k of Object.keys(next.slots)) {
      if (next.slots[k] === playerId) delete next.slots[k];
    }

    if (!next.minors.includes(playerId)) next.minors.push(playerId);
    savePlannerState(next);
    renderPlanner(roster);
  };

  const removeFromMinors = (playerId) => {
    const next = loadPlannerState();
    next.minors = Array.isArray(next.minors) ? next.minors : [];
    next.minors = next.minors.filter((id) => id !== playerId);
    savePlannerState(next);
    renderPlanner(roster);
  };

  // Render slot dropdowns
  const renderSlotGroup = (wrap, slots) => {
    wrap.innerHTML = "";
    for (const s of slots) {
      const row = document.createElement("div");
      row.className = "slot-row";

      const lab = document.createElement("div");
      lab.className = "slot-label";
      lab.textContent = s.label;

      const sel = document.createElement("select");
      const current = state.slots[s.key] ?? "";

      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— empty —";
      sel.appendChild(blank);

      // Eligible players not already used, unless it's the current selection
      const used = new Set(Object.values(state.slots).filter(Boolean));
      for (const p of roster) {
        if (!isEligibleForSlot(p, s.key)) continue;
        if (minorsSet.has(p.id)) continue;
        if (used.has(p.id) && p.id !== current) continue;

        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = buildPlayerLabel(p);
        if (p.id === current) opt.selected = true;
        sel.appendChild(opt);
      }

      sel.addEventListener("change", () => setSlot(s.key, sel.value));

      row.appendChild(lab);
      row.appendChild(sel);
      wrap.appendChild(row);
    }
  };

  renderSlotGroup(hitWrap, HITTING_SLOTS);
  renderSlotGroup(pitWrap, PITCHING_SLOTS);

  // Bench = roster - assigned - minors
  const bench = roster.filter((p) => !assignedIds.has(p.id) && !minorsSet.has(p.id));
  const benchHitters = bench.filter((p) => String(p.type).toLowerCase() === "hit");
  const benchPitchers = bench.filter((p) => String(p.type).toLowerCase() === "pit");

  const renderBench = (wrap, list) => {
    wrap.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.style.opacity = "0.75";
      empty.textContent = "—";
      wrap.appendChild(empty);
      return;
    }
    for (const p of list) {
      const item = document.createElement("div");
      item.className = "planner-item";

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `${p.team || ""}${p.team && p.pos ? " • " : ""}${p.pos || ""}`;
      meta.appendChild(name);
      meta.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Minors";
      btn.addEventListener("click", () => moveToMinors(p.id));
      actions.appendChild(btn);

      item.appendChild(meta);
      item.appendChild(actions);
      wrap.appendChild(item);
    }
  };

  renderBench(benchHit, benchHitters);
  renderBench(benchPit, benchPitchers);

  // Minors add dropdown: any roster player not already in minors
  minorsAddSelect.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select player…";
  minorsAddSelect.appendChild(blank);

  for (const p of roster) {
    if (minorsSet.has(p.id)) continue;
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = buildPlayerLabel(p);
    minorsAddSelect.appendChild(opt);
  }

  minorsAddBtn.onclick = () => {
    const id = minorsAddSelect.value;
    if (!id) return;
    moveToMinors(id);
    minorsAddSelect.value = "";
  };

  // Render minors list
  minorsList.innerHTML = "";
  const minorsPlayers = roster.filter((p) => minorsSet.has(p.id));
  if (!minorsPlayers.length) {
    const empty = document.createElement("div");
    empty.className = "small";
    empty.style.opacity = "0.75";
    empty.textContent = "—";
    minorsList.appendChild(empty);
  } else {
    for (const p of minorsPlayers) {
      const item = document.createElement("div");
      item.className = "planner-item";

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `${p.type}${p.team ? " • " + p.team : ""}${p.pos ? " • " + p.pos : ""}`;
      meta.appendChild(name);
      meta.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Remove";
      btn.addEventListener("click", () => removeFromMinors(p.id));
      actions.appendChild(btn);

      item.appendChild(meta);
      item.appendChild(actions);
      minorsList.appendChild(item);
    }
  }

  savePlannerState(state);
}


function norm(s) {
  return normalizeName(s);
}
function td(text, opts = {}) {
  const el = document.createElement("td");
  if (opts.alignRight) el.style.textAlign = "right";
  el.textContent = text ?? "";
  return el;
}

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

async function loadPlayersFromCsv() {
  const res = await fetch(CSV_PATH, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed (${res.status}): ${CSV_PATH}`);

  const text = await res.text();
  const rows = parseCSV(text.trim());
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h ?? "").trim());
  const dataRows = rows.slice(1);

  const players = dataRows.map((values) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i];
    });

    // Map master schema into expected keys (2026 projections as primary)
    obj.Name = String(obj.Name ?? obj.name ?? obj.player ?? obj.Player ?? "").trim();
    obj.Type = String(obj.Type ?? obj.type ?? "").trim();
    obj.type = String(obj.Type ?? obj.type ?? "").trim().toLowerCase();
    obj.Team = String(obj.Team ?? obj.team ?? obj.Tm ?? obj.tm ?? "").trim();
    obj.POS = String(
      obj.POS ?? obj.pos ?? obj["POS(2026)"] ?? obj["POS"] ?? obj["Display Role"] ?? obj["DisplayRole"] ?? ""
    ).trim();

    obj.PA  = obj["PA(2026)"]  ?? obj.PA  ?? "";
    obj.AVG = obj["AVG(2026)"] ?? obj.AVG ?? "";
    obj.OPS = obj["OPS(2026)"] ?? obj.OPS ?? "";
    obj.TB  = obj["TB(2026)"]  ?? obj.TB  ?? "";
    obj.HR  = obj["HR(2026)"]  ?? obj.HR  ?? "";
    obj.RBI = obj["RBI(2026)"] ?? obj.RBI ?? "";
    obj.R   = obj["R(2026)"]   ?? obj.R   ?? "";
    obj.SB  = obj["SB(2026)"]  ?? obj.SB  ?? obj["SBN(2026)"] ?? "";

    obj.ERA  = obj["ERA(2026)"]  ?? obj.ERA  ?? "";
    obj.WHIP = obj["WHIP(2026)"] ?? obj.WHIP ?? "";
    obj.IP   = obj["IP(2026)"]   ?? obj.IP   ?? "";
    obj.QS   = obj["QS(2026)"]   ?? obj.QS   ?? "";
    obj.K    = obj["K(2026)"]    ?? obj.K    ?? "";
    obj.SV   = obj["SV(2026)"]   ?? obj.SV   ?? "";
    obj.HLD  = obj["HLD(2026)"]  ?? obj.HLD  ?? "";

    obj.player_key = getPlayerKey(obj);
    return obj;
  });

  return players;
}


function renderAddResults(rows, tbody, meta, rosterIds, onAdd, query) {
  tbody.innerHTML = "";

  // ✅ No query typed yet: show nothing (just a friendly message row)
  if (!query) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "small";
    cell.style.padding = "12px";
    cell.style.opacity = "0.75";
    cell.textContent = "Start typing to search players…";
    tr.appendChild(cell);
    tbody.appendChild(tr);

    if (meta) meta.textContent = "Type to search…";
    return;
  }

  // ✅ Query typed but no matches
  if (!rows.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "small";
    cell.style.padding = "12px";
    cell.textContent = "No matches.";
    tr.appendChild(cell);
    tbody.appendChild(tr);

    if (meta) meta.textContent = "No matches.";
    return;
  }

  if (meta) meta.textContent = `Matches: ${rows.length}`;

  for (const p of rows.slice(0, 50)) {
    const tr = document.createElement("tr");

    const name = p.Name ?? "";
    const type = (p.Type ?? "").toLowerCase();
    const team = p.Team ?? "";
    const pos = p.POS ?? "";

    tr.appendChild(td(name));
    tr.appendChild(td(type));
    tr.appendChild(td(team));
    tr.appendChild(td(pos));

    const actionTd = document.createElement("td");
    actionTd.style.textAlign = "right";

    const id = getPlayerKey(p);
    const already = rosterIds.has(id);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = already ? "Added" : "Add";
    btn.disabled = already;
    btn.addEventListener("click", () => onAdd(p));

    actionTd.appendChild(btn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

function renderRoster(roster, tbody, meta, onChange, onRemove) {
  tbody.innerHTML = "";

  if (!roster.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 10;
    cell.className = "small";
    cell.style.padding = "12px";
    cell.textContent = "No players yet. Add someone above.";
    tr.appendChild(cell);
    tbody.appendChild(tr);
    if (meta) meta.textContent = "";
    return;
  }

  const contracted = roster.filter((r) => r.underContract).length;
  if (meta) meta.textContent = `Players: ${roster.length} • Under contract: ${contracted}`;

  for (const r of roster) {
    const tr = document.createElement("tr");

    tr.appendChild(td(r.name));
    tr.appendChild(td(r.type));
    tr.appendChild(td(r.team));
    tr.appendChild(td(r.pos));

    // Contract?
    const cTd = document.createElement("td");
    const cBox = document.createElement("input");
    cBox.type = "checkbox";
    cBox.checked = !!r.underContract;
    cBox.addEventListener("change", () => onChange(r.id, { underContract: cBox.checked }));
    cTd.appendChild(cBox);
    tr.appendChild(cTd);

    // Year
    const yTd = document.createElement("td");
    const yIn = document.createElement("input");
    yIn.type = "number";
    yIn.min = "1";
    yIn.step = "1";
    yIn.value = String(r.contractYear ?? 1);
    yIn.style.width = "70px";
    yIn.addEventListener("change", () => onChange(r.id, { contractYear: Number(yIn.value) }));
    yTd.appendChild(yIn);
    tr.appendChild(yTd);

    // Total
    const tTd = document.createElement("td");
    const tIn = document.createElement("input");
    tIn.type = "number";
    tIn.min = "1";
    tIn.step = "1";
    tIn.value = String(r.contractTotal ?? 1);
    tIn.style.width = "70px";
    tIn.addEventListener("change", () => onChange(r.id, { contractTotal: Number(tIn.value) }));
    tTd.appendChild(tIn);
    tr.appendChild(tTd);

    // Price
    const pTd = document.createElement("td");
    const pIn = document.createElement("input");
    pIn.type = "number";
    pIn.min = "0";
    pIn.step = "1";
    pIn.value = String(r.price ?? 0);
    pIn.style.width = "90px";
    pIn.addEventListener("change", () => onChange(r.id, { price: Number(pIn.value) }));
    pTd.appendChild(pIn);
    tr.appendChild(pTd);

    // Notation
    const notation = r.underContract ? `${r.contractYear}/${r.contractTotal}, $${Number(r.price ?? 0)}` : "—";
    tr.appendChild(td(notation));

    // Remove
    const rmTd = document.createElement("td");
    rmTd.style.textAlign = "right";
    const rmBtn = document.createElement("button");
    rmBtn.type = "button";
    rmBtn.className = "ghost";
    rmBtn.textContent = "Remove";
    rmBtn.addEventListener("click", () => onRemove(r.id));
    rmTd.appendChild(rmBtn);
    tr.appendChild(rmTd);

    tbody.appendChild(tr);
  }
}

async function init() {
  const addSearch = document.getElementById("rosterAddSearch");
  const addMeta = document.getElementById("rosterAddMeta");
  const addTbody = document.getElementById("rosterAddTbody");

  const rosterMeta = document.getElementById("rosterMeta");
  const rosterTbody = document.getElementById("rosterTbody");

  // Load CSV pool
  const pool = await loadPlayersFromCsv();

  function refreshUI() {
    const roster = getRoster();
    const rosterIds = new Set(roster.map((r) => r.id));

    // ✅ Only show results when user types something
    const q = norm(addSearch?.value);
    const matches = q ? pool.filter((p) => norm(p.Name).includes(q)) : [];

    renderAddResults(matches, addTbody, addMeta, rosterIds, (player) => {
      addToRosterFromCsv(player);
      recalcBudgetRemaining();
      hydrateHeader();
      refreshUI();
    }, q);

    renderRoster(
      roster,
      rosterTbody,
      rosterMeta,
      (id, patch) => {
        updateRosterPlayer(id, patch);
        recalcBudgetRemaining();
        hydrateHeader();
        refreshUI();
      },
      (id) => {
        removeRosterPlayer(id);
        recalcBudgetRemaining();
        hydrateHeader();
        refreshUI();
      }
    );

    // Lineup planner (starting slots / benches / minors)
    renderPlanner(roster);

    // Mini recommended targets panel
    try {
      const mode = String(getSettings()?.value_mode ?? "proj");
      mountRosterMiniRecommended({ players: pool, valueMode: mode });
    } catch (e) {
      console.warn("[roster] mini recommended targets failed", e);
    }
  }

  addSearch?.addEventListener("input", refreshUI);

  // Allow other panels (Recommended quick-add) to request a rerender.
  window.hagRefreshRoster = refreshUI;

  // Initial render
  refreshUI();
}

init().catch((err) => console.error("Roster page init failed:", err));
