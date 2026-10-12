// État de l'app partagé entre les modules de l'écran principal.
import { sanitizeCriteria } from './criteria.js';
import { isValidFavorite } from './favorites.js';
import { KEYS, storage } from './storage.js';

export const state = {
  criteria: sanitizeCriteria(storage.get(KEYS.criteria, {})),
  start: null,
  end: null,
  routes: [],
  /** Activité avec laquelle les itinéraires affichés ont été calculés. */
  routesActivity: null,
  selectedId: null,
  controller: null,
  favorites: storage.get(KEYS.favorites, []).filter(isValidFavorite),
};

export const isPointToPoint = () => state.criteria.shape === 'point_to_point';
export const selectedRoute = () => state.routes.find((r) => r.id === state.selectedId);
