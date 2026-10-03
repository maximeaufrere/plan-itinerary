// Client minimal de l'API Directions d'OpenRouteService : https://openrouteservice.org/dev/#/api-docs/v2/directions

import { cumulativeDistances } from './geo.js';

const BASE_URL = 'https://api.openrouteservice.org/v2/directions';

/**
 * L'offre gratuite accepte 40 itinéraires par minute. Au-delà, ORS refuse les requêtes d'une façon que
 * le navigateur prend pour une coupure réseau : on reste donc sous la limite en patientant si besoin.
 */
const RATE_LIMIT = 35;
const RATE_WINDOW = 60_000;
const recentRequests = [];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Attend qu'une requête puisse partir sans dépasser la limite ; `onWait(secondes)` prévient l'interface. */
async function waitForSlot(signal, onWait, now = Date.now) {
  for (;;) {
    while (recentRequests.length && now() - recentRequests[0] >= RATE_WINDOW) recentRequests.shift();
    if (recentRequests.length < RATE_LIMIT) break;
    const delay = RATE_WINDOW - (now() - recentRequests[0]) + 100;
    onWait?.(Math.ceil(delay / 1000));
    await sleep(delay, signal);
  }
  recentRequests.push(now());
}

export class OrsError extends Error {
  /**
   * @param {string} message
   * @param {number} status code HTTP (0 si aucune réponse lisible)
   * @param {{code?: number, coordinateIndex?: number | null}} [details] code d'erreur ORS et, pour un point
   *   impossible à rejoindre, sa position dans la liste des points envoyés
   */
  constructor(message, status, { code, coordinateIndex = null } = {}) {
    super(message);
    this.name = 'OrsError';
    this.status = status;
    this.code = code;
    this.coordinateIndex = coordinateIndex;
  }

  /** Erreur qui empêchera aussi les requêtes suivantes (réseau, clé invalide, quota atteint). */
  get isFatal() {
    return this.status === 0 || this.status === 401 || this.status === 403 || this.status === 429;
  }
}

function describeError(status, apiMessage) {
  if (status === 401 || status === 403) return 'Clé OpenRouteService invalide. Vérifiez-la dans les réglages (⚙️).';
  if (status === 429) return 'Quota OpenRouteService atteint. Réessayez dans une minute (ou demain si le quota du jour est épuisé).';
  return apiMessage ? `OpenRouteService : ${apiMessage}` : `Erreur OpenRouteService (${status}).`;
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.profile ex. "foot-walking"
 * @param {Array<[number, number]>} options.points points [lat, lon] à relier dans l'ordre
 * @param {{length: number, points: number, seed: number}} [options.roundTrip] boucle générée par ORS à partir d'un seul point
 * @param {AbortSignal} [options.signal]
 * @param {(seconds: number) => void} [options.onWait] appelé si l'on patiente pour respecter la limite par minute
 * @returns {Promise<{coordinates: Array<[number, number]>, elevations: number[] | null, distance: number,
 *   ascent: number | null, descent: number | null, extras: {surface?: object[], waytype?: object[]},
 *   wayPoints: number[] | null, extraValues: {surface?: number[][], waytype?: number[][]}}>}
 */
export async function fetchRoute({ apiKey, profile, points, roundTrip, signal, onWait }) {
  const body = {
    coordinates: points.map(([lat, lon]) => [lon, lat]),
    elevation: true,
    instructions: false,
    extra_info: ['surface', 'waytype'],
    options: { avoid_features: ['ferries'] },
  };
  if (roundTrip) body.options.round_trip = roundTrip;

  await waitForSlot(signal, onWait);
  let response;
  try {
    response = await fetch(`${BASE_URL}/${profile}/geojson`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json, application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    // Les refus de la passerelle d'ORS (clé refusée, quota du jour ou limite par minute atteints) n'ont pas
    // les en-têtes CORS : le navigateur les présente comme une coupure réseau, sans code d'erreur lisible.
    throw new OrsError(
      'OpenRouteService ne répond pas ou refuse les requêtes. Causes possibles : pas de connexion, ' +
        'clé refusée, quota du jour épuisé (2 000 itinéraires), ou plus de 40 itinéraires en une minute. ' +
        'Vérifiez votre quota sur openrouteservice.org (tableau de bord) puis réessayez dans une minute.',
      0,
    );
  }

  if (!response.ok) {
    let apiMessage;
    let code;
    try {
      const json = await response.json();
      apiMessage = typeof json.error === 'string' ? json.error : json.error?.message;
      code = json.error?.code;
    } catch {
      // Corps d'erreur non JSON : on garde le message générique.
    }
    // Ex. « Could not find routable point within a radius of 350.0 meters of specified coordinate 3: … »
    const match = /coordinate (\d+)/.exec(apiMessage ?? '');
    throw new OrsError(describeError(response.status, apiMessage), response.status, {
      code,
      coordinateIndex: match ? Number(match[1]) : null,
    });
  }

  const json = await response.json();
  const feature = json.features?.[0];
  if (!feature) throw new OrsError('Aucun itinéraire trouvé.', 404);

  const raw = feature.geometry.coordinates;
  const hasElevation = raw.length > 0 && raw.every((c) => typeof c[2] === 'number');
  return {
    coordinates: raw.map(([lon, lat]) => [lat, lon]),
    elevations: hasElevation ? raw.map((c) => c[2]) : null,
    distance: feature.properties.summary.distance,
    ascent: feature.properties.ascent ?? null,
    descent: feature.properties.descent ?? null,
    // Résumés « part du parcours par valeur » : [{ value, distance, amount (en %) }].
    extras: {
      surface: feature.properties.extras?.surface?.summary,
      waytype: feature.properties.extras?.waytype?.summary,
    },
    // Position dans le tracé de chaque point envoyé, et valeurs détaillées [début, fin, valeur] :
    // de quoi découper une requête groupée en plusieurs parcours.
    wayPoints: feature.properties.way_points ?? null,
    extraValues: {
      surface: feature.properties.extras?.surface?.values,
      waytype: feature.properties.extras?.waytype?.values,
    },
  };
}

/**
 * Découpe un itinéraire obtenu en une seule requête (plusieurs parcours enchaînés) en parcours séparés.
 * `ranges` : pour chaque parcours, positions [premier, dernier] de ses points dans la liste envoyée à ORS.
 * Les résumés de revêtement et de type de voie sont recalculés pour chaque morceau.
 */
export function splitRoute(raw, ranges) {
  if (!raw.wayPoints) throw new OrsError('Réponse OpenRouteService sans points de passage.', 500);
  const distances = cumulativeDistances(raw.coordinates);
  const scale = distances.at(-1) > 0 ? raw.distance / distances.at(-1) : 1;
  return ranges.map(([first, last]) => {
    const a = raw.wayPoints[first];
    const b = raw.wayPoints[last];
    return {
      coordinates: raw.coordinates.slice(a, b + 1),
      elevations: raw.elevations?.slice(a, b + 1) ?? null,
      distance: (distances[b] - distances[a]) * scale,
      ascent: null,
      descent: null,
      extras: {
        surface: summarize(raw.extraValues?.surface, distances, a, b),
        waytype: summarize(raw.extraValues?.waytype, distances, a, b),
      },
    };
  });
}

/** Résumé « part du parcours par valeur » ({ value, distance, amount en % }) entre les indices a et b du tracé. */
function summarize(values, distances, a, b) {
  if (!values?.length) return undefined;
  const total = distances[b] - distances[a];
  const byValue = new Map();
  for (const [from, to, value] of values) {
    const lo = Math.max(from, a);
    const hi = Math.min(to, b);
    if (hi > lo) byValue.set(value, (byValue.get(value) ?? 0) + distances[hi] - distances[lo]);
  }
  return [...byValue].map(([value, length]) => ({ value, distance: length, amount: total > 0 ? (length / total) * 100 : 0 }));
}
