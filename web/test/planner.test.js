import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCriteria } from '../js/criteria.js';
import { cumulativeDistances, distance, destination } from '../js/geo.js';
import { DETOUR_FACTOR, loopShapes, previewScore, previewShape, rankShapes } from '../js/planner.js';
import { chooseZoom, createTerrain, decodeTerrarium, tileCoordinates } from '../js/terrain.js';

const start = [45.764, 4.8357];

test('formes de boucle : fermées, de la bonne taille et orientées dans toutes les directions', () => {
  const shapes = loopShapes(start, 12_000);
  assert.equal(shapes.length, 24);
  for (const shape of shapes) {
    const points = shape.points(1);
    assert.deepEqual(points[0], start);
    assert.deepEqual(points.at(-1), start);
    assert.ok(points.length >= 5 && points.length <= 7);
    assert.ok(Math.abs(cumulativeDistances(points).at(-1) * DETOUR_FACTOR - 12_000) < 50);
    // L'échelle agrandit la forme proportionnellement.
    assert.ok(Math.abs(cumulativeDistances(shape.points(2)).at(-1) / cumulativeDistances(points).at(-1) - 2) < 0.01);
  }
  const headings = shapes.map((s) => s.heading).sort((a, b) => a - b);
  assert.ok(headings[0] < 30 && headings.at(-1) > 330);
});

test('aperçu du relief : D+ en ligne droite et détection de la mer', () => {
  const north = destination(start, 2000, 0);
  const slope = ([lat]) => 100 + (lat - start[0]) * 10_000;
  const preview = previewShape([start, north, start], slope);
  assert.ok(Math.abs(preview.gain - (slope(north) - 100)) < 15);
  assert.ok(Math.abs(preview.length - 4000) < 1);
  assert.equal(preview.inWater, false);
  assert.equal(previewShape([start, north, start], () => -20).inWater, true);
  assert.equal(previewShape([start, north, start], () => null).gain, null);
});

test('note de relief : plat, limite de D+, mer', () => {
  const flat = { ...defaultCriteria(), elevation: 'flat' };
  assert.ok(previewScore({ gain: 10, length: 8000, inWater: false }, flat) < previewScore({ gain: 200, length: 8000, inWater: false }, flat));
  const limited = { ...defaultCriteria(), elevation: 'any', maxGain: 100 };
  assert.equal(previewScore({ gain: 50, length: 8000, inWater: false }, limited), 0);
  assert.ok(previewScore({ gain: 300, length: 8000, inWater: false }, limited) > 0);
  assert.ok(previewScore({ gain: 0, length: 8000, inWater: true }, limited) >= 1000);
});

test('classement : les mieux notées d\'abord, dans des directions variées, puis les formes de rechange', () => {
  const shapes = [
    { heading: 0, previewScore: 0 },
    { heading: 10, previewScore: 1 },
    { heading: 180, previewScore: 5 },
    { heading: 90, previewScore: 9 },
  ];
  const ranked = rankShapes(shapes, 2);
  assert.deepEqual(ranked.map((s) => s.heading), [0, 180, 10, 90]);
  // Une direction nettement moins bien notée ne passe pas devant une bonne forme, même proche.
  const hilly = [{ heading: 0, previewScore: 0 }, { heading: 10, previewScore: 1 }, { heading: 180, previewScore: 60 }];
  assert.deepEqual(rankShapes(hilly, 2).map((s) => s.heading), [0, 10, 180]);
});

test('terrain : décodage Terrarium, dalles et lecture d\'altitude', async () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(129, 44, 128), 300.5);
  const { x, y } = tileCoordinates([0, 0], 1);
  assert.deepEqual([x, y], [1, 1]);
  assert.equal(chooseZoom([start, destination(start, 3000, 45)]), 12);
  assert.ok(chooseZoom([start, destination(start, 150_000, 45)]) < 12);

  const loaded = [];
  const terrain = createTerrain({
    loadTile: async (key) => {
      loaded.push(key);
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let i = 0; i < data.length; i += 4) [data[i], data[i + 1], data[i + 2]] = [129, 44, 0];
      return data;
    },
  });
  await terrain.load([start, destination(start, 3000, 45)]);
  assert.ok(loaded.length >= 1 && loaded.length <= 4);
  assert.equal(terrain.elevationAt(start), 300);
  assert.equal(terrain.elevationAt([-45, -100]), null);
});
