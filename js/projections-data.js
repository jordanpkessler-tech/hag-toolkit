// js/projections-data.js
// Responsible ONLY for loading + parsing the CSV

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
  obj.POS = String(obj.POS ?? obj.pos ?? obj.Pos ?? "").trim();

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
  obj.PA  = pick("PA", "pa");
  obj.AVG = pick("AVG", "avg");
  obj.OPS = pick("OPS", "ops");
  obj.TB  = pick("TB", "tb", "total_bases", "TotalBases");
  obj.HR  = pick("HR", "hr");
  obj.RBI = pick("RBI", "rbi");
  obj.R   = pick("R", "r", "runs", "Runs");
  obj.SB  = pick("SB", "sb", "sbn", "stolen_bases", "StolenBases");

  // ---- Pitchers (UI expects these exact keys) ----
  obj.ERA  = pick("ERA", "era");
  obj.WHIP = pick("WHIP", "whip");
  obj.IP   = pick("IP", "ip", "innings_pitched", "InningsPitched");
  obj.QS   = pick("QS", "qs", "quality_starts", "QualityStarts");
  obj.K    = pick("K", "k", "SO", "so", "strikeouts", "Strikeouts");
  obj.SV   = pick("SV", "sv", "saves", "Saves");
  obj.HLD  = pick("HLD", "hld", "holds", "Holds");

  return obj;
}

export async function loadPlayers() {
  const res = await fetch("./data/hit_pit_2026.csv");
  if (!res.ok) {
    throw new Error(`Failed to load CSV: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  // Split lines safely across OSes
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { players: [], hitters: [], pitchers: [] };
  }

  // Trim headers to avoid "type " vs "type" bugs
  const headers = lines[0].split(",").map((h) => h.trim());

  const players = lines.slice(1).map((line) => {
    const values = line.split(",");
    const obj = {};

    headers.forEach((h, i) => {
      obj[h] = toNumberMaybe(values[i]);
    });

    normalizeType(obj);
    normalizeStats(obj);
    return obj;
  });

  const hitters = players.filter((p) => p.type === "hit");
  const pitchers = players.filter((p) => ["pit", "sp", "rp"].includes(p.type));

  return { players, hitters, pitchers };
}
