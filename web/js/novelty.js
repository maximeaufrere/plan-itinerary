// Nouveauté d'un parcours : part du tracé qui ne passe pas par des chemins déjà parcourus
// (sorties de l'historique et favoris). Les tracés connus sont rangés dans une grille de cases de 50 m.

import { cumulativeDistances, pointAtDistance } from './geo.js';

const CELL = 50; // mètres
const STEP = 40; // un point tous les 40 m le long des tracés
const M_PER_DEG = 111_320;

/** Points tous les `STEP` mètres le long d'un tracé. */
function samples(coordinates) {
  if (coordinates.length < 2) return coordinates;
  const cumulative = cumulativeDistances(coordinates);
  const total = cumulative.at(-1);
  const points = [];
  for (let at = 0; at <= total; at += STEP) points.push(pointAtDistance(coordinates, at, cumulative).point);
  return points;
}

/** Case de la grille ; la largeur des cases en longitude est fixée par degré de latitude (zone d'usage). */
function cell([lat, lon]) {
  const lonScale = Math.cos((Math.round(lat) * Math.PI) / 180);
  return [Math.floor((lat * M_PER_DEG) / CELL), Math.floor((lon * M_PER_DEG * lonScale) / CELL)];
}

/** Grille des chemins déjà parcourus, à partir des tracés connus. */
export function knownCells(tracks) {
  const cells = new Set();
  for (const coordinates of tracks) {
    for (const point of samples(coordinates)) cells.add(cell(point).join(':'));
  }
  return cells;
}

/**
 * Part (0 à 1) du tracé hors des chemins connus ; un point est connu si sa case ou une case voisine l'est
 * (environ 50 à 100 m de tolérance). `null` sans historique.
 */
export function noveltyShare(coordinates, cells) {
  if (!cells?.size) return null;
  const points = samples(coordinates);
  if (!points.length) return null;
  let fresh = 0;
  for (const point of points) {
    const [y, x] = cell(point);
    let known = false;
    for (let dy = -1; dy <= 1 && !known; dy++) {
      for (let dx = -1; dx <= 1 && !known; dx++) known = cells.has(`${y + dy}:${x + dx}`);
    }
    if (!known) fresh++;
  }
  return fresh / points.length;
}

/** Texte court pour une proposition, ou '' sans historique. */
export function noveltyText(share) {
  if (share == null) return '';
  if (share >= 0.95) return 'Tout nouveau';
  if (share < 0.2) return 'Déjà fait';
  return `${Math.round(share * 100)} % nouveau`;
}
