import { getSettings } from "./storage.js";

export function setActiveTab() {
  const path = window.location.pathname.split("/").pop() || "index.html";

  document.querySelectorAll("nav a[data-tab]").forEach((a) => {
    const tab = a.getAttribute("data-tab");
    a.classList.toggle("active", tab === path);
  });
}

export function hydrateHeader() {
  const s = getSettings();

  const budgetEl = document.getElementById("hdrBudget");
  const slotsEl = document.getElementById("hdrSlots");

  if (budgetEl) budgetEl.textContent = `Budget: $${s.budget_remaining}`;
  if (slotsEl) {
    slotsEl.textContent = `Slots: H ${s.hitter_slots_total} / P ${s.pitcher_slots_total}`;
  }
}
