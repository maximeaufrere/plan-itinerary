// `profile` : profil de calcul OpenRouteService. `speedKmh` : vitesse par défaut sur le plat.
export const ACTIVITIES = {
  running: { label: 'Course', kind: 'foot', profile: 'foot-walking', speedKmh: 10, range: [1, 50], defaultKm: 10 },
  trail: { label: 'Trail', kind: 'foot', profile: 'foot-hiking', speedKmh: 8, range: [1, 60], defaultKm: 15 },
  road: { label: 'Vélo route', kind: 'bike', profile: 'cycling-road', speedKmh: 25, range: [5, 200], defaultKm: 50 },
  bike: { label: 'Balade à vélo', kind: 'bike', profile: 'cycling-regular', speedKmh: 18, range: [5, 150], defaultKm: 30 },
  mtb: { label: 'VTT', kind: 'bike', profile: 'cycling-mountain', speedKmh: 14, range: [5, 120], defaultKm: 30 },
};

/** Bornes des vitesses réglables (km/h) : allure de 10'00 à 3'00/km à pied. */
export const SPEED_RANGES = {
  foot: [6, 20],
  bike: [8, 45],
};

export const SHAPES = {
  loop: 'Boucle',
  out_and_back: 'Aller-retour',
  point_to_point: 'A → B',
};

// Dénivelé positif visé, en mètres par kilomètre (null = pas de préférence).
export const ELEVATION_PREFERENCES = {
  any: { label: 'Peu importe', gainPerKm: null },
  flat: { label: 'Plat', gainPerKm: 0 },
  rolling: { label: 'Vallonné', gainPerKm: 10 },
  hilly: { label: 'Montagneux', gainPerKm: 25 },
};

export const SURFACES = {
  any: 'Peu importe',
  paved: 'Bitume',
  unpaved: 'Chemins',
};

export function defaultCriteria() {
  return {
    activity: 'running',
    distanceKm: ACTIVITIES.running.defaultKm,
    shape: 'loop',
    elevation: 'any',
    maxGain: null,
    surface: 'any',
    avoidMajorRoads: false,
    proposals: 3,
    speeds: Object.fromEntries(Object.entries(ACTIVITIES).map(([key, activity]) => [key, activity.speedKmh])),
  };
}

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));

/** Complète et corrige des critères (ex. relus depuis le stockage local). */
export function sanitizeCriteria(input) {
  const defaults = defaultCriteria();
  const criteria = { ...defaults, ...input, speeds: { ...defaults.speeds, ...input?.speeds } };
  if (!ACTIVITIES[criteria.activity]) criteria.activity = 'running';
  if (!SHAPES[criteria.shape]) criteria.shape = 'loop';
  if (!ELEVATION_PREFERENCES[criteria.elevation]) criteria.elevation = 'any';
  if (!SURFACES[criteria.surface]) criteria.surface = 'any';
  criteria.avoidMajorRoads = Boolean(criteria.avoidMajorRoads);
  const activity = ACTIVITIES[criteria.activity];
  criteria.distanceKm = clamp(Number(criteria.distanceKm) || activity.defaultKm, activity.range);
  criteria.proposals = clamp(Math.round(Number(criteria.proposals) || 3), [1, 5]);
  criteria.maxGain = criteria.maxGain == null || Number.isNaN(Number(criteria.maxGain)) ? null : Math.max(0, Number(criteria.maxGain));
  for (const [key, { kind, speedKmh }] of Object.entries(ACTIVITIES)) {
    criteria.speeds[key] = clamp(Number(criteria.speeds[key]) || speedKmh, SPEED_RANGES[kind]);
  }
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

  // Repasser par les mêmes rues : normal pour un aller-retour, à éviter sinon (50 % de repassage = +30).
  if (criteria.shape !== 'out_and_back' && route.overlap != null) {
    result += route.overlap * 60;
  }

  if (route.surface) {
    if (criteria.surface === 'paved') result += route.surface.unpaved * 40;
    if (criteria.surface === 'unpaved') result += route.surface.paved * 40;
  }

  if (criteria.avoidMajorRoads && route.majorRoads != null) {
    result += route.majorRoads * 60;
  }
  return result;
}

/**
 * Durée estimée en secondes.
 * À pied, on utilise le « kilomètre-effort » des traileurs : chaque 100 m de D+ compte comme 1 km de plus.
 * À vélo, la vitesse réglée est une moyenne qui inclut déjà le relief.
 */
export function estimatedDuration(route, activityKey, speeds) {
  const activity = ACTIVITIES[activityKey];
  const speed = speeds?.[activityKey] ?? activity.speedKmh;
  const effortKm = route.distance / 1000 + (activity.kind === 'foot' ? (route.ascent ?? 0) / 100 : 0);
  return (effortKm / speed) * 3600;
}
