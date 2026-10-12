import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePolyline, decodeRouteData, encodePolyline, encodeRouteData, routeDataFromHash } from '../js/share-link.js';

const loop = Array.from({ length: 1200 }, (_, i) => {
  const angle = (i / 1199) * 2 * Math.PI;
  return [45.18 + 0.05 * Math.sin(angle), 5.72 + 0.07 * (1 - Math.cos(angle))];
});
const route = {
  coordinates: loop,
  distance: 31234,
  ascent: 412.4,
  descent: 410.8,
  profile: loop.map((_, i) => ({ distance: (i / 1199) * 31234, elevation: 220 + 150 * Math.sin((i / 1199) * Math.PI) })),
  overlap: 0.0213,
  surface: { paved: 0.9, unpaved: 0.07, unknown: 0.03 },
  majorRoads: 0.12,
};

test('lien : polyline aller-retour à 1e-5 près', () => {
  const points = [[45.18123, 5.72456], [-33.9, 151.2], [0, -0.00001]];
  assert.deepEqual(decodePolyline(encodePolyline(points)), points);
});

test('lien : parcours encodé puis relu, lien court', async () => {
  const data = await encodeRouteData(route, { name: 'Boucle « test »', activity: 'road' });
  assert.ok(data.length < 4000, `lien trop long : ${data.length}`);
  assert.equal(routeDataFromHash(`#trace=${data}`), data);
  assert.equal(routeDataFromHash('#autre'), null);
  const { route: back, activity } = await decodeRouteData(data);
  assert.equal(activity, 'road');
  assert.equal(back.name, 'Boucle « test »');
  assert.equal(back.distance, 31234);
  assert.equal(back.ascent, 412);
  assert.equal(back.coordinates.length, 400);
  assert.deepEqual(back.coordinates[0], loop[0].map((v) => Number(v.toFixed(5))));
  assert.equal(back.profile.length, 400);
  assert.ok(Math.abs(back.profile.at(-1).distance - 31234) < 1);
  assert.equal(back.maxAltitude, 370);
  assert.deepEqual(back.surface, { paved: 0.9, unpaved: 0.07, unknown: 0.03 });
});

test('lien : données abîmées refusées proprement', async () => {
  await assert.rejects(decodeRouteData('xabc'), /illisible/);
  await assert.rejects(decodeRouteData(`j${Buffer.from('{"v":9}').toString('base64url')}`), /illisible/);
});
