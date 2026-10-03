// Notre propre algorithme de génération : on dessine des formes de parcours (points de passage),
// on estime leur relief avec le modèle de terrain, et seules les meilleures sont tracées par OpenRouteService.

import { ELEVATION_PREFERENCES } from './criteria.js';
import { bearing, cumulativeDistances, destination, distance, elevationGainAndLoss, resample } from './geo.js';

/** Rapport moyen entre distance par la route et distance à vol d'oiseau. */
export const DETOUR_FACTOR = 1.25;
/** Espacement des altitudes lues le long d'une forme. */
const PREVIEW_SPACING = 100;

const LOOP_SHAPES = 24;
const OUT_AND_BACK_SHAPES = 16;
/** Positions (degrés) du point de détour sur l'ellipse A → B ; 0 et 180 sont dans l'axe. */
const DETOUR_ANGLES = [90, 270, 60, 300, 120, 240, 40, 320, 140, 220];

/**
 * Une forme de parcours : `heading` sert à garder des propositions variées,
 * `points(scale)` donne les points de passage, `scale` permettant d'allonger ou de raccourcir le tracé.
 * @typedef {{heading: number, points: (scale: number) => Array<[number, number]>}} Shape
 */

/**
 * Boucles : polygones irréguliers de 3 à 5 points de passage, inscrits dans un cercle qui passe par le départ.
 * Le cercle est orienté dans une direction différente pour chaque forme.
 * @returns {Shape[]}
 */
export function loopShapes(start, target, { count = LOOP_SHAPES, random = Math.random } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const heading = ((index + random()) * 360) / count;
    const waypointCount = 3 + Math.floor(random() * 3);
    const step = 360 / (waypointCount + 1);
    const waypoints = Array.from({ length: waypointCount }, (_, k) => ({
      angle: heading + 180 + step * (k + 1) + (random() - 0.5) * step * 0.5,
      radius: 0.75 + random() * 0.5,
    }));

    const at = (radius) => {
      const center = destination(start, radius, heading);
      return [start, ...waypoints.map((w) => destination(center, radius * w.radius, w.angle)), start];
    };
    // Rayon tel que le polygone, une fois suivi par les routes, fasse la distance visée.
    const unit = 1000;
    const radius = (unit * target) / (DETOUR_FACTOR * cumulativeDistances(at(unit)).at(-1));
    return { heading, points: (scale) => at(radius * scale) };
  });
}

/** Allers-retours : un point de demi-tour dans chaque direction. */
export function outAndBackShapes(start, target, { count = OUT_AND_BACK_SHAPES, random = Math.random } = {}) {
  const offset = random() * 360;
  const radius = target / 2 / DETOUR_FACTOR;
  return Array.from({ length: count }, (_, index) => {
    const heading = (offset + (index * 360) / count) % 360;
    return { heading, points: (scale) => [start, destination(start, radius * scale, heading), start] };
  });
}

/**
 * A → B plus long que le trajet direct : un point de détour placé sur une ellipse dont A et B sont les foyers
 * (toutes ses positions donnent la même distance à vol d'oiseau).
 */
export function detourShapes(start, end, target) {
  const straight = distance(start, end);
  const axis = bearing(start, end);
  const center = destination(start, straight / 2, axis);
  const minSemiMajor = (straight / 2) * 1.05;
  return DETOUR_ANGLES.map((angle) => ({
    heading: angle,
    points: (scale) => {
      // Ellipse de foyers A et B : |AW| + |WB| = 2a pour tout point W.
      const a = Math.max((target / (2 * DETOUR_FACTOR)) * scale, minSemiMajor);
      const b = Math.sqrt(a * a - (straight / 2) ** 2);
      const theta = (angle * Math.PI) / 180;
      const alongAxis = destination(center, a * Math.cos(theta), axis);
      return [start, destination(alongAxis, b * Math.sin(theta), axis + 90), end];
    },
  }));
}

/**
 * Relief estimé d'une forme, en ligne droite entre ses points de passage.
 * @returns {{gain: number | null, length: number, inWater: boolean}}
 */
export function previewShape(points, elevationAt) {
  const length = cumulativeDistances(points).at(-1);
  const samples = [...resample(points, PREVIEW_SPACING), points.at(-1)];
  const elevations = samples.map(elevationAt).filter((value) => value != null);
  // Les dalles Terrarium donnent la bathymétrie : un point de passage sous le niveau de la mer est en mer.
  const inWater = points.slice(1, -1).some((point) => (elevationAt(point) ?? 0) < -2);
  const gain = elevations.length >= samples.length / 2 ? elevationGainAndLoss(elevations, 5).gain : null;
  return { gain, length, inWater };
}

/** Plus le score est bas, plus la forme semble correspondre aux critères de relief. */
export function previewScore({ gain, length, inWater }, criteria) {
  let result = inWater ? 1000 : 0;
  if (gain == null) return result;
  // Les routes sont plus longues que la ligne droite : le D+ réel suit à peu près cette proportion.
  const estimated = gain * DETOUR_FACTOR;
  const targetGainPerKm = ELEVATION_PREFERENCES[criteria.elevation].gainPerKm;
  if (targetGainPerKm != null) {
    result += Math.abs(gain / Math.max(length / 1000, 0.1) - targetGainPerKm) * 2;
  }
  if (criteria.maxGain != null) {
    result += Math.max(0, estimated - criteria.maxGain * 0.8) / 5;
  }
  return result;
}

const angleBetween = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Écart de note jusqu'auquel on préfère une direction différente à une forme mieux notée. */
const SCORE_SLACK = 15;

/**
 * Classe toutes les formes : d'abord `count` formes parmi les mieux notées, dans des directions assez
 * différentes pour que les propositions soient variées, puis toutes les autres (formes de rechange).
 * La variété ne passe jamais devant une forme nettement mieux notée.
 */
export function rankShapes(shapes, count) {
  const sorted = [...shapes].sort((a, b) => (a.previewScore ?? 0) - (b.previewScore ?? 0));
  const best = sorted[0]?.previewScore ?? 0;
  const picked = [];
  const passes = [
    { gap: 360 / (count * 2), slack: SCORE_SLACK },
    { gap: 360 / (count * 4), slack: SCORE_SLACK },
    { gap: 0, slack: Infinity },
  ];
  for (const { gap, slack } of passes) {
    for (const shape of sorted) {
      if (picked.length >= count) break;
      if (picked.includes(shape) || (shape.previewScore ?? 0) > best + slack) continue;
      if (picked.every((other) => angleBetween(other.heading, shape.heading) >= gap)) picked.push(shape);
    }
  }
  return [...picked, ...sorted.filter((shape) => !picked.includes(shape))];
}
