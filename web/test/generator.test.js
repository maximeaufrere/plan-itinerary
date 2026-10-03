import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCriteria, estimatedDuration, sanitizeCriteria, score } from '../js/criteria.js';
import { generateRoutes, selectRoutes } from '../js/generator.js';
import { distance, destination } from '../js/geo.js';
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

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

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

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

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
  const { routes } = await generateRoutes({ start, criteria: { ...defaultCriteria(), proposals: 2 }, apiKey: 'k', fetchRoute });
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
  assert.equal(criteria.surface, 'any');
  assert.equal(criteria.speeds.running, 10);
  // Allure trop rapide ramenée à 3'00/km (20 km/h).
  assert.equal(sanitizeCriteria({ speeds: { running: 99 } }).speeds.running, 20);
});

test('GPX valide avec altitudes et nom échappé', () => {
  const gpx = toGpx(
    { coordinates: [[45, 4], [45.001, 4.001]], profile: [{ distance: 0, elevation: 200 }, { distance: 140, elevation: 210 }] },
    'Course <test> & co',
  );
  assert.match(gpx, /<trkpt lat="45.000000" lon="4.000000"><ele>200.0<\/ele><\/trkpt>/);
  assert.match(gpx, /<name>Course &lt;test&gt; &amp; co<\/name>/);
});

test('A → B : propose le trajet direct s\'il est déjà plus long que la distance visée', async () => {
  const end = destination(start, 8000, 45);
  const criteria = { ...defaultCriteria(), shape: 'point_to_point', distanceKm: 5, proposals: 3 };
  const { calls, fetchRoute } = fakeFetch({ distanceFor: () => 9_000 });

  const result = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute });

  assert.equal(calls.length, 1);
  assert.equal(result.directIsLonger, true);
  assert.equal(result.routes.length, 1);
});

test('A → B : les points de détour sont sur une ellipse de foyers A et B, des deux côtés', async () => {
  const end = destination(start, 4000, 90);
  const criteria = { ...defaultCriteria(), shape: 'point_to_point', distanceKm: 10, proposals: 2 };
  // 1er appel : trajet direct de 5 km ; ensuite les détours font pile 10 km.
  const { calls, fetchRoute } = fakeFetch({ distanceFor: (_, n) => (n === 1 ? 5_000 : 10_000) });

  const { routes, directIsLonger } = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute });

  assert.equal(directIsLonger, undefined);
  assert.equal(routes.length, 2);
  const detours = calls.slice(1).map((c) => c.points[1]);
  const expectedSum = 10_000 / 1.25;
  for (const waypoint of detours) {
    assert.ok(Math.abs(distance(start, waypoint) + distance(waypoint, end) - expectedSum) < 20);
  }
  // Angles 90° puis 270° : un détour de chaque côté de l'axe A → B (orienté est-ouest ici).
  assert.ok((detours[0][0] - start[0]) * (detours[1][0] - start[0]) < 0);
  for (const call of calls.slice(1)) assert.deepEqual(call.points.at(-1), end);
});

test('score : pénalise les repassages, sauf en aller-retour', () => {
  const base = { distance: 10_000, ascent: null };
  const loop = { ...defaultCriteria(), shape: 'loop' };
  assert.ok(score({ ...base, overlap: 0.5 }, loop) > score({ ...base, overlap: 0 }, loop));
  const outAndBack = { ...defaultCriteria(), shape: 'out_and_back' };
  assert.equal(score({ ...base, overlap: 0.9 }, outAndBack), score({ ...base, overlap: 0 }, outAndBack));
});

test('score : revêtement et grands axes', () => {
  const base = { distance: 10_000, ascent: null };
  const trails = { ...defaultCriteria(), surface: 'unpaved' };
  const asphalt = { ...base, surface: { paved: 0.9, unpaved: 0.1, unknown: 0 } };
  const dirt = { ...base, surface: { paved: 0.1, unpaved: 0.9, unknown: 0 } };
  assert.ok(score(dirt, trails) < score(asphalt, trails));

  const quiet = { ...defaultCriteria(), avoidMajorRoads: true };
  assert.ok(score({ ...base, majorRoads: 0 }, quiet) < score({ ...base, majorRoads: 0.4 }, quiet));
  assert.equal(score({ ...base, majorRoads: 0.4 }, defaultCriteria()), score({ ...base, majorRoads: 0 }, defaultCriteria()));
});

test('durée : kilomètre-effort à pied, vitesse moyenne à vélo', () => {
  const route = { distance: 10_000, ascent: 200 };
  // 10 km + 200 m D+ = 12 km-effort, à 12 km/h = 1 h.
  assert.equal(estimatedDuration(route, 'running', { running: 12 }), 3600);
  // À vélo, le D+ ne s'ajoute pas : 10 km à 20 km/h = 30 min.
  assert.equal(estimatedDuration(route, 'bike', { bike: 20 }), 1800);
});

test('D+ max : les parcours au-dessus de la limite sont écartés', async () => {
  const climbs = [400, 120, 260, 90, 300, 180];
  let n = 0;
  const fetchRoute = async () => {
    const climb = climbs[n++ % climbs.length];
    return { coordinates: [start, start], elevations: [100, 100 + climb], distance: 10_000, ascent: null, descent: null };
  };
  const criteria = { ...defaultCriteria(), proposals: 3, maxGain: 200 };
  const { routes, maxGainUnmet } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute });

  assert.equal(maxGainUnmet, undefined);
  assert.ok(routes.length > 0);
  assert.ok(routes.every((r) => r.ascent <= 200), routes.map((r) => r.ascent).join(','));
  // Davantage de directions explorées quand une limite de D+ est fixée.
  assert.ok(n >= criteria.proposals + 3);
});

test('D+ max impossible à respecter : les moins vallonnés, signalés', () => {
  const route = (id, ascent) => ({ id, ascent, score: 0, distance: 10_000 });
  const { routes, maxGainUnmet } = selectRoutes([route('a', 500), route('b', 250), route('c', 380)], { ...defaultCriteria(), proposals: 2, maxGain: 100 });
  assert.equal(maxGainUnmet, true);
  assert.deepEqual(routes.map((r) => r.id), ['b', 'c']);
  assert.ok(routes.every((r) => r.overMaxGain));
});

test('sans limite de D+, rien n\'est écarté', () => {
  const route = (id, ascent, score) => ({ id, ascent, score, distance: 10_000 });
  const { routes } = selectRoutes([route('a', 900, 2), route('b', 50, 1)], { ...defaultCriteria(), proposals: 3 });
  assert.deepEqual(routes.map((r) => r.id), ['b', 'a']);
});
