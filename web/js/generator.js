import { majorRoadShare, overlapRatio, surfaceShares } from './analysis.js';
import { ACTIVITIES, score } from './criteria.js';
import { bearing, cumulativeDistances, destination, distance, elevationGainAndLoss } from './geo.js';
import { fetchRoute as orsFetchRoute } from './ors.js';

/** Écart relatif à la distance visée considéré comme acceptable. */
const DISTANCE_TOLERANCE = 0.05;
/** Nombre maximal de requêtes par candidat (le quota gratuit ORS est d'environ 40 requêtes/minute). */
const MAX_ADJUSTMENTS = 2;
/** Rapport moyen entre distance par la route et distance à vol d'oiseau. */
const DETOUR_FACTOR = 1.25;
/** Positions (degrés) du point de détour sur l'ellipse A → B, en alternant les deux côtés. */
const DETOUR_ANGLES = [90, 270, 60, 300, 120, 240];

/**
 * Génère plusieurs itinéraires et les classe selon les critères.
 *
 * - Boucle : OpenRouteService sait générer une boucle d'une longueur donnée (option `round_trip`) ;
 *   chaque candidat utilise une graine différente, et on corrige la longueur demandée si l'écart est trop grand.
 * - Aller-retour : on vise un point dans une direction donnée, puis on corrige son éloignement.
 * - A → B : si le trajet direct est plus court que la distance visée, on passe par un point de détour
 *   placé sur une ellipse dont A et B sont les foyers (toutes les positions donnent la même distance à vol d'oiseau).
 *
 * @returns {Promise<{routes: object[], directIsLonger?: boolean}>}
 */
export async function generateRoutes({ start, end, criteria, apiKey, signal, onProgress, fetchRoute = orsFetchRoute }) {
  const profile = ACTIVITIES[criteria.activity].profile;
  const target = criteria.distanceKm * 1000;
  const request = (points, roundTrip) => fetchRoute({ apiKey, profile, points, roundTrip, signal });
  const finish = (raw, id) => {
    const route = toRoute(raw, id);
    route.score = score(route, criteria);
    return route;
  };

  let buildCandidate;
  // On explore un peu plus de candidats que le nombre de propositions demandées,
  // et davantage encore quand une limite de D+ risque d'en écarter.
  let candidateCount = criteria.proposals + 1 + (criteria.maxGain != null ? 2 : 0);

  if (criteria.shape === 'point_to_point') {
    onProgress?.(0, candidateCount + 1);
    const direct = await request([start, end]);
    if (direct.distance >= target * (1 - DISTANCE_TOLERANCE)) {
      // Impossible de faire plus court que le trajet direct.
      return { routes: [finish(direct, 'route-direct')], directIsLonger: true };
    }
    const straight = distance(start, end);
    candidateCount = Math.min(candidateCount, DETOUR_ANGLES.length);
    buildCandidate = (index) => buildDetour(request, start, end, target, straight, DETOUR_ANGLES[index]);
  } else if (criteria.shape === 'loop') {
    const baseSeed = Math.floor(Math.random() * 10_000);
    buildCandidate = (index) => buildLoop(request, start, target, { points: 3 + (index % 3), seed: baseSeed + index });
  } else {
    const baseBearing = Math.random() * 360;
    buildCandidate = (index) => buildOutAndBack(request, start, target, baseBearing + (index * 360) / candidateCount);
  }

  const candidates = [];
  let lastError;
  for (let index = 0; index < candidateCount; index++) {
    signal?.throwIfAborted();
    onProgress?.(index, candidateCount);
    try {
      candidates.push(finish(await buildCandidate(index), `route-${index}`));
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.isFatal) {
        // Clé invalide ou quota atteint : inutile d'insister, on garde ce qu'on a déjà.
        if (candidates.length === 0) throw error;
        break;
      }
      // Direction impossible (mer, zone sans chemin…) : on passe au candidat suivant.
      lastError = error;
    }
  }

  if (candidates.length === 0) {
    throw lastError ?? new Error('Aucun itinéraire trouvé autour de ce point. Essayez une autre distance ou un autre départ.');
  }
  return selectRoutes(candidates, criteria);
}

/**
 * Garde les meilleurs candidats. Avec une limite de D+, ceux qui la dépassent sont écartés ;
 * si aucun ne la respecte, on garde les moins vallonnés et on le signale.
 * @returns {{ routes: object[], maxGainUnmet?: boolean, overMaxGain?: number }}
 */
export function selectRoutes(candidates, criteria) {
  const sorted = [...candidates].sort((a, b) => a.score - b.score);
  if (criteria.maxGain == null) return { routes: sorted.slice(0, criteria.proposals) };

  for (const route of sorted) route.overMaxGain = route.ascent != null && route.ascent > criteria.maxGain;
  const within = sorted.filter((route) => !route.overMaxGain);
  if (within.length) {
    return { routes: within.slice(0, criteria.proposals), overMaxGain: sorted.length - within.length };
  }
  const leastHilly = [...sorted].sort((a, b) => a.ascent - b.ascent);
  return { routes: leastHilly.slice(0, criteria.proposals), maxGainUnmet: true };
}

/** Répète `attempt(scale)` en corrigeant l'échelle selon l'écart à la distance visée ; garde le meilleur essai. */
async function adjustToTarget(target, attempt) {
  let scale = 1;
  let best;
  for (let i = 0; i < MAX_ADJUSTMENTS; i++) {
    const route = await attempt(scale);
    if (!best || Math.abs(route.distance - target) < Math.abs(best.distance - target)) best = route;
    if (route.distance <= 0 || Math.abs(route.distance - target) / target <= DISTANCE_TOLERANCE) break;
    scale *= target / route.distance;
  }
  return best;
}

function buildLoop(request, start, target, { points, seed }) {
  return adjustToTarget(target, (scale) => request([start], { length: Math.round(target * scale), points, seed }));
}

function buildOutAndBack(request, start, target, heading) {
  const radius = target / 2 / DETOUR_FACTOR;
  return adjustToTarget(target, (scale) => request([start, destination(start, radius * scale, heading), start]));
}

function buildDetour(request, start, end, target, straight, angle) {
  const axis = bearing(start, end);
  const center = destination(start, straight / 2, axis);
  const minSemiMajor = (straight / 2) * 1.05;
  return adjustToTarget(target, (scale) => {
    // Ellipse de foyers A et B : |AW| + |WB| = 2a pour tout point W.
    const a = Math.max((target / (2 * DETOUR_FACTOR)) * scale, minSemiMajor);
    const b = Math.sqrt(a * a - (straight / 2) ** 2);
    const theta = (angle * Math.PI) / 180;
    const alongAxis = destination(center, a * Math.cos(theta), axis);
    const waypoint = destination(alongAxis, b * Math.sin(theta), axis + 90);
    return request([start, waypoint, end]);
  });
}

function toRoute(raw, id) {
  const route = {
    id,
    coordinates: raw.coordinates,
    distance: raw.distance,
    ascent: raw.ascent,
    descent: raw.descent,
    profile: [],
    minAltitude: null,
    maxAltitude: null,
    overlap: overlapRatio(raw.coordinates),
    surface: surfaceShares(raw.extras?.surface),
    majorRoads: majorRoadShare(raw.extras?.waytype),
  };

  if (raw.elevations) {
    // Distances le long du tracé, recalées sur la distance officielle de l'itinéraire.
    const distances = cumulativeDistances(raw.coordinates);
    const scale = distances.at(-1) > 0 ? raw.distance / distances.at(-1) : 1;
    route.profile = raw.elevations.map((elevation, i) => ({ distance: distances[i] * scale, elevation }));
    // Calcul homogène du dénivelé, quel que soit le profil ORS utilisé.
    const { gain, loss } = elevationGainAndLoss(raw.elevations);
    route.ascent = gain;
    route.descent = loss;
    route.minAltitude = Math.min(...raw.elevations);
    route.maxAltitude = Math.max(...raw.elevations);
  }
  return route;
}
