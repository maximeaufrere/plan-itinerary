// Recherche d'adresses.
// 1. Géocodage d'OpenRouteService (même clé que les itinéraires) : https://openrouteservice.org/dev/#/api-docs/geocode
// 2. Secours si OpenRouteService est injoignable ou refuse : Photon (Komoot, données OpenStreetMap, sans clé) :
//    https://photon.komoot.io
// Les requêtes sont « simples » (clé dans l'adresse, aucun en-tête personnalisé) : le navigateur n'a pas
// besoin de demander d'autorisation préalable (CORS) au serveur.
import { OrsError } from './ors.js';

const ORS_URL = 'https://api.openrouteservice.org/geocode';
const PHOTON_URL = 'https://photon.komoot.io';

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal });
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

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url;
}

/** Résultats OpenRouteService (GeoJSON Pelias) → { label, point: [lat, lon] }. */
export function parseGeocodeResults(json) {
  return (json?.features ?? [])
    .filter((f) => Array.isArray(f?.geometry?.coordinates) && f.properties?.label)
    .map((f) => ({ label: f.properties.label, point: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
}

/** Libellé lisible d'un résultat Photon (nom, rue, code postal et ville, pays), sans répétition. */
export function photonLabel(p = {}) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const town = [p.postcode, p.city ?? p.town ?? p.village].filter(Boolean).join(' ');
  const parts = [p.name, street, town, p.country].filter(Boolean);
  return parts.filter((part, i) => parts.indexOf(part) === i).join(', ');
}

/** Résultats Photon (GeoJSON) → { label, point: [lat, lon] }. */
export function parsePhotonResults(json) {
  return (json?.features ?? [])
    .filter((f) => Array.isArray(f?.geometry?.coordinates))
    .map((f) => ({ label: photonLabel(f.properties), point: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }))
    .filter((r) => r.label);
}

/** Essaie OpenRouteService, puis Photon si OpenRouteService échoue (sauf annulation). */
async function withFallback(primary, fallback) {
  try {
    return await primary();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    try {
      return await fallback();
    } catch (fallbackError) {
      if (fallbackError.name === 'AbortError') throw fallbackError;
      throw error;
    }
  }
}

/**
 * Suggestions pendant la frappe, en priorité autour de `focus` (la carte affichée).
 * @returns {Promise<Array<{ label: string, point: [number, number] }>>}
 */
export function autocomplete({ apiKey, text, focus, signal }) {
  const lat = focus?.[0]?.toFixed(5);
  const lon = focus?.[1]?.toFixed(5);
  return withFallback(
    async () => {
      if (!apiKey) throw new OrsError('Clé OpenRouteService manquante.', 401);
      const url = buildUrl(`${ORS_URL}/autocomplete`, { api_key: apiKey, text, size: 5, lang: 'fr', 'focus.point.lat': lat, 'focus.point.lon': lon });
      return parseGeocodeResults(await getJson(url, signal));
    },
    async () => {
      const url = buildUrl(`${PHOTON_URL}/api/`, { q: text, limit: 5, lang: 'fr', lat, lon });
      return parsePhotonResults(await getJson(url, signal));
    },
  );
}

/** Adresse la plus proche d'un point (pour afficher un point touché sur la carte). */
export function reverse({ apiKey, point, signal }) {
  const lat = point[0].toFixed(5);
  const lon = point[1].toFixed(5);
  return withFallback(
    async () => {
      if (!apiKey) throw new OrsError('Clé OpenRouteService manquante.', 401);
      const url = buildUrl(`${ORS_URL}/reverse`, { api_key: apiKey, 'point.lat': lat, 'point.lon': lon, size: 1, lang: 'fr' });
      return parseGeocodeResults(await getJson(url, signal))[0]?.label ?? null;
    },
    async () => {
      const url = buildUrl(`${PHOTON_URL}/reverse`, { lat, lon, limit: 1, lang: 'fr' });
      return parsePhotonResults(await getJson(url, signal))[0]?.label ?? null;
    },
  );
}
