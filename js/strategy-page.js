// js/strategy-page.js
// Separate Strategy Weights page (keeps Auction Board calm).

import {
  DEFAULT_WEIGHTS,
  getCategoryWeights,
  setCategoryWeights,
  getCategoryWeightsUpdatedAt
} from "./storage.js";

const HIT_CATS = [
  ["OPS", "OPS"],
  ["TB", "Total Bases"],
  ["HR", "Home Runs"],
  ["RBI", "RBI"],
  ["R", "Runs"],
  ["AVG", "AVG"],
  // We only track SB in the CSV (no Net SB).
  ["SB", "SB"],
];

const PIT_CATS = [
  ["IP", "Innings"],
  ["QS", "QS"],
  ["K", "K"],
  ["HLD", "Holds"],
  ["SV", "Saves"],
  ["ERA", "ERA"],
  ["WHIP", "WHIP"],
];

// --------------------
// Unsaved state
// --------------------
let DIRTY = false;

function setDirty(on) {
  DIRTY = !!on;
  const statusEl = document.getElementById("weightsStatus");
  if (!statusEl) return;

  if (DIRTY) {
    statusEl.innerHTML = `<span class="unsavedDot"></span> Unsaved changes`;
    statusEl.style.opacity = "1";
  } else {
    statusEl.textContent = statusText();
    statusEl.style.opacity = ".75";
  }
}

// --------------------
// Helpers
// --------------------
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(v) {
  return num(v, 0).toFixed(1);
}

function statusText() {
  const t = getCategoryWeightsUpdatedAt();
  if (!t) return "Using defaults until you save.";
  return `Last saved: ${new Date(t).toLocaleString()}`;
}

function rowTemplate({ key, label, value }) {
  const v = num(value, 1);
  return `
    <div class="weightRow" data-key="${key}">
      <div class="weightLabel">
        <div class="weightKey">${key}</div>
        <div class="small weightHelp">${label}</div>
      </div>

      <div class="sliderWrap">
        <span class="tick0" aria-hidden="true"></span>
        <input class="weightSlider" type="range" min="0" max="2" step="0.1" value="${v}" />
      </div>

      <div class="pill mono weightValue">${fmt(v)}</div>
    </div>
  `;
}

// --------------------
// Render
// --------------------
function renderWeights() {
  const hitEl = document.getElementById("weightsHit");
  const pitEl = document.getElementById("weightsPit");

  // Always merge defaults so all keys exist
  const saved = getCategoryWeights();
  const w = { ...DEFAULT_WEIGHTS, ...(saved || {}) };

  if (hitEl) {
    hitEl.innerHTML = HIT_CATS
      .map(([k, label]) => rowTemplate({ key: k, label, value: w[k] }))
      .join("");
  }

  if (pitEl) {
    pitEl.innerHTML = PIT_CATS
      .map(([k, label]) => rowTemplate({ key: k, label, value: w[k] }))
      .join("");
  }

  // Wire slider -> numeric pill + unsaved indicator
  document.querySelectorAll(".weightRow").forEach((row) => {
    const slider = row.querySelector(".weightSlider");
    const valueEl = row.querySelector(".weightValue");
    if (!slider || !valueEl) return;

    slider.addEventListener("input", () => {
      valueEl.textContent = fmt(slider.value);
      setDirty(true);
    });
  });

  // Initialize status after DOM is populated
  setDirty(false);
}

function readWeightsFromUI() {
  const next = {};
  document.querySelectorAll(".weightRow").forEach((row) => {
    const key = row.getAttribute("data-key");
    const slider = row.querySelector(".weightSlider");
    if (!key || !slider) return;
    next[key] = num(slider.value, 1);
  });
  return next;
}

function setSliders(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };

  document.querySelectorAll(".weightRow").forEach((row) => {
    const key = row.getAttribute("data-key");
    const slider = row.querySelector(".weightSlider");
    const valueEl = row.querySelector(".weightValue");
    if (!key || !slider || !valueEl) return;

    const v = num(w[key], 1);
    slider.value = String(v);
    valueEl.textContent = fmt(v);
  });
}

function flashStatus(msg) {
  const el = document.getElementById("weightsStatus");
  if (!el) return;

  el.textContent = msg;
  el.style.opacity = "1";

  setTimeout(() => {
    el.style.opacity = ".75";
    // If user changed sliders during toast, keep unsaved indicator
    if (DIRTY) {
      el.innerHTML = `<span class="unsavedDot"></span> Unsaved changes`;
      el.style.opacity = "1";
    } else {
      el.textContent = statusText();
    }
  }, 1400);
}

// --------------------
// Actions
// --------------------
function bindActions() {
  const btnSave = document.getElementById("btnSaveWeights");
  const btnReset = document.getElementById("btnResetWeights");

  if (btnSave) {
    btnSave.addEventListener("click", () => {
      const raw = readWeightsFromUI();
      const next = { ...DEFAULT_WEIGHTS, ...raw }; // ensure all keys
      setCategoryWeights(next);
      setDirty(false);
      flashStatus("Strategy saved — Adj updated on Auction Board.");
    });
  }

  if (btnReset) {
    btnReset.addEventListener("click", () => {
      setSliders(DEFAULT_WEIGHTS);
      setCategoryWeights(DEFAULT_WEIGHTS);
      setDirty(false);
      flashStatus("Reset to defaults — Adj updated on Auction Board.");
    });
  }
}

// Init
renderWeights();
bindActions();
