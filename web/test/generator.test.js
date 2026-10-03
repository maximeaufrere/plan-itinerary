import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { defaultCriteria, estimatedDuration, sanitizeCriteria, score } from '../js/criteria.js';
import { generateRoutes, resetSession, selectRoutes } from '../js/generator.js';
import { cumulativeDistances, distance, destination } from '../js/geo.js';
import { toGpx } from '../js/gpx.js';
import { OrsError } from '../js/ors.js';

const start = [45.7640, 4.8357];

beforeEach(() => resetSession());

/**
 * Faux ORS : le tracé suit les points envoyés (avec un point au milieu de chaque tronçon), la distance vaut
 * `detour` fois la ligne droite, et `climbFor(milieu)` donne l'altitude gagnée au milieu de chaque tronçon.
 */
function fakeOrs({ detour = 1.25, climbFor = () => 50, fail } = {}) {
  const calls = [];
  const fetchRoute = async (request) => {
    calls.push(request);
    fail?.(request, calls.length);
    const points = request.points;
    const coordinates = [];
    const elevations = [];
    const wayPoints = [];
    points.forEach((point, i) => {
      if (i > 0) {
        const mid = [(points[i - 1][0] + point[0]) / 2, (points[i - 1][1] + point[1]) / 2];
        coordinates.push(mid);
        elevations.push(200 + climbFor(mid));
      }
      wayPoints.push(coordinates.length);
      coordinates.push(point);
      elevations.push(200);
    });
    return {
      coordinates,
      elevations,
      distance: cumulativeDistances(coordinates).at(-1) * detour,
      ascent: null,
      descent: null,
      extras: {},
      wayPoints,
      extraValues: {},
    };
  };
  return { calls, fetchRoute };
}

/** Nombre de parcours dans une requête de boucles : chaque passage au départ, sauf le premier. */
const loopsIn = (call) => call.points.filter((p) => p[0] === start[0] && p[1] === start[1]).length - 1;

test('boucles : plusieurs formes tracées en une seule requête, puis découpées', async () => {
  const criteria = { ...defaultCriteria(), distanceKm: 10, proposals: 3 };
  const { calls, fetchRoute } = fakeOrs();

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(calls.length, 1, 'une seule requête pour toute la génération');
  assert.equal(loopsIn(calls[0]), 4, '3 propositions + 1 candidat');
  assert.equal(routes.length, 3);
  for (const route of routes) {
    assert.deepEqual(route.coordinates[0], start);
    assert.deepEqual(route.coordinates.at(-1), start);
    assert.ok(Math.abs(route.distance - 10_000) < 1000, `${route.distance}`);
    assert.ok(route.ascent > 0);
  }
});

test('boucles : les formes trop longues sont corrigées ensemble, en une requête de plus', async () => {
  const criteria = { ...defaultCriteria(), distanceKm: 10, proposals: 3 };
  // Les routes font 1,6 fois la ligne droite, plus que les 1,25 prévus : +28 %.
  const { calls, fetchRoute } = fakeOrs({ detour: 1.6 });

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(calls.length, 2);
  assert.equal(loopsIn(calls[1]), 4);
  for (const route of routes) assert.ok(Math.abs(route.distance - 10_000) < 200, `${route.distance}`);
});

test('boucles : relief estimé avant le tracé, les formes plates passent en premier', async () => {
  // Terrain fictif : plat au sud du départ, très pentu au nord.
  const terrain = {
    load: async () => {},
    elevationAt: ([lat]) => (lat > start[0] ? 200 + (lat - start[0]) * 50_000 : 200),
  };
  const criteria = { ...defaultCriteria(), elevation: 'flat', proposals: 2 };
  const { calls, fetchRoute } = fakeOrs();

  await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain });

  const centerLat = calls[0].points.reduce((sum, [lat]) => sum + lat, 0) / calls[0].points.length;
  assert.ok(centerLat < start[0] - 0.003, 'les formes retenues partent vers le sud');
});

test('une forme impossible à tracer est remplacée, les autres sont retracées ensemble', async () => {
  const criteria = { ...defaultCriteria(), proposals: 1 };
  const { calls, fetchRoute } = fakeOrs({
    fail: (request, n) => {
      // Premier essai : le dernier point de passage (2e boucle) est dans un lac.
      if (n === 1) throw new OrsError('Point non routable', 404, { code: 2010, coordinateIndex: request.points.length - 2 });
    },
  });

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(routes.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(loopsIn(calls[1]), 2, 'la 1re boucle + une forme de rechange');
  assert.deepEqual(calls[1].points[1], calls[0].points[1], 'la 1re boucle est reprise telle quelle');
});

test('requête refusée sans coupable identifié : les formes sont retracées une par une', async () => {
  const criteria = { ...defaultCriteria(), proposals: 1 };
  const { calls, fetchRoute } = fakeOrs({
    fail: (_, n) => {
      if (n === 1) throw new OrsError('Itinéraire trop long', 400, { code: 2004 });
    },
  });

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(routes.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(loopsIn(calls[1]), 1);
  assert.equal(loopsIn(calls[2]), 1);
});

test('réponse illisible pour une requête groupée : on retente une par une, puis on s\'arrête', async () => {
  const criteria = { ...defaultCriteria(), proposals: 1 };
  const { calls, fetchRoute } = fakeOrs({
    fail: () => {
      throw new OrsError('OpenRouteService ne répond pas', 0);
    },
  });

  await assert.rejects(generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null }), /ne répond pas/);
  assert.equal(calls.length, 2, 'la requête groupée, puis une seule requête individuelle');
});

test('boucles ORS en dernier recours si aucune forme ne passe', async () => {
  const criteria = { ...defaultCriteria(), proposals: 1 };
  const { calls, fetchRoute } = fakeOrs({
    fail: (request) => {
      if (!request.roundTrip) throw new OrsError('Point non routable', 404);
    },
  });
  const fallback = async (request) => {
    if (request.roundTrip) {
      calls.push(request);
      return { coordinates: [start, destination(start, 2500, 90), start], elevations: null, distance: 10_000, ascent: 10, descent: 10 };
    }
    return fetchRoute(request);
  };

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute: fallback, terrain: null });

  assert.equal(routes.length, 1);
  assert.ok(calls.at(-1).roundTrip);
  assert.ok(calls.filter((c) => !c.roundTrip).length <= 8);
});

test('aller-retour : plusieurs demi-tours enchaînés dans la même requête', async () => {
  const criteria = { ...defaultCriteria(), shape: 'out_and_back', proposals: 1 };
  const { calls, fetchRoute } = fakeOrs();

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].points.length, 5);
  for (const i of [0, 2, 4]) assert.deepEqual(calls[0].points[i], start);
  assert.equal(calls[0].roundTrip, undefined);
  assert.equal(routes.length, 1);
});

test('classe les propositions selon le dénivelé souhaité', async () => {
  const criteria = { ...defaultCriteria(), elevation: 'flat', proposals: 2 };
  // Relief à l'est du départ seulement.
  const { fetchRoute } = fakeOrs({ climbFor: ([, lon]) => (lon > start[1] ? 150 : 2) });

  const { routes } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(routes.length, 2);
  assert.ok(routes[0].ascent <= routes[1].ascent);
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
  const { calls, fetchRoute } = fakeOrs();

  const result = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(calls.length, 1);
  assert.equal(result.directIsLonger, true);
  assert.equal(result.routes.length, 1);
});

test('A → B : détours sur une ellipse de foyers A et B, des deux côtés, tracés en une requête', async () => {
  const end = destination(start, 4000, 90);
  const criteria = { ...defaultCriteria(), shape: 'point_to_point', distanceKm: 10, proposals: 2 };
  // Trajet direct : 5 km ; les détours font 10 km.
  const { calls, fetchRoute } = fakeOrs();

  const { routes, directIsLonger } = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(directIsLonger, undefined);
  assert.equal(calls.length, 2, 'trajet direct + une requête pour tous les détours');
  assert.equal(routes.length, 2);
  // Requête groupée : A, W1, B, A, W2, B, A, W3, B (les liaisons B → A sont écartées).
  const detours = [1, 4, 7].map((i) => calls[1].points[i]);
  const expectedSum = 10_000 / 1.25;
  for (const waypoint of detours) {
    assert.ok(Math.abs(distance(start, waypoint) + distance(waypoint, end) - expectedSum) < 20);
  }
  // Angles 90° puis 270° : un détour de chaque côté de l'axe A → B (orienté est-ouest ici).
  assert.ok((detours[0][0] - start[0]) * (detours[1][0] - start[0]) < 0);
  for (const route of routes) {
    assert.deepEqual(route.coordinates[0], start);
    assert.deepEqual(route.coordinates.at(-1), end);
    assert.ok(Math.abs(route.distance - 10_000) < 100, `${route.distance}`);
  }
});

test('Générer à nouveau : parcours non affichés réutilisés, trajet direct et échelle mémorisés', async () => {
  const end = destination(start, 4000, 90);
  const criteria = { ...defaultCriteria(), shape: 'point_to_point', distanceKm: 10, proposals: 2 };
  const { calls, fetchRoute } = fakeOrs({ detour: 1.6 });

  const first = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute, terrain: null });
  const before = calls.length;
  const second = await generateRoutes({ start, end, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(calls.length - before, 1, 'une seule requête : ni trajet direct, ni correction d\'échelle');
  assert.equal(calls.at(-1).points.length, 6, 'deux nouveaux détours : 3 candidats - 1 déjà tracé');
  const firstIds = new Set(first.routes.map((r) => r.id));
  assert.ok(second.routes.every((r) => !firstIds.has(r.id)), 'de nouvelles propositions');
  assert.equal(second.routes.length, 2);

  // Critères modifiés : on repart de zéro.
  const third = calls.length;
  await generateRoutes({ start, end, criteria: { ...criteria, distanceKm: 11 }, apiKey: 'k', fetchRoute, terrain: null });
  assert.deepEqual(calls[third].points, [start, end], 'le trajet direct est redemandé');
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
  // Relief nettement à l'est du départ seulement : seules les boucles orientées vers l'est le traversent.
  const { calls, fetchRoute } = fakeOrs({ climbFor: ([, lon]) => (lon > start[1] + 0.012 ? 150 : 5) });
  const criteria = { ...defaultCriteria(), proposals: 3, maxGain: 200 };

  const { routes, maxGainUnmet } = await generateRoutes({ start, criteria, apiKey: 'k', fetchRoute, terrain: null });

  assert.equal(maxGainUnmet, undefined);
  assert.ok(routes.length > 0);
  assert.ok(routes.every((r) => r.ascent <= 200), routes.map((r) => r.ascent).join(','));
  // Davantage de formes tracées quand une limite de D+ est fixée, toujours en une requête.
  assert.equal(calls.length, 1);
  assert.equal(loopsIn(calls[0]), criteria.proposals + 3);
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
