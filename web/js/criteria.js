// `profile` : profil de calcul OpenRouteService.
export const ACTIVITIES = {
  running: { label: 'Course', icon: '🏃', profile: 'foot-walking', speedKmh: 10, range: [1, 50], defaultKm: 10 },
  trail: { label: 'Trail', icon: '⛰️', profile: 'foot-hiking', speedKmh: 8, range: [1, 60], defaultKm: 15 },
  road: { label: 'Vélo route', icon: '🚴', profile: 'cycling-road', speedKmh: 25, range: [5, 200], defaultKm: 50 },
  bike: { label: 'Vélo', icon: '🚲', profile: 'cycling-regular', speedKmh: 18, range: [5, 150], defaultKm: 30 },
  mtb: { label: 'VTT', icon: '🚵', profile: 'cycling-mountain', speedKmh: 14, range: [5, 120], defaultKm: 30 },
};

export const SHAPES = {
  loop: 'Boucle',
  out_and_back: 'Aller-retour',
};

// Dénivelé positif visé, en mètres par kilomètre (null = pas de préférence).
export const ELEVATION_PREFERENCES = {
  any: { label: 'Peu importe', gainPerKm: null },
  flat: { label: 'Plat', gainPerKm: 0 },
  rolling: { label: 'Vallonné', gainPerKm: 10 },
  hilly: { label: 'Montagneux', gainPerKm: 25 },
};

export function defaultCriteria() {
  return {
    activity: 'running',
    distanceKm: ACTIVITIES.running.defaultKm,
    shape: 'loop',
    elevation: 'any',
    maxGain: null,
    proposals: 3,
  };
}

/** Complète et corrige des critères (ex. relus depuis le stockage local). */
export function sanitizeCriteria(input) {
  const criteria = { ...defaultCriteria(), ...input };
  if (!ACTIVITIES[criteria.activity]) criteria.activity = 'running';
  if (!SHAPES[criteria.shape]) criteria.shape = 'loop';
  if (!ELEVATION_PREFERENCES[criteria.elevation]) criteria.elevation = 'any';
  const [min, max] = ACTIVITIES[criteria.activity].range;
  criteria.distanceKm = Math.min(max, Math.max(min, Number(criteria.distanceKm) || ACTIVITIES[criteria.activity].defaultKm));
  criteria.proposals = Math.min(5, Math.max(1, Math.round(Number(criteria.proposals) || 3)));
  criteria.maxGain = criteria.maxGain == null || Number.isNaN(Number(criteria.maxGain)) ? null : Math.max(0, Number(criteria.maxGain));
  return criteria;
}

/** Plus le score est bas, plus l'itinéraire correspond aux critères. */
export function score(route, criteria) {
  const target = criteria.distanceKm * 1000;
  // 1 point par % d'écart à la distance visée.
  let result = (Math.abs(route.distance - target) / target) * 100;

  if (route.ascent != null) {
    const targetGainPerKm = ELEVATION_PREFERENCES[criteria.elevation].gainPerKm;
    if (targetGainPerKm != null) {
      const gainPerKm = route.ascent / Math.max(route.distance / 1000, 0.1);
      result += Math.abs(gainPerKm - targetGainPerKm) * 2;
    }
    if (criteria.maxGain != null && route.ascent > criteria.maxGain) {
      result += 50 + (route.ascent - criteria.maxGain) / 10;
    }
  }
  return result;
}

export function estimatedDuration(route, activityKey) {
  return route.distance / (ACTIVITIES[activityKey].speedKmh / 3.6);
}
