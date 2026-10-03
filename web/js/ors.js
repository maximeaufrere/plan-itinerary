// Client minimal de l'API Directions d'OpenRouteService : https://openrouteservice.org/dev/#/api-docs/v2/directions

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
  constructor(message, status) {
    super(message);
    this.name = 'OrsError';
    this.status = status;
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
 *   ascent: number | null, descent: number | null, extras: {surface?: object[], waytype?: object[]}}>}
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
    try {
      const json = await response.json();
      apiMessage = typeof json.error === 'string' ? json.error : json.error?.message;
    } catch {
      // Corps d'erreur non JSON : on garde le message générique.
    }
    throw new OrsError(describeError(response.status, apiMessage), response.status);
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
  };
}
