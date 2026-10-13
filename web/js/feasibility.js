// Critères impossibles à tenir : vérification avant le calcul (sans requête), tri des parcours trop éloignés
// des critères, et explication des causes quand aucun parcours ne convient.

import { DISTANCE_TOLERANCE, ELEVATION_PREFERENCES, gainPerKmGap } from './criteria.js';
import { formatDistance, formatElevation } from './format.js';
import { distance } from './geo.js';

/** Au-delà de cet écart à la distance visée, un parcours n'est pas proposé. */
export const DISTANCE_LIMIT = 0.15;
/** Au-delà de cet écart (m de D+ par km) à la plage de relief choisie, un parcours n'est pas proposé. */
export const RELIEF_LIMIT = 4;
/** Marge sur la limite de D+ (arrondis des altitudes) : au plus 3 %, au moins 10 m. */
const maxGainWithMargin = (maxGain) => maxGain + Math.max(10, maxGain * 0.03);

const RELIEF_NAMES = { flat: 'plat', rolling: 'vallonné', hilly: 'montagneux' };
const perKm = (route) => route.ascent / Math.max(route.distance / 1000, 0.1);
const km = (meters) => formatDistance(meters);

/**
 * Contradictions visibles avant tout calcul.
 * @returns {{ kind: string, text: string }[]}
 */
export function precheck({ start, end, criteria }) {
  const reasons = [];
  const target = criteria.distanceKm * 1000;
  const range = ELEVATION_PREFERENCES[criteria.elevation]?.gainPerKm;
  if (range && criteria.maxGain != null) {
    const minimum = range[0] * criteria.distanceKm;
    if (minimum > maxGainWithMargin(criteria.maxGain)) {
      reasons.push({
        kind: 'contradiction',
        text:
          `Un parcours ${RELIEF_NAMES[criteria.elevation]} de ${criteria.distanceKm} km monte d'au moins ${formatElevation(minimum)}, ` +
          `mais la limite de D+ est de ${formatElevation(criteria.maxGain)}. Relevez la limite, raccourcissez la distance ` +
          'ou choisissez un relief plus doux.',
      });
    }
  }
  if (criteria.shape === 'point_to_point' && start && end) {
    // La route est toujours au moins aussi longue que la ligne droite.
    const straight = distance(start, end);
    if (straight > target * (1 + DISTANCE_LIMIT)) {
      reasons.push({
        kind: 'distance',
        text:
          `L'arrivée est à ${km(straight)} à vol d'oiseau : impossible d'y aller en ${criteria.distanceKm} km. ` +
          `Choisissez au moins ${Math.ceil((straight * 1.3) / 1000)} km, ou rapprochez l'arrivée.`,
      });
    }
  }
  return reasons;
}

/** Ce qui, dans un parcours, s'écarte trop des critères : 'distance', 'maxGain', 'relief'. */
export function routeIssues(route, criteria) {
  const issues = [];
  const target = criteria.distanceKm * 1000;
  if (Math.abs(route.distance - target) / target > DISTANCE_LIMIT) issues.push('distance');
  if (route.ascent != null) {
    if (criteria.maxGain != null && route.ascent > maxGainWithMargin(criteria.maxGain)) issues.push('maxGain');
    if (gainPerKmGap(perKm(route), criteria.elevation) > RELIEF_LIMIT) issues.push('relief');
  }
  return issues;
}

/**
 * Causes, quand aucun parcours tracé ne respecte les critères : pour chaque critère, ce qu'ont donné
 * les tracés les plus proches, et quoi changer.
 * @param {object[]} candidates  tous les parcours tracés
 * @param {object} [direct]  trajet direct (A → B)
 */
export function diagnose(candidates, criteria, { direct } = {}) {
  const target = criteria.distanceKm * 1000;
  const reasons = [];
  if (direct && direct.distance > target * (1 + DISTANCE_LIMIT)) {
    return [{
      kind: 'distance',
      text:
        `Le trajet direct jusqu'à l'arrivée fait déjà ${km(direct.distance)} : impossible d'y aller en ${criteria.distanceKm} km. ` +
        `Choisissez au moins ${Math.ceil(direct.distance / 1000)} km, ou rapprochez l'arrivée.`,
    }];
  }
  if (!candidates.length) return reasons;
  const issues = candidates.map((route) => routeIssues(route, criteria));
  const failsAll = (kind) => issues.every((list) => list.includes(kind));

  if (failsAll('distance')) {
    const distances = candidates.map((r) => r.distance);
    const [low, high] = [Math.min(...distances), Math.max(...distances)];
    const shorter = high < target;
    reasons.push({
      kind: 'distance',
      text:
        `Parcours ${shorter ? 'trop court' : 'trop long'} : les chemins autour du départ ne donnent que des tracés de ` +
        `${km(low)}${high - low > 300 ? ` à ${km(high)}` : ''} pour ${criteria.distanceKm} km demandés ` +
        '(lac, relief, impasses…). Essayez une autre distance ou un autre départ.',
    });
  }
  const measured = candidates.filter((route) => route.ascent != null);
  if (measured.length && failsAll('maxGain')) {
    const least = Math.min(...measured.map((r) => r.ascent));
    reasons.push({
      kind: 'maxGain',
      text:
        `Limite de D+ trop basse pour le relief : le parcours le moins vallonné trouvé monte de ${formatElevation(least)} ` +
        `(limite : ${formatElevation(criteria.maxGain)}). Relevez la limite, raccourcissez la distance` +
        `${criteria.shape === 'loop' ? ' ou essayez un aller-retour, qui peut suivre une vallée' : ' ou changez de départ'}.`,
    });
  }
  if (measured.length && failsAll('relief')) {
    const values = measured.map(perKm);
    const range = ELEVATION_PREFERENCES[criteria.elevation].gainPerKm;
    const tooHilly = Math.min(...values) > range[1];
    const closest = tooHilly ? Math.min(...values) : Math.max(...values);
    reasons.push({
      kind: 'relief',
      text: tooHilly
        ? `Dénivelé trop fort pour un parcours ${RELIEF_NAMES[criteria.elevation]} : le moins vallonné monte de ` +
          `${Math.round(closest)} m par km (${RELIEF_NAMES[criteria.elevation]} : ${range[1]} au plus). ` +
          'Choisissez un relief plus marqué, « Libre », ou un autre départ.'
        : `Dénivelé trop faible pour un parcours ${RELIEF_NAMES[criteria.elevation]} : le plus vallonné ne monte que de ` +
          `${Math.round(closest)} m par km (${RELIEF_NAMES[criteria.elevation]} : ${range[0]} au moins). ` +
          'Choisissez un relief plus doux, « Libre », ou partez plus près des collines.',
    });
  }
  if (!reasons.length) {
    // Chaque critère est tenable séparément, mais aucun parcours ne les tient tous à la fois.
    reasons.push({
      kind: 'combination',
      text:
        'Aucun parcours ne respecte tous vos critères à la fois (distance, dénivelé, relief). ' +
        'Assouplissez l\'un d\'eux, ou générez à nouveau pour essayer d\'autres directions.',
    });
  }
  return reasons;
}
