// Altitudes approximatives à partir des dalles « Terrarium » (AWS Open Data, gratuites, sans clé, CORS ouvert).
// Elles servent à estimer le relief d'un tracé avant de le demander à OpenRouteService.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_SIZE = 256;
const MAX_ZOOM = 12;
const MIN_ZOOM = 8;
/** Nombre maximal de dalles chargées pour une génération (~100 Ko chacune). */
const MAX_TILES = 16;

/** Altitude (m) codée dans un pixel Terrarium. */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Position d'un point dans la grille des dalles au niveau de zoom `z` (coordonnées fractionnaires). */
export function tileCoordinates([lat, lon], z) {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** Plus grand zoom (le plus précis) pour lequel les points tiennent dans `MAX_TILES` dalles. */
export function chooseZoom(points) {
  for (let z = MAX_ZOOM; z > MIN_ZOOM; z--) {
    if (tileRange(points, z).count <= MAX_TILES) return z;
  }
  return MIN_ZOOM;
}

/** Plage des dalles couvrant le rectangle englobant les points. */
function tileRange(points, z) {
  const xs = [];
  const ys = [];
  for (const point of points) {
    const { x, y } = tileCoordinates(point, z);
    xs.push(Math.floor(x));
    ys.push(Math.floor(y));
  }
  const range = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  range.count = points.length ? (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1) : 0;
  return range;
}

function tilesFor(points, z) {
  const { minX, maxX, minY, maxY, count } = tileRange(points, z);
  const keys = [];
  // Zone trop vaste même au zoom minimal : on renonce plutôt que de télécharger des dizaines de dalles.
  if (count === 0 || count > MAX_TILES * 2) return keys;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) keys.push(`${z}/${x}/${y}`);
  }
  return keys;
}

/** Télécharge une dalle et renvoie ses pixels RGBA (navigateur uniquement). */
async function loadTerrariumTile(key, signal) {
  const response = await fetch(`${TILE_URL}/${key}.png`, { signal });
  if (!response.ok) throw new Error(`Dalle d'altitude indisponible (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

/**
 * Modèle de terrain : `load(points)` charge les dalles couvrant ces points,
 * puis `elevationAt(point)` répond sans attendre (null si la zone n'a pas pu être chargée).
 */
export function createTerrain({ loadTile = loadTerrariumTile } = {}) {
  const tiles = new Map();
  let zoom = MAX_ZOOM;

  return {
    async load(points, signal) {
      zoom = chooseZoom(points);
      const keys = tilesFor(points, zoom).filter((key) => !tiles.has(key));
      await Promise.all(
        keys.map(async (key) => {
          try {
            tiles.set(key, await loadTile(key, signal));
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            tiles.set(key, null);
          }
        }),
      );
    },
    elevationAt(point) {
      const { x, y } = tileCoordinates(point, zoom);
      const data = tiles.get(`${zoom}/${Math.floor(x)}/${Math.floor(y)}`);
      if (!data) return null;
      const px = Math.min(TILE_SIZE - 1, Math.floor((x % 1) * TILE_SIZE));
      const py = Math.min(TILE_SIZE - 1, Math.floor((y % 1) * TILE_SIZE));
      const i = (py * TILE_SIZE + px) * 4;
      return decodeTerrarium(data[i], data[i + 1], data[i + 2]);
    },
  };
}

/** Terrain par défaut : seulement dans un navigateur capable de décoder les images. */
export function defaultTerrain() {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  return createTerrain();
}
