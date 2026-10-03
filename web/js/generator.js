import { majorRoadShare, overlapRatio, surfaceShares } from './analysis.js';
import { ACTIVITIES, score } from './criteria.js';
import { cumulativeDistances, elevationGainAndLoss } from './geo.js';
import { fetchRoute as orsFetchRoute } from './ors.js';
import { DETOUR_FACTOR, detourShapes, loopShapes, outAndBackShapes, previewScore, previewShape, rankShapes } from './planner.js';
import { defaultTerrain } from './terrain.js';

/** Écart relatif à la distance visée considéré comme acceptable. */
const DISTANCE_TOLERANCE = 0.05;
/** Nombre maximal de requêtes par candidat (le quota gratuit ORS est d'environ 40 requêtes/minute). */
const MAX_ADJUSTMENTS = 2;
/** Formes de rechange essayées quand certaines ne peuvent pas être tracées. */
const SPARE_SHAPES = 3;

/**
 * Génère plusieurs itinéraires et les classe selon les critères.
 *
 * 1. On dessine de nombreuses formes de parcours (points de passage) autour du départ : voir planner.js.
 * 2. On estime leur relief avec les dalles d'altitude (sans requête OpenRouteService), et on garde
 *    les formes les plus proches des critères, dans des directions variées.
 * 3. OpenRouteService trace chaque forme retenue par les chemins ; on corrige l'échelle si la distance s'écarte.
 * 4. Les tracés obtenus sont notés précisément (distance, D+, revêtement, repassages…) et triés.
 *
 * Si aucune boucle n'a pu être tracée ainsi, on se rabat sur les boucles générées par OpenRouteService.
 *
 * @returns {Promise<{routes: object[], directIsLonger?: boolean, maxGainUnmet?: boolean}>}
 */
export async function generateRoutes({
  start,
  end,
  criteria,
  apiKey,
  signal,
  onProgress,
  onWait,
  fetchRoute = orsFetchRoute,
  terrain = defaultTerrain(),
  random = Math.random,
}) {
  const profile = ACTIVITIES[criteria.activity].profile;
  const target = criteria.distanceKm * 1000;
  const request = (points, roundTrip) => fetchRoute({ apiKey, profile, points, roundTrip, signal, onWait });
  const finish = (raw, id) => {
    const route = toRoute(raw, id);
    route.score = score(route, criteria);
    return route;
  };

  // On explore un peu plus de candidats que le nombre de propositions demandées,
  // et davantage encore quand une limite de D+ risque d'en écarter.
  const candidateCount = criteria.proposals + 1 + (criteria.maxGain != null ? 2 : 0);

  let shapes;
  if (criteria.shape === 'point_to_point') {
    onProgress?.(0, candidateCount + 1);
    const direct = await request([start, end]);
    if (direct.distance >= target * (1 - DISTANCE_TOLERANCE)) {
      // Impossible de faire plus court que le trajet direct.
      return { routes: [finish(direct, 'route-direct')], directIsLonger: true };
    }
    shapes = detourShapes(start, end, target);
  } else if (criteria.shape === 'loop') {
    shapes = loopShapes(start, target, { random });
  } else {
    shapes = outAndBackShapes(start, target, { random });
  }

  await rateShapes(shapes, criteria, terrain, signal);
  const ranked = rankShapes(shapes, candidateCount);

  const candidates = [];
  let lastError;
  // Essaie `build(0)`, `build(1)`… jusqu'à obtenir `wanted` candidats ou épuiser `attempts` essais.
  const tryCandidates = async (wanted, attempts, build) => {
    for (let index = 0; index < attempts && candidates.length < wanted; index++) {
      signal?.throwIfAborted();
      onProgress?.(candidates.length, wanted);
      try {
        candidates.push(finish(await build(index), `route-${candidates.length}`));
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (error.isFatal) {
          // Clé invalide ou quota atteint : inutile d'insister, on garde ce qu'on a déjà.
          if (candidates.length === 0) throw error;
          return false;
        }
        // Forme impossible à suivre (mer, zone sans chemin…) : on passe à la suivante.
        lastError = error;
      }
    }
    return true;
  };

  // Rapport « distance par la route / ligne droite » observé sur les premiers tracés : appliqué aux formes
  // suivantes, il leur donne d'emblée la bonne taille et évite la plupart des requêtes de correction.
  const detour = { total: 0, count: 0 };
  const traceShape = async (shape) => {
    const initialScale = detour.count ? DETOUR_FACTOR / (detour.total / detour.count) : 1;
    let lastPoints;
    const route = await adjustToTarget(
      target,
      (scale) => {
        lastPoints = shape.points(scale);
        return request(lastPoints);
      },
      initialScale,
    );
    const straight = cumulativeDistances(lastPoints).at(-1);
    if (straight > 0 && route.distance > 0) {
      detour.total += route.distance / straight;
      detour.count++;
    }
    return route;
  };

  const attempts = Math.min(ranked.length, candidateCount + SPARE_SHAPES);
  const canContinue = await tryCandidates(candidateCount, attempts, (index) => traceShape(ranked[index]));

  if (canContinue && candidates.length === 0 && criteria.shape === 'loop') {
    const baseSeed = Math.floor(random() * 10_000);
    await tryCandidates(candidateCount, candidateCount, (index) =>
      buildOrsLoop(request, start, target, { points: 3 + (index % 3), seed: baseSeed + index }),
    );
  }

  if (candidates.length === 0) {
    throw lastError ?? new Error('Aucun itinéraire trouvé autour de ce point. Essayez une autre distance ou un autre départ.');
  }
  return selectRoutes(candidates, criteria);
}

/** Note chaque forme d'après le relief estimé ; sans modèle de terrain, elles restent à égalité. */
async function rateShapes(shapes, criteria, terrain, signal) {
  if (!terrain) return;
  const outlines = shapes.map((shape) => shape.points(1));
  try {
    await terrain.load(outlines.flat(), signal);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return;
  }
  shapes.forEach((shape, index) => {
    shape.preview = previewShape(outlines[index], (point) => terrain.elevationAt(point));
    shape.previewScore = previewScore(shape.preview, criteria);
  });
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
async function adjustToTarget(target, attempt, initialScale = 1) {
  let scale = initialScale;
  let best;
  for (let i = 0; i < MAX_ADJUSTMENTS; i++) {
    const route = await attempt(scale);
    if (!best || Math.abs(route.distance - target) < Math.abs(best.distance - target)) best = route;
    if (route.distance <= 0 || Math.abs(route.distance - target) / target <= DISTANCE_TOLERANCE) break;
    scale *= target / route.distance;
  }
  return best;
}

/** Boucle générée entièrement par OpenRouteService (option `round_trip`), utilisée en secours. */
function buildOrsLoop(request, start, target, { points, seed }) {
  return adjustToTarget(target, (scale) => request([start], { length: Math.round(target * scale), points, seed }));
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
