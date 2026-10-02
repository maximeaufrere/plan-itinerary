import assert from 'node:assert/strict';
import { test } from 'node:test';
import { majorRoadShare, overlapRatio, surfaceShares } from '../js/analysis.js';
import { fromFavorite, isValidFavorite, toFavorite } from '../js/favorites.js';
import { formatPace } from '../js/format.js';
import { bearing, destination, distance, resample } from '../js/geo.js';

const lyon = [45.764, 4.8357];

/** Polyligne qui suit une suite de caps et de longueurs. */
function path(from, legs) {
  const points = [from];
  for (const [heading, meters] of legs) points.push(destination(points.at(-1), meters, heading));
  return points;
}

test('repassages : quasi nul pour un carré, total pour un aller-retour', () => {
  const square = path(lyon, [[0, 1000], [90, 1000], [180, 1000], [270, 1000]]);
  assert.ok(overlapRatio(square) < 0.05, `carré : ${overlapRatio(square)}`);

  const outAndBack = path(lyon, [[0, 2000], [180, 2000]]);
  const ratio = overlapRatio(outAndBack);
  assert.ok(ratio > 0.4 && ratio <= 0.5, `aller-retour : ${ratio}`);
});

test('repassages : boucle « raquette » (tronçon commun au départ)', () => {
  // 1 km tout droit, boucle carrée de 4 × 500 m, puis retour par le même km.
  const racket = path(lyon, [[0, 1000], [90, 500], [0, 500], [270, 500], [180, 500], [180, 1000]]);
  const ratio = overlapRatio(racket);
  // 1 km repassé sur 4 km au total ≈ 25 %.
  assert.ok(ratio > 0.2 && ratio < 0.3, `raquette : ${ratio}`);
});

test('revêtement : regroupe les codes ORS en bitume / chemins / inconnu', () => {
  const shares = surfaceShares([
    { value: 3, distance: 600, amount: 60 }, // asphalte
    { value: 10, distance: 300, amount: 30 }, // gravier
    { value: 0, distance: 100, amount: 10 }, // inconnu
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, Math.round(v * 100)])),
    { paved: 60, unpaved: 30, unknown: 10 },
  );
  assert.equal(surfaceShares(undefined), null);
});

test('grands axes : part des routes principales', () => {
  assert.equal(majorRoadShare([{ value: 1, amount: 25 }, { value: 3, amount: 75 }]), 0.25);
  assert.equal(majorRoadShare([{ value: 3, amount: 100 }]), 0);
  assert.equal(majorRoadShare(undefined), null);
});

test('cap entre deux points', () => {
  const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  assert.ok(angleGap(bearing(lyon, destination(lyon, 5000, 0)), 0) < 0.5);
  assert.ok(angleGap(bearing(lyon, destination(lyon, 5000, 135)), 135) < 0.5);
});

test('ré-échantillonnage régulier', () => {
  const samples = resample(path(lyon, [[90, 1000]]), 100);
  assert.equal(samples.length, 11);
  assert.ok(Math.abs(distance(samples[0], samples[1]) - 100) < 0.5);
});

test('favoris : aller-retour compact sans perte utile', () => {
  const route = {
    id: 'route-0',
    coordinates: [[45.7640123456, 4.8357123456], [45.77, 4.84]],
    distance: 10_123.456,
    ascent: 151.7,
    descent: 150.2,
    minAltitude: 160.4,
    maxAltitude: 240.6,
    overlap: 0.12345,
    surface: { paved: 0.7, unpaved: 0.3, unknown: 0 },
    majorRoads: 0.05,
    profile: [{ distance: 0, elevation: 160.44 }, { distance: 10_123.4, elevation: 240.66 }],
  };
  const favorite = toFavorite(route, { name: 'Tour du parc', activity: 'running', savedAt: '2026-10-02T10:00:00.000Z' });
  const stored = JSON.parse(JSON.stringify(favorite));
  assert.ok(isValidFavorite(stored));

  const restored = fromFavorite(stored);
  assert.equal(restored.id, favorite.id);
  assert.deepEqual(restored.coordinates[0], [45.76401, 4.83571]);
  assert.equal(restored.distance, 10_123);
  assert.equal(restored.ascent, 152);
  assert.deepEqual(restored.profile[1], { distance: 10_123, elevation: 240.7 });
  assert.equal(isValidFavorite({ id: 'x' }), false);
});

test('allure au format coureur', () => {
  assert.equal(formatPace(10), "6'00/km");
  assert.equal(formatPace(3600 / 330), "5'30/km");
  assert.equal(formatPace(20), "3'00/km");
});
