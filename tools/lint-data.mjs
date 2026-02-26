#!/usr/bin/env node
// tools/lint-data.mjs
// Quick sanity-checker for CSV inputs.

import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function splitCSVLine(line) {
  // Minimal: these project CSVs are simple (no quoted commas) for stats/projections.
  // For auction_values we still only need headers.
  return line.split(",").map((s) => s.trim());
}

function headerSet(filePath) {
  const text = readText(filePath).trim();
  const first = text.split(/\r?\n/)[0] || "";
  const headers = splitCSVLine(first);
  const seen = new Set();
  const dups = [];
  for (const h of headers) {
    const key = h.toLowerCase();
    if (seen.has(key)) dups.push(h);
    seen.add(key);
  }
  return { headers, set: seen, dups };
}

function hasAny(set, keys) {
  return keys.some((k) => set.has(k.toLowerCase()));
}

function requireCols(name, filePath, required) {
  const { headers, set, dups } = headerSet(filePath);
  const missing = required.filter((r) => !set.has(r.toLowerCase()));

  console.log(`\n== ${name} ==`);
  console.log(`File: ${path.relative(ROOT, filePath)}`);
  console.log(`Columns: ${headers.length}`);
  if (dups.length) console.log(`⚠️  Duplicate header(s): ${dups.join(", ")}`);
  if (missing.length) {
    console.log(`❌ Missing required column(s): ${missing.join(", ")}`);
  } else {
    console.log(`✅ Required columns present`);
  }

  return { headers, set };
}

function warn(msg) {
  console.log(`⚠️  ${msg}`);
}

function main() {
  const auctionCsv = path.join(DATA, "auction_values_2026_all_players_with_shadow.csv");
  const projCsv = path.join(DATA, "hit_pit_2026.csv");
  const statsCsv = path.join(DATA, "2025_stats.csv");

  const a = requireCols("Auction values", auctionCsv, [
    "player",
    "type",
    "auction_value_26",
  ]);

  // Optional-but-expected columns
  if (!hasAny(a.set, ["auction_price_25", "auction_price_25_imputed"])) {
    warn("Auction CSV is missing both auction_price_25 and auction_price_25_imputed (shadow pricing will be blank). ");
  }

  const p = requireCols("Projections", projCsv, ["Name", "Type", "POS"]);
  if (!hasAny(p.set, ["OPS", "TB", "HR", "RBI", "R"]) && !hasAny(p.set, ["ERA", "WHIP", "IP", "QS", "K"])) {
    warn("Projection CSV seems to be missing core hitter/pitcher stat columns.");
  }

  const s = requireCols("2025 stats", statsCsv, ["Name", "Type", "POS"]);
  if (!hasAny(s.set, ["OPS", "TB", "HR", "RBI", "R"]) && !hasAny(s.set, ["ERA", "WHIP", "IP", "QS", "K"])) {
    warn("2025 stats CSV seems to be missing core hitter/pitcher stat columns.");
  }

  console.log("\nDone. If you see missing columns, fix the CSV header names or update the loaders.");
}

main();
