import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCriteria, sanitizeCriteria, score } from '../js/criteria.js';
import { generateRoutes } from '../js/generator.js';
import { destination } from '../js/geo.js';
import { toGpx } from '../js/gpx.js';
import { OrsError } from '../js/ors.js';

const start = [45.7640, 4.8357];

/** Faux ORS : renvoie un tracé dont la distance et le dénivelé sont pilotés par le test. */
function fakeFetch({ distanceFor, climb = 50 }) {
  const calls = [];
  const fetchRoute = async (request) => {
    calls.push(request);
    const dist = distanceFor(request, calls.length);
    const mid = destination(start, dist / 4, 90);
    return {
      coordinates: [start, mid, start],
      elevations: [200, 200 + climb, 200],
      distance: dist,
      ascent: null,
      descent: null,
    };
  };
  return { calls, fetchRoute };
}

test('boucle : corrige la longueur demandée quand ORS s\'écarte de la cible', async () => {
  const criteria = { ...defaultCriteria(), distanceKm: 10, proposals: 1 };
  // ORS rend 30 % de plus que demandé.
  const { calls, fetchRoute } = fakeFetch({ distanceFor: (r) => r.roundTrip.length * 1.3 });

  const routes = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

  assert.equal(routes.length, 1);
  assert.equal(calls[0].roundTrip.length, 10_000);
  assert.equal(calls[1].roundTrip.length, Math.round(10_000 / 1.3));
  assert.ok(Math.abs(routes[0].distance - 10_000) < 10);
  assert.equal(routes[0].ascent, 50);
  assert.equal(routes[0].maxAltitude, 250);
});

test('aller-retour : passe par un point de demi-tour puis revient au départ', async () => {
  const criteria = { ...defaultCriteria(), shape: 'out_and_back', proposals: 1 };
  const { calls, fetchRoute } = fakeFetch({ distanceFor: () => 10_000 });

  await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

  assert.equal(calls[0].points.length, 3);
  assert.deepEqual(calls[0].points[0], start);
  assert.deepEqual(calls[0].points[2], start);
  assert.equal(calls[0].roundTrip, undefined);
});

test('classe les propositions selon le dénivelé souhaité', async () => {
  const criteria = { ...defaultCriteria(), elevation: 'flat', proposals: 2 };
  let n = 0;
  const fetchRoute = async () => {
    n++;
    const climb = n % 2 === 0 ? 5 : 300;
    return { coordinates: [start, start], elevations: [100, 100 + climb], distance: 10_000, ascent: null, descent: null };
  };

  const routes = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

  assert.equal(routes.length, 2);
  assert.ok(routes[0].ascent < routes[1].ascent);
});

test('une erreur de clé arrête la génération', async () => {
  const fetchRoute = async () => {
    throw new OrsError('Clé invalide', 403);
  };
  await assert.rejects(
    generateRoutes({ start, criteria: defaultCriteria(), apiKey: 'k', fetchRoute }),
    /Clé invalide/,
  );
});

test('un candidat impossible est ignoré', async () => {
  let n = 0;
  const fetchRoute = async () => {
    n++;
    if (n === 1) throw new OrsError('Point non routable', 404);
    return { coordinates: [start, start], elevations: null, distance: 10_000, ascent: 12, descent: 12 };
  };
  const routes = await generateRoutes({ start, criteria: { ...defaultCriteria(), proposals: 2 }, apiKey: 'k', fetchRoute });
  assert.equal(routes.length, 2);
  assert.equal(routes[0].ascent, 12);
});

test('annulation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateRoutes({ start, criteria: defaultCriteria(), apiKey: 'k', signal: controller.signal, fetchRoute: async () => ({}) }),
    { name: 'AbortError' },
  );
});

test('score : pénalise le dépassement du D+ max', () => {
  const criteria = { ...defaultCriteria(), maxGain: 100 };
  const ok = score({ distance: 10_000, ascent: 80 }, criteria);
  const tooMuch = score({ distance: 10_000, ascent: 300 }, criteria);
  assert.ok(ok < tooMuch);
});

test('sanitizeCriteria corrige les valeurs invalides', () => {
  const criteria = sanitizeCriteria({ activity: 'ski', distanceKm: 999, proposals: 12, maxGain: 'abc' });
  assert.equal(criteria.activity, 'running');
  assert.equal(criteria.distanceKm, 50);
  assert.equal(criteria.proposals, 5);
  assert.equal(criteria.maxGain, null);
});

test('GPX valide avec altitudes et nom échappé', () => {
  const gpx = toGpx(
    { coordinates: [[45, 4], [45.001, 4.001]], profile: [{ distance: 0, elevation: 200 }, { distance: 140, elevation: 210 }] },
    'Course <test> & co',
  );
  assert.match(gpx, /<trkpt lat="45.000000" lon="4.000000"><ele>200.0<\/ele><\/trkpt>/);
  assert.match(gpx, /<name>Course &lt;test&gt; &amp; co<\/name>/);
});
