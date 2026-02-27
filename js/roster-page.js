import {
  addToRosterFromCsv,
  getRoster,
  updateRosterPlayer,
  removeRosterPlayer,
  recalcBudgetRemaining
} from "./storage.js";
import { hydrateHeader } from "./nav.js";

// ✅ Update this if your CSV filename differs
const CSV_PATH = "./data/hit_pit_2026.csv";

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function td(text, opts = {}) {
  const el = document.createElement("td");
  if (opts.alignRight) el.style.textAlign = "right";
  el.textContent = text ?? "";
  return el;
}

async function loadPlayersFromCsv() {
  const res = await fetch(CSV_PATH);
  if (!res.ok) throw new Error(`CSV fetch failed (${res.status}): ${CSV_PATH}`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map((h) => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = cols[idx]?.trim() ?? ""));
    rows.push(obj);
  }
  return rows;
}

function renderAddResults(rows, tbody, meta, rosterIds, onAdd, query) {
  tbody.innerHTML = "";

  // ✅ No query typed yet: show nothing (just a friendly message row)
  if (!query) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
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
    cell.colSpan = 4;
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
    const pos = p.POS ?? "";

    tr.appendChild(td(name));
    tr.appendChild(td(type));
    tr.appendChild(td(pos));

    const actionTd = document.createElement("td");
    actionTd.style.textAlign = "right";

    const id = `${type}|${name}`;
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
    cell.colSpan = 9;
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
  }

  addSearch?.addEventListener("input", refreshUI);

  // Initial render
  refreshUI();
}

init().catch((err) => console.error("Roster page init failed:", err));
