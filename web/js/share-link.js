// Partage par lien, sans compte ni serveur : le parcours est encodé dans le lien lui-même (après le « # »,
// qui n'est jamais envoyé au serveur). Tracé et altitudes au format « polyline » (Google), compressés.

import { cumulativeDistances, downsample } from './geo.js';

const HASH_KEY = 'trace';
const VERSION = 1;
/** Points gardés au plus : de quoi suivre fidèlement le tracé avec un lien court. */
const MAX_POINTS = 400;

/** Entiers signés → texte compact (algorithme des polylines Google). */
function encodeSigned(values) {
  let out = '';
  for (const value of values) {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  }
  return out;
}

function decodeSigned(text) {
  const values = [];
  let index = 0;
  while (index < text.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < text.length);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  return values;
}

/** Suite de valeurs → écarts successifs encodés (les petites variations prennent peu de place). */
const encodeDeltas = (values) => encodeSigned(values.map((v, i) => v - (i ? values[i - 1] : 0)));
const decodeDeltas = (text) => {
  let previous = 0;
  return decodeSigned(text).map((delta) => (previous += delta));
};

/** Points [lat, lon] → polyline (précision 1e-5, environ 1 m). */
export function encodePolyline(points) {
  const flat = [];
  let [prevLat, prevLon] = [0, 0];
  for (const [lat, lon] of points) {
    const [la, lo] = [Math.round(lat * 1e5), Math.round(lon * 1e5)];
    flat.push(la - prevLat, lo - prevLon);
    [prevLat, prevLon] = [la, lo];
  }
  return encodeSigned(flat);
}

export function decodePolyline(text) {
  const flat = decodeSigned(text);
  const points = [];
  let [lat, lon] = [0, 0];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    lat += flat[i];
    lon += flat[i + 1];
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

// MARK: Base64 « URL » et compression (quand le navigateur sait faire)

const toBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (text) => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function transform(bytes, stream) {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

// MARK: Parcours ↔ lien

const round = (value, digits) => (value == null ? null : Number(Number(value).toFixed(digits)));

/** Données compactes d'un parcours (tracé simplifié, altitudes en mètres entiers). */
export function packRoute(route, { name, activity }) {
  const indices = downsample(route.coordinates.map((_, i) => i), MAX_POINTS);
  const points = indices.map((i) => route.coordinates[i]);
  // Altitudes alignées sur les points gardés, lues dans le profil (même nombre de points que le tracé
  // pour un parcours calculé ; sinon, on les répartit à la distance).
  const profile = route.profile ?? [];
  let elevations = null;
  if (profile.length === route.coordinates.length) {
    elevations = indices.map((i) => Math.round(profile[i].elevation));
  } else if (profile.length > 1) {
    const total = profile.at(-1).distance;
    elevations = indices.map((_, k) => {
      const at = (k / Math.max(1, indices.length - 1)) * total;
      return Math.round((profile.find((p) => p.distance >= at) ?? profile.at(-1)).elevation);
    });
  }
  return {
    v: VERSION,
    n: name,
    a: activity,
    d: Math.round(route.distance),
    up: round(route.ascent, 0),
    dn: round(route.descent, 0),
    c: encodePolyline(points),
    e: elevations ? encodeDeltas(elevations) : null,
    s: route.surface ? [round(route.surface.paved, 2), round(route.surface.unpaved, 2), round(route.surface.unknown, 2)] : null,
    o: round(route.overlap, 3),
    m: round(route.majorRoads, 3),
  };
}

/** Parcours utilisable par l'interface, à partir des données compactes. */
export function unpackRoute(data) {
  if (data?.v !== VERSION || typeof data.c !== 'string') throw new Error('Lien de parcours illisible.');
  const coordinates = decodePolyline(data.c);
  if (coordinates.length < 2) throw new Error('Lien de parcours illisible.');
  const elevations = data.e ? decodeDeltas(data.e) : null;
  const cumulative = cumulativeDistances(coordinates);
  const scale = cumulative.at(-1) > 0 ? data.d / cumulative.at(-1) : 1;
  const profile =
    elevations && elevations.length === coordinates.length
      ? elevations.map((elevation, i) => ({ distance: cumulative[i] * scale, elevation }))
      : [];
  return {
    route: {
      id: `lien-${data.c.length.toString(36)}-${data.d.toString(36)}`,
      name: data.n || 'Parcours partagé',
      coordinates,
      distance: data.d,
      ascent: data.up,
      descent: data.dn,
      profile,
      minAltitude: profile.length ? Math.min(...elevations) : null,
      maxAltitude: profile.length ? Math.max(...elevations) : null,
      overlap: data.o,
      surface: data.s ? { paved: data.s[0], unpaved: data.s[1], unknown: data.s[2] } : null,
      majorRoads: data.m,
    },
    activity: data.a,
  };
}

/** Texte à placer après « #trace= » : « z » + données compressées, ou « j » + données brutes. */
export async function encodeRouteData(route, meta) {
  const json = new TextEncoder().encode(JSON.stringify(packRoute(route, meta)));
  if (canCompress()) return `z${toBase64Url(await transform(json, new CompressionStream('deflate-raw')))}`;
  return `j${toBase64Url(json)}`;
}

export async function decodeRouteData(text) {
  const kind = text[0];
  let bytes = fromBase64Url(text.slice(1));
  if (kind === 'z') {
    if (!canCompress()) throw new Error('Ce navigateur ne sait pas ouvrir ce lien de parcours.');
    bytes = await transform(bytes, new DecompressionStream('deflate-raw'));
  } else if (kind !== 'j') {
    throw new Error('Lien de parcours illisible.');
  }
  return unpackRoute(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Lien complet vers l'app qui ouvre ce parcours. */
export async function routeLink(route, meta, base = `${location.origin}${location.pathname}`) {
  return `${base}#${HASH_KEY}=${await encodeRouteData(route, meta)}`;
}

/** Données de parcours présentes dans l'adresse (« #trace=… »), ou null. */
export function routeDataFromHash(hash) {
  const match = new RegExp(`^#${HASH_KEY}=(.+)$`).exec(hash ?? '');
  return match ? match[1] : null;
}
