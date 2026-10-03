// Étiquettes des propositions : ce qui distingue chacune des autres (« La plus plate », « Vers l'est »…).

import { bearing } from './geo.js';

const DIRECTIONS = ['le nord', 'le nord-est', 'l\'est', 'le sud-est', 'le sud', 'le sud-ouest', 'l\'ouest', 'le nord-ouest'];

/** « Vers le nord-est » : direction générale du parcours vue depuis le départ. */
export function directionLabel(start, coordinates, { prefix = 'Vers' } = {}) {
  if (!start || coordinates.length < 2) return '';
  let lat = 0;
  let lon = 0;
  for (const [a, b] of coordinates) {
    lat += a;
    lon += b;
  }
  const center = [lat / coordinates.length, lon / coordinates.length];
  const index = Math.round(bearing(start, center) / 45) % 8;
  return `${prefix} ${DIRECTIONS[index]}`;
}

const perKm = (route) => (route.ascent ?? 0) / Math.max(route.distance / 1000, 0.1);

/** Caractéristiques possibles, du plus au moins pertinent selon les critères ; `value` : plus grand = meilleur. */
function candidateTags(criteria) {
  const target = criteria.distanceKm * 1000;
  const tags = {
    flat: { tag: 'La plus plate', value: (r) => (r.ascent == null ? null : -perKm(r)) },
    hilly: { tag: 'La plus vallonnée', value: (r) => (r.ascent == null ? null : perKm(r)) },
    nature: { tag: 'La plus nature', value: (r) => (r.surface && r.surface.unpaved >= 0.3 ? r.surface.unpaved : null) },
    paved: { tag: 'La plus roulante', value: (r) => (r.surface && r.surface.paved >= 0.5 ? r.surface.paved : null) },
    calm: { tag: 'La plus calme', value: (r) => (r.majorRoads == null ? null : -r.majorRoads) },
    closest: { tag: 'Au plus près', value: (r) => -Math.abs(r.distance - target) },
  };
  const order = [];
  if (criteria.elevation === 'flat' || criteria.maxGain != null) order.push('flat');
  if (criteria.elevation === 'hilly' || criteria.elevation === 'rolling') order.push('hilly');
  if (criteria.surface === 'paved') order.push('paved');
  if (criteria.surface === 'unpaved') order.push('nature');
  if (criteria.avoidMajorRoads) order.push('calm');
  order.push('closest', 'flat', 'nature', 'hilly');
  return [...new Set(order)].map((key) => tags[key]);
}

/**
 * Une étiquette par proposition : chaque caractéristique va au parcours qui l'incarne le mieux parmi tous
 * (s'il n'en a pas déjà une) ; les autres sont désignés par leur direction.
 * @returns {Map<string, {tag: string, detail: string}>}
 */
export function labelRoutes(routes, { criteria, start }) {
  const labels = new Map();
  const isPointToPoint = criteria.shape === 'point_to_point';
  const direction = (route) => directionLabel(start, route.coordinates, { prefix: isPointToPoint ? 'Détour par' : 'Vers' });

  if (routes.length > 1) {
    for (const { tag, value } of candidateTags(criteria)) {
      let best = null;
      let bestValue = -Infinity;
      for (const route of routes) {
        const v = value(route);
        if (v != null && v > bestValue) {
          best = route;
          bestValue = v;
        }
      }
      // Égalité avec un autre parcours : l'étiquette ne distinguerait rien.
      const tied = best && routes.filter((r) => r !== best && value(r) === bestValue).length > 0;
      if (best && !tied && !labels.has(best.id)) labels.set(best.id, { tag, detail: '' });
    }
  }
  for (const route of routes) {
    const label = labels.get(route.id);
    const where = direction(route);
    const surface = route.surface && route.surface.unpaved >= 0.05 ? `${Math.round(route.surface.unpaved * 100)} % de chemins` : '';
    if (!label) labels.set(route.id, { tag: where, detail: surface });
    else label.detail = label.tag === 'La plus nature' ? where : surface || where;
  }
  return labels;
}
