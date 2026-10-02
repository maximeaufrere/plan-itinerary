// Favoris : itinéraires enregistrés dans le navigateur (localStorage), donc propres à chaque appareil.

const round = (value, digits) => (value == null ? value : Number(value.toFixed(digits)));

/** Version compacte d'un itinéraire, pour tenir dans le stockage local (~5 Mo). */
export function toFavorite(route, { name, activity, savedAt = new Date().toISOString() }) {
  return {
    id: `fav-${Date.parse(savedAt).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    activity,
    savedAt,
    route: {
      coordinates: route.coordinates.map(([lat, lon]) => [round(lat, 5), round(lon, 5)]),
      distance: Math.round(route.distance),
      ascent: round(route.ascent, 0),
      descent: round(route.descent, 0),
      minAltitude: round(route.minAltitude, 0),
      maxAltitude: round(route.maxAltitude, 0),
      overlap: round(route.overlap, 3),
      surface: route.surface,
      majorRoads: round(route.majorRoads, 3),
      profile: route.profile.map((p) => [Math.round(p.distance), round(p.elevation, 1)]),
    },
  };
}

/** Itinéraire utilisable par l'interface, à partir d'un favori. */
export function fromFavorite(favorite) {
  const { route } = favorite;
  return {
    ...route,
    id: favorite.id,
    profile: route.profile.map(([distance, elevation]) => ({ distance, elevation })),
  };
}

export function isValidFavorite(value) {
  return (
    value != null &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.route?.coordinates) &&
    Array.isArray(value.route?.profile) &&
    typeof value.route.distance === 'number'
  );
}
