import { majorRoadShare, overlapRatio, surfaceShares } from './analysis.js';
import { ACTIVITIES, score } from './criteria.js';
import { cumulativeDistances, elevationGainAndLoss } from './geo.js';
import { fetchRoute as orsFetchRoute, splitRoute } from './ors.js';
import { DETOUR_FACTOR, detourShapes, loopShapes, outAndBackShapes, previewScore, previewShape, rankShapes } from './planner.js';
import { defaultTerrain } from './terrain.js';

/** Écart relatif à la distance visée considéré comme acceptable (au-delà, on corrige l'échelle une fois). */
const DISTANCE_TOLERANCE = 0.1;
/** Nombre maximal de requêtes pour une boucle de secours générée par ORS. */
const MAX_ADJUSTMENTS = 2;
/** Formes de rechange essayées quand certaines ne peuvent pas être tracées. */
const SPARE_SHAPES = 3;
/** Distance routière estimée maximale d'une requête groupée (ORS limite la longueur d'un itinéraire). */
const BATCH_MAX_DISTANCE = 90_000;
/** ORS accepte au plus 50 points par requête. */
const BATCH_MAX_POINTS = 50;
/** Tours de requêtes au plus : premier tracé, correction d'échelle, reprises après une erreur. */
const MAX_ROUNDS = 4;

/**
 * Mémoire de la dernière génération : « Générer à nouveau » avec les mêmes critères propose d'abord
 * les parcours déjà tracés mais pas affichés, puis les formes suivantes du classement, sans tout recalculer.
 */
let session = null;
let nextRouteId = 0;

/** Oublie la génération précédente (tests). */
export function resetSession() {
  session = null;
}

/**
 * Génère plusieurs itinéraires et les classe selon les critères.
 *
 * 1. On dessine de nombreuses formes de parcours (points de passage) autour du départ : voir planner.js.
 * 2. On estime leur relief avec les dalles d'altitude (sans requête OpenRouteService), et on garde
 *    les formes les plus proches des critères, dans des directions variées.
 * 3. OpenRouteService trace les formes retenues, plusieurs à la fois dans une même requête ; celles dont
 *    la distance s'écarte trop sont recorrigées ensemble dans une requête suivante.
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
  onPhase,
  onWait,
  fetchRoute = orsFetchRoute,
  terrain = defaultTerrain(),
  random = Math.random,
}) {
  const profile = ACTIVITIES[criteria.activity].profile;
  const target = criteria.distanceKm * 1000;
  const request = (points, roundTrip) => fetchRoute({ apiKey, profile, points, roundTrip, signal, onWait });
  const finish = (raw) => {
    const route = toRoute(raw, `route-${nextRouteId++}`);
    route.score = score(route, criteria);
    return route;
  };

  // On trace un peu plus de candidats que le nombre de propositions demandées,
  // et davantage encore quand une limite de D+ risque d'en écarter.
  const candidateCount = criteria.proposals + 1 + (criteria.maxGain != null ? 2 : 0);
  const key = sessionKey(start, end, criteria);
  const previous = session?.key === key ? session : null;
  session = null;

  let direct = previous?.direct ?? null;
  if (criteria.shape === 'point_to_point' && !direct) {
    onProgress?.(0, candidateCount);
    direct = await request([start, end]);
  }
  if (direct && direct.distance >= target * (1 - DISTANCE_TOLERANCE)) {
    // Impossible de faire plus court que le trajet direct.
    return { routes: [finish(direct)], directIsLonger: true };
  }

  let pool = [];
  let ranked;
  let reused = false;
  if (previous && previous.leftovers.length + previous.remaining.length >= criteria.proposals) {
    reused = true;
    pool = previous.leftovers;
    ranked = previous.remaining;
  } else {
    let shapes;
    if (criteria.shape === 'point_to_point') shapes = detourShapes(start, end, target);
    else if (criteria.shape === 'loop') shapes = loopShapes(start, target, { random });
    else shapes = outAndBackShapes(start, target, { random });
    await rateShapes(shapes, criteria, terrain, signal);
    ranked = rankShapes(shapes, candidateCount);
  }
  const wanted = Math.max(0, candidateCount - pool.length);
  onPhase?.('relief', { studied: ranked.length, reused });
  onPhase?.('trace', { outlines: ranked.slice(0, wanted).map((shape) => shape.points(1)) });

  const traced = await traceShapes({
    ranked,
    wanted,
    target,
    request,
    ratio: previous?.ratio ?? null,
    signal,
    onProgress: (done, total) => onProgress?.(done + pool.length, total + pool.length),
  });
  const candidates = [...pool, ...traced.routes.map(finish)];

  if (!traced.fatal && candidates.length === 0 && criteria.shape === 'loop') {
    const baseSeed = Math.floor(random() * 10_000);
    for (let index = 0; index < candidateCount && candidates.length < criteria.proposals; index++) {
      onProgress?.(candidates.length, candidateCount);
      try {
        candidates.push(finish(await buildOrsLoop(request, start, target, { points: 3 + (index % 3), seed: baseSeed + index })));
      } catch (error) {
        if (error.name === 'AbortError' || error.isFatal) throw error;
      }
    }
  }

  if (candidates.length === 0) {
    throw traced.fatal ?? traced.lastError ?? new Error('Aucun itinéraire trouvé autour de ce point. Essayez une autre distance ou un autre départ.');
  }
  onPhase?.('rank');
  const result = selectRoutes(candidates, criteria);
  session = {
    key,
    direct,
    ratio: traced.ratio,
    remaining: traced.remaining,
    leftovers: candidates.filter((route) => !result.routes.includes(route)),
  };
  return result;
}

/** Ce qui doit être identique pour réutiliser la génération précédente. */
function sessionKey(start, end, criteria) {
  const round = (point) => point?.map((value) => value.toFixed(5)).join(',');
  const { activity, shape, distanceKm, elevation, maxGain, surface, avoidMajorRoads } = criteria;
  return JSON.stringify([round(start), round(end), activity, shape, distanceKm, elevation, maxGain, surface, avoidMajorRoads]);
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

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Trace les `wanted` premières formes du classement, en regroupant plusieurs formes par requête.
 *
 * Chaque « tâche » est une forme à une échelle donnée. À chaque tour, les tâches sont regroupées en requêtes ;
 * les parcours trop éloignés de la distance visée repartent au tour suivant avec une échelle corrigée (une fois),
 * les formes impossibles à tracer sont remplacées par des formes de rechange.
 *
 * @returns {Promise<{routes: object[], ratio: number | null, remaining: object[], fatal?: Error, lastError?: Error}>}
 */
async function traceShapes({ ranked, wanted, target, request, ratio, signal, onProgress }) {
  const routes = [];
  // Rapport « distance par la route / ligne droite » observé : il donne aux formes suivantes la bonne taille.
  const observed = { total: ratio ?? 0, count: ratio ? 1 : 0 };
  const defaultScale = () => (observed.count ? DETOUR_FACTOR / (observed.total / observed.count) : 1);

  let nextShape = Math.min(wanted, ranked.length);
  const spareLimit = Math.min(ranked.length, wanted + SPARE_SHAPES);
  const takeSpare = (jobs) => {
    if (nextShape < spareLimit) jobs.push({ shape: ranked[nextShape++] });
  };

  let queue = ranked.slice(0, nextShape).map((shape) => ({ shape }));
  let lastError;
  let fatal;

  for (let round = 0; round < MAX_ROUNDS && queue.length; round++) {
    const retry = [];
    for (const batch of makeBatches(queue, target, defaultScale)) {
      signal?.throwIfAborted();
      onProgress?.(routes.length, wanted);
      const { points, ranges } = assemble(batch);
      let pieces;
      try {
        const raw = await request(points);
        pieces = batch.length === 1 && ranges[0][0] === 0 && ranges[0][1] === points.length - 1 ? [raw] : splitRoute(raw, ranges);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        // Une réponse illisible (status 0) peut venir d'un refus de la requête groupée elle-même :
        // on retente alors ses formes une par une avant de conclure à une panne ou un quota épuisé.
        const groupedRefusal = error.status === 0 && batch.length > 1;
        if (error.isFatal && !groupedRefusal) {
          // Clé refusée ou quota atteint : inutile d'insister, on garde ce qu'on a déjà.
          fatal = error;
          break;
        }
        lastError = error;
        const culprit = error.coordinateIndex != null
          ? batch.findIndex((_, i) => error.coordinateIndex >= ranges[i][0] && error.coordinateIndex <= ranges[i][1])
          : -1;
        batch.forEach((job, i) => {
          if (i === culprit || batch.length === 1) {
            // Forme impossible à suivre (lac, zone sans chemin…) : une forme de rechange prend sa place.
            if (job.best) routes.push(job.best);
            else takeSpare(retry);
          } else {
            // Erreur sans coupable identifié (requête trop longue…) : on retente ces formes une par une.
            retry.push({ ...job, solo: culprit < 0 });
          }
        });
        continue;
      }

      batch.forEach((job, i) => {
        const piece = pieces[i];
        const straight = cumulativeDistances(job.points).at(-1);
        if (straight > 0 && piece.distance > 0) {
          observed.total += piece.distance / straight;
          observed.count++;
        }
        const best = !job.best || Math.abs(piece.distance - target) < Math.abs(job.best.distance - target) ? piece : job.best;
        const offBy = Math.abs(piece.distance - target) / target;
        if (offBy <= DISTANCE_TOLERANCE || job.corrected || piece.distance <= 0) routes.push(best);
        else retry.push({ shape: job.shape, scale: job.scale * (target / piece.distance), corrected: true, best });
      });
    }
    if (fatal) break;
    queue = retry;
  }
  // Tâches encore en attente après le dernier tour : on garde leur meilleur essai.
  for (const job of queue) if (job.best && !fatal) routes.push(job.best);

  if (fatal && routes.length === 0) throw fatal;
  return {
    routes,
    ratio: observed.count ? observed.total / observed.count : null,
    remaining: ranked.slice(nextShape),
    fatal,
    lastError,
  };
}

/** Regroupe les tâches en requêtes, sans dépasser la longueur ni le nombre de points acceptés par ORS. */
function makeBatches(jobs, target, defaultScale) {
  const batches = [];
  let current = [];
  let length = 0;
  let pointCount = 0;
  for (const job of jobs) {
    job.scale ??= defaultScale();
    job.points = job.shape.points(job.scale);
    // Parcours + liaison éventuelle depuis la fin du parcours précédent (A → B : de B vers A).
    const jobLength = target + (current.length ? cumulativeDistances([current.at(-1).points.at(-1), job.points[0]]).at(-1) * DETOUR_FACTOR : 0);
    const fits = !job.solo && current.length > 0 && !current[0].solo
      && length + jobLength <= BATCH_MAX_DISTANCE && pointCount + job.points.length <= BATCH_MAX_POINTS;
    if (current.length && !fits) {
      batches.push(current);
      current = [];
      length = 0;
      pointCount = 0;
    }
    current.push(job);
    length += current.length === 1 ? target : jobLength;
    pointCount += job.points.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Points envoyés pour un groupe de tâches, et positions [premier, dernier] de chaque parcours dans cette liste. */
function assemble(batch) {
  const points = [];
  const ranges = [];
  for (const job of batch) {
    const shared = points.length > 0 && samePoint(points.at(-1), job.points[0]);
    const first = shared ? points.length - 1 : points.length;
    points.push(...(shared ? job.points.slice(1) : job.points));
    ranges.push([first, points.length - 1]);
  }
  return { points, ranges };
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
