import { resample } from './geo.js';

// Codes « surface » d'OpenRouteService : https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/surface
const PAVED = new Set([1, 3, 4, 5, 6, 7, 14]);
const UNPAVED = new Set([2, 8, 9, 10, 11, 12, 15, 16, 17, 18]);
// Code « waytype » des routes principales (State Road).
const MAJOR_ROAD = 1;

/**
 * Part du parcours (0 à 1) qui repasse par un endroit déjà emprunté.
 * Le tracé est échantillonné tous les `spacing` mètres et projeté sur une grille de `cellSize` mètres ;
 * un échantillon compte comme repassage s'il retombe dans une case visitée nettement plus tôt.
 */
export function overlapRatio(coordinates, { spacing = 10, cellSize = 20, minGap = 150 } = {}) {
  const samples = resample(coordinates, spacing);
  if (samples.length < 3) return 0;

  const metersPerDegLat = 110_540;
  const metersPerDegLon = 111_320 * Math.cos((samples[0][0] * Math.PI) / 180);
  const minIndexGap = Math.ceil(minGap / spacing);
  const firstVisit = new Map();
  let repeated = 0;

  samples.forEach(([lat, lon], index) => {
    const key = `${Math.round((lon * metersPerDegLon) / cellSize)}:${Math.round((lat * metersPerDegLat) / cellSize)}`;
    const first = firstVisit.get(key);
    if (first === undefined) firstVisit.set(key, index);
    else if (index - first > minIndexGap) repeated++;
  });
  return repeated / samples.length;
}

/** Répartition bitume / chemins / inconnu (0 à 1) à partir du résumé « surface » d'ORS. */
export function surfaceShares(summary) {
  if (!summary?.length) return null;
  const shares = { paved: 0, unpaved: 0, unknown: 0 };
  for (const { value, amount } of summary) {
    const share = amount / 100;
    if (PAVED.has(value)) shares.paved += share;
    else if (UNPAVED.has(value)) shares.unpaved += share;
    else shares.unknown += share;
  }
  return shares;
}

/** Part du parcours (0 à 1) sur des routes principales, à partir du résumé « waytype » d'ORS. */
export function majorRoadShare(summary) {
  if (!summary?.length) return null;
  return summary.filter((item) => item.value === MAJOR_ROAD).reduce((sum, item) => sum + item.amount / 100, 0);
}
