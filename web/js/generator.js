import { ACTIVITIES, score } from './criteria.js';
import { cumulativeDistances, destination, elevationGainAndLoss } from './geo.js';
import { fetchRoute as orsFetchRoute } from './ors.js';

/** Écart relatif à la distance visée considéré comme acceptable. */
const DISTANCE_TOLERANCE = 0.05;
/** Nombre maximal de requêtes par candidat (le quota gratuit ORS est d'environ 40 requêtes/minute). */
const MAX_ADJUSTMENTS = 2;
/** Rapport moyen entre distance par la route et distance à vol d'oiseau (aller-retour). */
const DETOUR_FACTOR = 1.25;

/**
 * Génère plusieurs itinéraires et les classe selon les critères.
 *
 * - Boucle : OpenRouteService sait générer une boucle d'une longueur donnée (option `round_trip`) ;
 *   chaque candidat utilise une graine différente, et on corrige la longueur demandée si l'écart est trop grand.
 * - Aller-retour : on vise un point dans une direction donnée, puis on corrige son éloignement.
 */
export async function generateRoutes({ start, criteria, apiKey, signal, onProgress, fetchRoute = orsFetchRoute }) {
  const profile = ACTIVITIES[criteria.activity].profile;
  const target = criteria.distanceKm * 1000;
  // On explore un peu plus de candidats que le nombre de propositions demandées.
  const candidateCount = criteria.proposals + 1;
  const baseSeed = Math.floor(Math.random() * 10_000);
  const baseBearing = Math.random() * 360;

  const candidates = [];
  let lastError;

  for (let index = 0; index < candidateCount; index++) {
    signal?.throwIfAborted();
    onProgress?.(index, candidateCount);

    const request = (points, roundTrip) => fetchRoute({ apiKey, profile, points, roundTrip, signal });
    try {
      const raw =
        criteria.shape === 'loop'
          ? await buildLoop(request, start, target, { points: 3 + (index % 3), seed: baseSeed + index })
          : await buildOutAndBack(request, start, target, baseBearing + (index * 360) / candidateCount);
      const route = toRoute(raw, `route-${index}`);
      route.score = score(route, criteria);
      candidates.push(route);
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
  return candidates.sort((a, b) => a.score - b.score).slice(0, criteria.proposals);
}

async function buildLoop(request, start, target, { points, seed }) {
  let length = target;
  let best;
  for (let attempt = 0; attempt < MAX_ADJUSTMENTS; attempt++) {
    const route = await request([start], { length: Math.round(length), points, seed });
    if (!best || Math.abs(route.distance - target) < Math.abs(best.distance - target)) best = route;
    if (route.distance <= 0 || Math.abs(route.distance - target) / target <= DISTANCE_TOLERANCE) break;
    length *= target / route.distance;
  }
  return best;
}

async function buildOutAndBack(request, start, target, bearing) {
  let radius = target / 2 / DETOUR_FACTOR;
  let best;
  for (let attempt = 0; attempt < MAX_ADJUSTMENTS; attempt++) {
    const turnaround = destination(start, radius, bearing);
    const route = await request([start, turnaround, start]);
    if (!best || Math.abs(route.distance - target) < Math.abs(best.distance - target)) best = route;
    if (route.distance <= 0 || Math.abs(route.distance - target) / target <= DISTANCE_TOLERANCE) break;
    radius *= target / route.distance;
  }
  return best;
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
