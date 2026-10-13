import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cumulativeDistances, destination, distance, downsample, elevationGainAndLoss } from '../js/geo.js';

const paris = [48.8566, 2.3522];

test('destination est à la distance demandée, dans toutes les directions', () => {
  for (let bearing = 0; bearing < 360; bearing += 45) {
    const point = destination(paris, 5000, bearing);
    assert.ok(Math.abs(distance(paris, point) - 5000) < 1, `cap ${bearing}`);
  }
});

test('destination vers le nord augmente la latitude', () => {
  const [lat, lon] = destination(paris, 1000, 0);
  assert.ok(lat > paris[0]);
  assert.ok(Math.abs(lon - paris[1]) < 1e-9);
});

test('distances cumulées', () => {
  const a = destination(paris, 1000, 90);
  const b = destination(a, 500, 0);
  const result = cumulativeDistances([paris, a, b]);
  assert.equal(result[0], 0);
  assert.ok(Math.abs(result[2] - 1500) < 1);
});

test('le dénivelé ignore le bruit sous le seuil', () => {
  const { gain, loss } = elevationGainAndLoss([100, 101, 100, 102, 110, 120, 119, 120, 105]);
  assert.equal(gain, 20);
  assert.equal(loss, 15);
});

test('downsample garde le premier et le dernier point', () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const result = downsample(items, 10);
  assert.equal(result.length, 10);
  assert.equal(result[0], 0);
  assert.equal(result.at(-1), 999);
  assert.deepEqual(downsample([1, 2, 3], 10), [1, 2, 3]);
});

test('projection sur un tracé : distance parcourue et écart', async () => {
  const { projectOnRoute } = await import('../js/geo.js');
  const a = destination(paris, 1000, 90);
  const b = destination(a, 1000, 0);
  const route = [paris, a, b];
  // 300 m après le premier virage, 50 m à l'est du tracé.
  const point = destination(destination(a, 300, 0), 50, 90);
  const { along, offset } = projectOnRoute(route, point);
  assert.ok(Math.abs(along - 1300) < 2, `along ${along}`);
  assert.ok(Math.abs(offset - 50) < 2, `offset ${offset}`);
});

test('projection sur une boucle : au départ, on reste au début tant qu\'on vient de partir', async () => {
  const { projectOnRoute } = await import('../js/geo.js');
  const a = destination(paris, 1000, 90);
  const b = destination(a, 1000, 0);
  const c = destination(b, 1000, 270);
  const loop = [paris, a, b, c, paris];
  const nearStart = destination(paris, 20, 90);
  assert.ok(projectOnRoute(loop, nearStart, undefined, { near: 0 }).along < 50);
  // En fin de boucle, la recherche autour de la distance parcourue trouve l'arrivée.
  const nearEnd = destination(paris, 20, 0);
  assert.ok(projectOnRoute(loop, nearEnd, undefined, { near: 3900 }).along > 3900);
});
