import assert from 'node:assert/strict';
import test from 'node:test';
import { score, sanitizeCriteria } from '../js/criteria.js';
import { knownCells, noveltyShare, noveltyText } from '../js/novelty.js';

// Ligne droite vers l'est (~2,2 km) et une autre 1 km plus au nord.
const line = (lat) => Array.from({ length: 21 }, (_, i) => [lat, 5.7 + i * 0.0014]);
const done = line(45.18);

test('nouveauté : un tracé déjà fait est connu, un tracé parallèle à 1 km est nouveau', () => {
  const cells = knownCells([done]);
  assert.ok(noveltyShare(done, cells) < 0.02);
  assert.ok(noveltyShare(line(45.189), cells) > 0.98);
  // Moitié commune : on emprunte le même chemin puis on bifurque vers le nord.
  const half = [...done.slice(0, 11), ...Array.from({ length: 10 }, (_, i) => [45.18 + (i + 1) * 0.001, 5.714])];
  const share = noveltyShare(half, cells);
  assert.ok(share > 0.35 && share < 0.65, `part nouvelle ${share}`);
  // Décalé de 30 m (autre côté de la rue, imprécision GPS) : toujours connu.
  assert.ok(noveltyShare(line(45.18027), cells) < 0.05);
});

test('nouveauté : sans historique, rien n\'est mesuré ni affiché', () => {
  assert.equal(noveltyShare(done, knownCells([])), null);
  assert.equal(noveltyText(null), '');
  assert.equal(noveltyText(1), 'Tout nouveau');
  assert.equal(noveltyText(0.1), 'Déjà fait');
  assert.equal(noveltyText(0.62), '62 % nouveau');
});

test('nouveauté : un parcours déjà fait est classé après un nouveau, sauf si le critère est désactivé', () => {
  const route = (novelty) => ({ distance: 10_000, ascent: null, overlap: 0, surface: null, majorRoads: 0, novelty });
  const criteria = sanitizeCriteria({ distanceKm: 10 });
  assert.equal(criteria.preferNew, true);
  assert.ok(score(route(0), criteria) > score(route(1), criteria));
  const off = sanitizeCriteria({ distanceKm: 10, preferNew: false });
  assert.equal(score(route(0), off), score(route(1), off));
});
