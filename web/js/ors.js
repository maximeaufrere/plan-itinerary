// Client minimal de l'API Directions d'OpenRouteService : https://openrouteservice.org/dev/#/api-docs/v2/directions

const BASE_URL = 'https://api.openrouteservice.org/v2/directions';

export class OrsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OrsError';
    this.status = status;
  }

  /** Erreur qui empêchera aussi les requêtes suivantes (clé invalide, quota atteint). */
  get isFatal() {
    return this.status === 401 || this.status === 403 || this.status === 429;
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
 * @returns {Promise<{coordinates: Array<[number, number]>, elevations: number[] | null, distance: number,
 *   ascent: number | null, descent: number | null, extras: {surface?: object[], waytype?: object[]}}>}
 */
export async function fetchRoute({ apiKey, profile, points, roundTrip, signal }) {
  const body = {
    coordinates: points.map(([lat, lon]) => [lon, lat]),
    elevation: true,
    instructions: false,
    extra_info: ['surface', 'waytype'],
    options: { avoid_features: ['ferries'] },
  };
  if (roundTrip) body.options.round_trip = roundTrip;

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
    throw new OrsError('Impossible de joindre OpenRouteService. Vérifiez votre connexion.', 0);
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
