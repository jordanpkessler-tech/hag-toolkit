// js/allocation.js
// Simple allocation visualizer (pie) for planned spend.
// Planned spend = contracted roster $ + Auction Board Plan $.

import { getAuctionTargets, getRoster, getSettings } from "./storage.js";
import { getEmptySlotKeys } from "./recommended-targets.js";

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function money(n) {
  return `$${Math.max(0, Math.round(num(n)))}`;
}

function posList(pos) {
  return String(pos ?? "")
    .split(/[,/\s]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

function isStarter(pos) {
  const list = posList(pos);
  return list.includes("SP");
}

function classifySpend({ type, pos, dollars }) {
  const t = String(type ?? "hit").toLowerCase() === "pit" ? "pit" : "hit";
  if (t === "hit") return { bucket: "hit", dollars };
  return { bucket: isStarter(pos) ? "sp" : "rp", dollars };
}

function sumPlannedSpend() {
  const roster = (getRoster() || []).filter((p) => !!p.underContract);
  const targets = getAuctionTargets() || [];

  let hit = 0;
  let sp = 0;
  let rp = 0;

  // Contracted roster: use price
  for (const p of roster) {
    const dollars = Math.max(0, num(p.price, 0));
    const c = classifySpend({ type: p.type, pos: p.pos, dollars });
    if (c.bucket === "hit") hit += c.dollars;
    else if (c.bucket === "sp") sp += c.dollars;
    else rp += c.dollars;
  }

  // Auction targets: use Plan $ if set, else 0
  for (const t of targets) {
    const dollars = Math.max(0, num(t.plan, 0));
    const c = classifySpend({ type: t.type, pos: t.pos, dollars });
    if (c.bucket === "hit") hit += c.dollars;
    else if (c.bucket === "sp") sp += c.dollars;
    else rp += c.dollars;
  }

  return { hit, sp, rp, total: hit + sp + rp };
}

function drawPie(canvas, parts) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height } = canvas;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.48;

  ctx.clearRect(0, 0, width, height);

  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) {
    // Empty state ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(17,17,17,.18)";
    ctx.lineWidth = 12;
    ctx.stroke();
    return;
  }

  let a = -Math.PI / 2;
  for (const p of parts) {
    const frac = p.value / total;
    const da = frac * Math.PI * 2;
    const a2 = a + da;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a2);
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.fill();

    a = a2;
  }

  // Punch a donut hole for readability
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.54, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}



function renderRosterSnapshot(containerId = "rosterSnapshot") {
  const el = document.getElementById(containerId);
  if (!el) return;

  const settings = getSettings();
  const empty = getEmptySlotKeys();
  const slotsLeft = empty.length;

  const remaining = Math.max(0, num(settings?.budget_remaining, 0));
  // In HaG, teams can leave positions empty and fill via $0 FA after the draft.
  // So we treat the "reserve per remaining slot" as configurable and default it to $0.
  const reservePerSlot = Math.max(0, num(settings?.reserve_per_slot, 0));
  const reserveRequired = slotsLeft * reservePerSlot;
  const trueMax = Math.max(0, remaining - reservePerSlot * Math.max(0, slotsLeft - 1));
  const avg = slotsLeft ? (remaining / slotsLeft) : remaining;

  const hitEmpty = empty
    .filter((k) => !String(k).startsWith("P"))
    .map((k) => (k === "OF1" || k === "OF2") ? "OF" : k);

  const pitOpen = empty.filter((k) => String(k).startsWith("P")).length;

  el.innerHTML = `
    <div class="snapSection">
      <div class="small" style="opacity:.85; font-weight:900;">Needs</div>
      <div class="small" style="opacity:.75; margin-top:4px;">
        ${hitEmpty.length ? `Hitters: ${hitEmpty.length} slot(s)` : "Hitters: none"} •
        ${pitOpen ? `Pitchers: ${pitOpen} slot(s)` : "Pitchers: none"}
      </div>

      <div class="snapChips">
        ${
          hitEmpty.length
            ? hitEmpty.map((p) => `<span class="chip chipNeed">${p}</span>`).join("")
            : `<span class="chip chipDelta">All hitter slots filled</span>`
        }
        ${pitOpen ? `<span class="chip chipNeed">P × ${pitOpen}</span>` : ``}
      </div>
    </div>

    <div class="snapSection">
      <div class="small" style="opacity:.85; font-weight:900;">Bid Power</div>

      <div class="snapRow">
        <div class="small" style="opacity:.8;">Remaining</div>
        <div class="small" style="font-weight:900;">${money(remaining)}</div>
      </div>

      <div class="snapRow">
        <div class="small" style="opacity:.8;">Slots left</div>
        <div class="small" style="font-weight:900;">${slotsLeft}</div>
      </div>

      ${reservePerSlot > 0 ? `
      <div class="snapRow">
        <div class="small" style="opacity:.8;">Reserve required</div>
        <div class="small" style="font-weight:900;">${money(reserveRequired)}</div>
      </div>
      ` : ``}

      <div class="snapRow">
        <div class="small" style="opacity:.8;">True max bid</div>
        <div class="small" style="font-weight:900;">${money(trueMax)}</div>
      </div>

      <div class="snapRow">
        <div class="small" style="opacity:.8;">Avg $ / slot</div>
        <div class="small" style="font-weight:900;">$${avg.toFixed(1)}</div>
      </div>
    </div>
  `;
}

export function mountAllocationVisualizer({ canvasId = "allocPie", legendId = "allocLegend", metaId = "allocMeta" } = {}) {
  const canvas = document.getElementById(canvasId);
  const legend = document.getElementById(legendId);
  const meta = document.getElementById(metaId);
  if (!canvas || !legend) return;

  const settings = getSettings();
  const { hit, sp, rp, total } = sumPlannedSpend();

  // Colors: muted but distinct (tuned for light UI)
  const parts = [
    { key: "hit", label: "Hitters", value: hit, color: "rgba(31,60,255,.85)" },
    { key: "sp", label: "Starters", value: sp, color: "rgba(31,60,255,.45)" },
    { key: "rp", label: "RP/CP", value: rp, color: "rgba(31,60,255,.22)" },
  ];

  drawPie(canvas, parts);

  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  legend.innerHTML = parts
    .map((p) => {
      const swatch = `<span style="display:inline-block; width:12px; height:12px; border-radius:3px; background:${p.color}; margin-right:8px;"></span>`;
      return `<div style="display:flex; justify-content:space-between; gap:12px; margin:6px 0;">
        <div>${swatch}<strong>${p.label}</strong></div>
        <div style="opacity:.9;">${money(p.value)} <span style="opacity:.75;">(${pct(p.value)}%)</span></div>
      </div>`;
    })
    .join("");

  if (meta) {
    const totalBudget = Math.max(0, num(settings?.budget_total, 0));
    const remaining = Math.max(0, num(settings?.budget_remaining, 0));
    meta.textContent = "";
}

  renderRosterSnapshot("rosterSnapshot");
}
