// js/projections-page.js
import { loadPlayers } from "./projections-data.js";
function normalize(s) {
  return String(s ?? "").trim().toLowerCase();
}

function playerName(p) {
  return normalize(
    p.Name ?? p.name ?? p.player ?? p.Player ?? ""
  );
}

const td = (v) => {
  const cell = document.createElement("td");
  cell.textContent = v;
  return cell;
};

function renderHitters(rows) {
  const hitTbody = document.getElementById("hitTbody");
  if (!hitTbody) return;

  hitTbody.innerHTML = "";
  for (const p of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(td(p.Name));
    tr.appendChild(td(p.POS));
    tr.appendChild(td(p.PA));
    tr.appendChild(td(p.AVG));
    tr.appendChild(td(p.OPS));
    tr.appendChild(td(p.TB));
    tr.appendChild(td(p.HR));
    tr.appendChild(td(p.RBI));
    tr.appendChild(td(p.R));
    tr.appendChild(td(p.SB));
    hitTbody.appendChild(tr);
  }
}


function renderPitchers(rows) {
  const pitTbody = document.getElementById("pitTbody");
  if (!pitTbody) return;

  pitTbody.innerHTML = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.className = "small";
    td.style.padding = "12px";
    td.textContent = "No results.";
    tr.appendChild(td);
    pitTbody.appendChild(tr);
    return;
  }

  for (const p of rows) {
    const tr = document.createElement("tr");

    const cells = [
      p.Name,
      p.POS,
      p.ERA,
      p.WHIP,
      p.IP,
      p.QS,
      p.K,
      p.SV,
      p.HLD,
    ];

    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = val ?? "";
      tr.appendChild(td);
    }

    pitTbody.appendChild(tr);
  }
}
function assertEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in HTML`);
  return el;
}

// Replace this with your real render logic
function renderProjections(type) {
  console.log("renderProjections()", { type });
  // TODO: your existing render function body goes here
}

document.addEventListener("DOMContentLoaded", () => {
  const projType = assertEl("projType");

  // Render once on load (so the page isn't blank)
  renderProjections(projType.value || "all");

  // Re-render when dropdown changes
  projType.addEventListener("change", (e) => {
    renderProjections(e.target.value);
  });

  console.log("projType listener attached ✅", projType.value);
});


function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function sortByStat(players, stat, asc = false) {
  return [...players].sort((a, b) => {
    if (stat === "name") {
      return normalize(a.Name).localeCompare(normalize(b.Name));
    }

    const av = Number(a[stat]);
    const bv = Number(b[stat]);

    if (Number.isNaN(av)) return 1;
    if (Number.isNaN(bv)) return -1;

    return asc ? av - bv : bv - av;
  });
}

async function init() {
  const { hitters, pitchers } = await loadPlayers();

  // DOM
  const playerSearch = document.getElementById("playerSearch");
  const searchMeta = document.getElementById("searchMeta");

  const projType = document.getElementById("projType");
  const projSort = document.getElementById("projSort");
  const btnApplyProj = document.getElementById("btnApplyProj");
  const btnResetProj = document.getElementById("btnResetProj");
  const projStatus = document.getElementById("projStatus");

  const hitSection = document.getElementById("hitSection");
  const pitSection = document.getElementById("pitSection");

  // ✅ Eligibility checkbox
  const eligOnly = document.getElementById("eligOnly");

  function applyFilters() {
    const q = normalize(playerSearch?.value);
    const type = projType?.value ?? "all";
    const sort = projSort?.value ?? "name";

    // --- SEARCH ---
    let hit = q ? hitters.filter(p => playerName(p).includes(q)) : [...hitters];
let pit = q ? pitchers.filter(p => playerName(p).includes(q)) : [...pitchers];

    // ✅ ELIGIBILITY (Hitters ≥ 250 PA, Pitchers ≥ 35 IP)
    const eligible = eligOnly?.checked ?? true;
    if (eligible) {
      hit = hit.filter(p => Number(p.PA) >= 250);
      pit = pit.filter(p => Number(p.IP) >= 35);
    }

    // --- SORT ---
    if (sort !== "name") {
      const asc = sort === "era" || sort === "whip";
      hit = sortByStat(hit, sort.toUpperCase(), asc);
      pit = sortByStat(pit, sort.toUpperCase(), asc);
    } else {
      hit = sortByStat(hit, "name");
      pit = sortByStat(pit, "name");
    }

    // --- TYPE + RENDER ---
    if (type === "hit") {
      if (hitSection) hitSection.style.display = "";
      if (pitSection) pitSection.style.display = "none";
      renderHitters(hit);
    } else if (type === "pit") {
      if (hitSection) hitSection.style.display = "none";
      if (pitSection) pitSection.style.display = "";
      renderPitchers(pit);
    } else {
      if (hitSection) hitSection.style.display = "";
      if (pitSection) pitSection.style.display = "";
      renderHitters(hit);
      renderPitchers(pit);
    }

    // meta text
    if (searchMeta) {
      if (!q) {
        searchMeta.textContent =
          `Showing all players (Hitters: ${hitters.length}, Pitchers: ${pitchers.length})`;
      } else {
        searchMeta.textContent =
          `Matches for "${playerSearch.value}" (Hitters: ${hit.length}, Pitchers: ${pit.length})`;
      }
    }

    if (projStatus) {
      projStatus.textContent =
        `Type: ${type.toUpperCase()} • Sort: ${sort.toUpperCase()} • ${eligible ? "ELIGIBLE" : "ALL"}`;
    }
  }

  // Listeners (add ONCE)
  btnApplyProj?.addEventListener("click", applyFilters);

  btnResetProj?.addEventListener("click", () => {
    if (projType) projType.value = "all";
    if (projSort) projSort.value = "name";
    if (playerSearch) playerSearch.value = "";
    if (eligOnly) eligOnly.checked = true; // ✅ restore default
    applyFilters();
  });

  playerSearch?.addEventListener("input", applyFilters);
  projType?.addEventListener("change", applyFilters);
  projSort?.addEventListener("change", applyFilters);
  eligOnly?.addEventListener("change", applyFilters); // ✅ checkbox live

  // Initial render
  applyFilters();
}

init().catch((err) => {
  console.error("Projections page init failed:", err);
});
