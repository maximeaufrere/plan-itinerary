// Coordonnées internes : [latitude, longitude] (ordre Leaflet).

export const EARTH_RADIUS = 6_371_000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Distance en mètres entre deux points (formule de haversine). */
export function distance([lat1, lon1], [lat2, lon2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point atteint en partant de `origin` sur `dist` mètres au cap `bearing` (degrés, 0 = nord). */
export function destination([lat, lon], dist, bearing) {
  const delta = dist / EARTH_RADIUS;
  const theta = toRad(bearing);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
  return [toDeg(phi2), ((toDeg(lambda2) + 540) % 360) - 180];
}

/** Distances cumulées depuis le premier point. */
export function cumulativeDistances(points) {
  const result = [0];
  for (let i = 1; i < points.length; i++) {
    result.push(result[i - 1] + distance(points[i - 1], points[i]));
  }
  return result;
}

/** Dénivelés positif et négatif, avec un seuil d'hystérésis pour filtrer le bruit des altitudes. */
export function elevationGainAndLoss(altitudes, threshold = 3) {
  if (altitudes.length === 0) return { gain: 0, loss: 0 };
  let reference = altitudes[0];
  let gain = 0;
  let loss = 0;
  for (const altitude of altitudes.slice(1)) {
    const delta = altitude - reference;
    if (delta >= threshold) {
      gain += delta;
      reference = altitude;
    } else if (delta <= -threshold) {
      loss -= delta;
      reference = altitude;
    }
  }
  return { gain, loss };
}

/** Réduit un tableau à `max` éléments au plus, en gardant le premier et le dernier. */
export function downsample(items, max) {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

/** Cap initial (degrés, 0 = nord) pour aller de `a` vers `b`. */
export function bearing([lat1, lon1], [lat2, lon2]) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Ré-échantillonne une polyligne en points espacés de `spacing` mètres. */
export function resample(points, spacing) {
  if (points.length === 0) return [];
  const samples = [points[0]];
  let travelled = 0;
  let next = spacing;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const segment = distance(a, b);
    if (segment === 0) continue;
    while (travelled + segment >= next) {
      const t = (next - travelled) / segment;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      next += spacing;
    }
    travelled += segment;
  }
  return samples;
}

/**
 * Point situé à `target` mètres du début d'une polyligne, et cap suivi à cet endroit.
 * `cumulative` : distances cumulées des points (cumulativeDistances), à passer pour éviter de les recalculer.
 */
export function pointAtDistance(points, target, cumulative = cumulativeDistances(points)) {
  if (points.length === 0) return null;
  const total = cumulative.at(-1);
  const goal = Math.max(0, Math.min(target, total));
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= goal) lo = mid;
    else hi = mid;
  }
  const [a, b] = [points[lo], points[hi] ?? points[lo]];
  const span = cumulative[hi] - cumulative[lo];
  const t = span > 0 ? (goal - cumulative[lo]) / span : 0;
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    bearing: span > 0 ? bearing(a, b) : 0,
    index: lo,
  };
}

/**
 * Points régulièrement espacés le long d'un tracé (repères kilométriques, flèches de sens).
 * `length` : longueur officielle du parcours, les distances du tracé y sont recalées.
 * @returns {Array<{distance: number, point: [number, number], bearing: number}>}
 */
export function pointsAlong(points, length, interval, { offset = interval } = {}) {
  if (points.length < 2 || !(interval > 0)) return [];
  const cumulative = cumulativeDistances(points);
  const scale = cumulative.at(-1) > 0 ? length / cumulative.at(-1) : 1;
  const result = [];
  // Le cap est mesuré entre deux points situés de part et d'autre (±60 m) : les petits zigzags du tracé
  // (angles de rue) ne font pas pointer les flèches de travers.
  const span = Math.min(60, interval / scale / 4);
  for (let distance = offset; distance < length - interval * 0.25; distance += interval) {
    const at = distance / scale;
    const found = pointAtDistance(points, at, cumulative);
    if (!found) continue;
    const before = pointAtDistance(points, at - span, cumulative).point;
    const after = pointAtDistance(points, at + span, cumulative).point;
    const smoothed = before[0] === after[0] && before[1] === after[1] ? found.bearing : bearing(before, after);
    result.push({ distance, point: found.point, bearing: smoothed });
  }
  return result;
}
