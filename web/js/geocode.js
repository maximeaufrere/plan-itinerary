// Recherche d'adresses avec le géocodage d'OpenRouteService (même clé que les itinéraires).
// https://openrouteservice.org/dev/#/api-docs/geocode
import { OrsError } from './ors.js';

const BASE_URL = 'https://api.openrouteservice.org/geocode';

async function request(path, params, { apiKey, signal }) {
  const url = new URL(`${BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: apiKey, Accept: 'application/json' }, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new OrsError('Recherche d\'adresse impossible. Vérifiez votre connexion.', 0);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new OrsError('Clé OpenRouteService invalide.', response.status);
    if (response.status === 429) throw new OrsError('Quota de recherche d\'adresses atteint pour le moment.', 429);
    throw new OrsError(`Erreur de recherche d'adresse (${response.status}).`, response.status);
  }
  return response.json();
}

/** Convertit une réponse GeoJSON du géocodeur en résultats { label, point: [lat, lon] }. */
export function parseGeocodeResults(json) {
  return (json?.features ?? [])
    .filter((f) => Array.isArray(f?.geometry?.coordinates) && f.properties?.label)
    .map((f) => ({ label: f.properties.label, point: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
}

/**
 * Suggestions pendant la frappe, en priorité autour de `focus` (la carte affichée).
 * @returns {Promise<Array<{ label: string, point: [number, number] }>>}
 */
export async function autocomplete({ apiKey, text, focus, signal }) {
  const json = await request(
    'autocomplete',
    {
      text,
      size: 5,
      lang: 'fr',
      'focus.point.lat': focus?.[0]?.toFixed(5),
      'focus.point.lon': focus?.[1]?.toFixed(5),
    },
    { apiKey, signal },
  );
  return parseGeocodeResults(json);
}

/** Adresse la plus proche d'un point (pour afficher un point touché sur la carte). */
export async function reverse({ apiKey, point, signal }) {
  const json = await request(
    'reverse',
    { 'point.lat': point[0].toFixed(5), 'point.lon': point[1].toFixed(5), size: 1, lang: 'fr' },
    { apiKey, signal },
  );
  return parseGeocodeResults(json)[0]?.label ?? null;
}
