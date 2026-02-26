// js/projections-data.js
// Responsible ONLY for loading + parsing the CSV

import { getPlayerKey } from "./player-key.js";

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

function toNumberMaybe(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return "";

  // Strip common numeric decorations: $ and commas
  const cleaned = s.replace(/[$,]/g, "");

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : s; // keep original string if not numeric
}

function normalizeType(obj) {
  // Normalize type (Type vs type, casing)
  const t = String(obj.type ?? obj.Type ?? "").trim().toLowerCase();
  obj.type = t;

  // Normalize player name so search + UI keep working (Name vs name vs player)
  obj.Name = String(obj.Name ?? obj.name ?? obj.player ?? obj.Player ?? "").trim();

  // Normalize position for UI consistency (POS vs pos)
  obj.POS = String(obj.POS ?? obj.pos ?? obj.Pos ?? obj["Display Role"] ?? obj["DisplayRole"] ?? obj["POS(2026)"] ?? "").trim();
  obj.Team = String(obj.Team ?? obj.team ?? obj.Tm ?? obj.tm ?? "").trim();

  return obj;
}

function normalizeStats(obj) {
  // Pick first non-empty value among candidate keys
  const pick = (...keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== "") return v;
    }
    return "";
  };

  // ---- Hitters (UI expects these exact keys) ----
  obj.PA  = pick("PA", "pa", "PA(2026)", "PA 2026");
  obj.AVG = pick("AVG", "avg", "AVG(2026)", "AVG 2026");
  obj.OPS = pick("OPS", "ops", "OPS(2026)", "OPS 2026");
  obj.TB  = pick("TB", "tb", "total_bases", "TotalBases", "TB(2026)", "TB 2026");
  obj.HR  = pick("HR", "hr", "HR(2026)", "HR 2026");
  obj.RBI = pick("RBI", "rbi", "RBI(2026)", "RBI 2026");
  obj.R   = pick("R", "r", "runs", "Runs", "R(2026)", "R 2026");
  obj.SB  = pick("SB", "sb", "sbn", "stolen_bases", "StolenBases", "SB(2026)", "SB 2026", "SBN(2026)");

  // ---- Pitchers (UI expects these exact keys) ----
  obj.ERA  = pick("ERA", "era", "ERA(2026)", "ERA 2026");
  obj.WHIP = pick("WHIP", "whip", "WHIP(2026)", "WHIP 2026");
  obj.IP   = pick("IP", "ip", "innings_pitched", "InningsPitched", "IP(2026)", "IP 2026");
  obj.QS   = pick("QS", "qs", "quality_starts", "QualityStarts", "QS(2026)", "QS 2026");
  obj.K    = pick("K", "k", "SO", "so", "strikeouts", "Strikeouts", "K(2026)", "K 2026");
  obj.SV   = pick("SV", "sv", "saves", "Saves", "SV(2026)", "SV 2026");
  obj.HLD  = pick("HLD", "hld", "holds", "Holds", "HLD(2026)", "HLD 2026");

  return obj;
}

// ---- Dedupe helpers (accent-split duplicates) ----
function hasDiacritics(s) {
  // Detect diacritics by checking NFD combining marks
  return /[\u0300-\u036f]/.test(String(s || "").normalize("NFD"));
}

function filledCount(p) {
  // Prefer rows with more populated stat fields (prevents empty duplicate "winning")
  const keys = [
    "PA","AVG","OPS","TB","HR","RBI","R","SB",
    "ERA","WHIP","IP","QS","K","SV","HLD"
  ];

  let c = 0;
  for (const k of keys) {
    const v = p?.[k];
    if (v !== undefined && v !== "" && String(v).trim() !== "") c++;
  }

  // tiny preference for accented display name
  return c + (hasDiacritics(p?.Name) ? 0.25 : 0);
}

function dedupeByPlayerKey(players) {
  const byKey = new Map();

  for (const p of players) {
    const key = String(p?.player_key || "").trim();
    if (!key) continue;

    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, p);
    } else {
      byKey.set(key, filledCount(p) > filledCount(cur) ? p : cur);
    }
  }

  return Array.from(byKey.values());
}

export async function loadPlayers() {
  const res = await fetch("./data/master.csv", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load CSV: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const rows = parseCSV(text.trim());
  if (rows.length < 2) {
    return { players: [], hitters: [], pitchers: [] };
  }

  const headers = rows[0].map((h) => String(h ?? '').trim());

    const players = rows.slice(1).map((values) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = toNumberMaybe(values[i]);
    });

    // Master schema → expected keys
    // Prefer 2026 projection columns for the core stat keys
    obj.PA  = obj.PA  !== undefined && obj.PA  !== '' ? obj.PA  : (obj['PA(2026)']  ?? obj['PA 2026']  ?? '');
    obj.AVG = obj.AVG !== undefined && obj.AVG !== '' ? obj.AVG : (obj['AVG(2026)'] ?? obj['AVG 2026'] ?? '');
    obj.OPS = obj.OPS !== undefined && obj.OPS !== '' ? obj.OPS : (obj['OPS(2026)'] ?? obj['OPS 2026'] ?? '');
    obj.TB  = obj.TB  !== undefined && obj.TB  !== '' ? obj.TB  : (obj['TB(2026)']  ?? obj['TB 2026']  ?? '');
    obj.HR  = obj.HR  !== undefined && obj.HR  !== '' ? obj.HR  : (obj['HR(2026)']  ?? obj['HR 2026']  ?? '');
    obj.RBI = obj.RBI !== undefined && obj.RBI !== '' ? obj.RBI : (obj['RBI(2026)'] ?? obj['RBI 2026'] ?? '');
    obj.R   = obj.R   !== undefined && obj.R   !== '' ? obj.R   : (obj['R(2026)']   ?? obj['R 2026']   ?? '');
    obj.SB  = obj.SB  !== undefined && obj.SB  !== '' ? obj.SB  : (obj['SB(2026)']  ?? obj['SB 2026']  ?? obj['SBN(2026)'] ?? '');

    obj.ERA  = obj.ERA  !== undefined && obj.ERA  !== '' ? obj.ERA  : (obj['ERA(2026)']  ?? obj['ERA 2026']  ?? '');
    obj.WHIP = obj.WHIP !== undefined && obj.WHIP !== '' ? obj.WHIP : (obj['WHIP(2026)'] ?? obj['WHIP 2026'] ?? '');
    obj.IP   = obj.IP   !== undefined && obj.IP   !== '' ? obj.IP   : (obj['IP(2026)']   ?? obj['IP 2026']   ?? '');
    obj.QS   = obj.QS   !== undefined && obj.QS   !== '' ? obj.QS   : (obj['QS(2026)']   ?? obj['QS 2026']   ?? '');
    obj.K    = obj.K    !== undefined && obj.K    !== '' ? obj.K    : (obj['K(2026)']    ?? obj['K 2026']    ?? '');
    obj.SV   = obj.SV   !== undefined && obj.SV   !== '' ? obj.SV   : (obj['SV(2026)']   ?? obj['SV 2026']   ?? '');
    obj.HLD  = obj.HLD  !== undefined && obj.HLD  !== '' ? obj.HLD  : (obj['HLD(2026)']  ?? obj['HLD 2026']  ?? '');

    // Identity
    obj.Name = String(obj.Name ?? obj.name ?? obj.player ?? obj.Player ?? '').trim();
    obj.type = String(obj.type ?? obj.Type ?? '').trim().toLowerCase();
    // Use Display Role as POS if present (your master uses this as canonical)
    obj.POS = String(obj.POS ?? obj.pos ?? obj['POS(2026)'] ?? obj['POS'] ?? obj['Display Role'] ?? obj['DisplayRole'] ?? '').trim();
    obj.Team = String(obj.Team ?? obj.team ?? obj.Tm ?? obj.tm ?? '').trim();

    normalizeType(obj);
    normalizeStats(obj);

    obj.player_key = getPlayerKey(obj);
    return obj;
  });

  // ✅ Dedupe here so UI/search/tables all operate on the same canonical set
  const dedupedPlayers = dedupeByPlayerKey(players);

  const hitters = dedupedPlayers.filter((p) => p.type === "hit");
  const pitchers = dedupedPlayers.filter((p) => ["pit", "sp", "rp"].includes(p.type));

  return { players: dedupedPlayers, hitters, pitchers };
}
