// js/player-key.js
// Shared name normalization + stable player keys for cross-CSV joins.

/**
 * Normalize a display name into a join-safe string.
 * - removes accents
 * - lowercases
 * - trims
 */
export function normalizeName(str = "") {
  return String(str ?? "")
    .normalize("NFD")                 // split letters + accents
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/\./g, "")               // drop periods ("A." -> "A")
    .replace(/\s+/g, " ")             // collapse whitespace
    .toLowerCase()
    .trim();
}

/**
 * Build a stable player key.
 *
 * Preference order:
 *  1) Any explicit id fields (mlbam_id, player_id, id)
 *  2) type + normalized name
 */
export function getPlayerKey(input) {
  if (input == null) return "";

  // Allow passing a raw name string.
  if (typeof input === "string") {
    return `unk|${normalizeName(input)}`;
  }

  const id =
    input.mlbam_id ??
    input.player_id ??
    input.id ??
    input.PlayerID ??
    input.MLBAM_ID ??
    null;

  if (id != null && String(id).trim() !== "") {
    return `id|${String(id).trim()}`;
  }

  const typeRaw = String(input.type ?? input.Type ?? "unk").trim().toLowerCase();
  const type = (typeRaw === "pit" || typeRaw === "pitch" || typeRaw === "pitcher") ? "pit" : (typeRaw === "hit" || typeRaw === "hitter") ? "hit" : "unk";
  const name = String(input.Name ?? input.name ?? input.player ?? input.Player ?? "").trim();
  return `${type}|${normalizeName(name)}`;
}
