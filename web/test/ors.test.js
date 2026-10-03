import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { fetchRoute, OrsError, splitRoute } from '../js/ors.js';

const okResponse = () => ({
  ok: true,
  json: async () => ({
    features: [{ geometry: { coordinates: [[4.8, 45.7, 200], [4.81, 45.71, 210]] }, properties: { summary: { distance: 1500 } } }],
  }),
});

test('réseau injoignable ou refus d\'ORS : erreur bloquante, qui liste les causes possibles', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Load failed');
  });
  await assert.rejects(fetchRoute({ apiKey: 'k', profile: 'foot-walking', points: [[45.7, 4.8], [45.71, 4.81]] }), (error) => {
    assert.ok(error instanceof OrsError);
    assert.equal(error.isFatal, true);
    assert.match(error.message, /quota du jour/);
    assert.match(error.message, /40 itinéraires en une minute/);
    return true;
  });
});

test('limite par minute : au-delà de 35 requêtes, on patiente au lieu d\'échouer', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(() => mock.timers.reset());
  t.mock.method(globalThis, 'fetch', async () => okResponse());
  const points = [[45.7, 4.8], [45.71, 4.81]];
  const waits = [];
  let sent = 0;
  let done = false;
  let pending;
  // On enchaîne les requêtes jusqu'à ce que l'une doive patienter.
  while (sent < 40) {
    sent++;
    pending = fetchRoute({ apiKey: 'k', profile: 'foot-walking', points, onWait: (s) => waits.push(s) }).then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    if (waits.length) break;
    await pending;
    done = false;
  }
  assert.ok(sent >= 35 && sent <= 36, `attente à la requête ${sent}`);
  assert.equal(done, false);
  assert.ok(waits[0] > 0 && waits[0] <= 61);
  mock.timers.tick(61_000);
  await pending;
  assert.equal(done, true);
});

test('découpage d\'une requête groupée : tracés, altitudes, distances et revêtement par parcours', () => {
  // 5 points sur une ligne, 1 km entre chacun ; points envoyés aux indices 0, 2 et 4 du tracé.
  const coordinates = [0, 1, 2, 3, 4].map((i) => [45, 4 + i * 0.0127]);
  const raw = {
    coordinates,
    elevations: [100, 110, 120, 110, 100],
    distance: 8000, // la route fait le double de la ligne droite
    wayPoints: [0, 2, 4],
    extraValues: { surface: [[0, 1, 1], [1, 3, 8], [3, 4, 1]], waytype: [[0, 4, 3]] },
  };
  const [first, second] = splitRoute(raw, [[0, 1], [1, 2]]);
  assert.equal(first.coordinates.length, 3);
  assert.deepEqual(first.elevations, [100, 110, 120]);
  assert.deepEqual(second.coordinates[0], coordinates[2]);
  assert.ok(Math.abs(first.distance - 4000) < 50, `${first.distance}`);
  assert.ok(Math.abs(first.distance - second.distance) < 1);
  // 1er parcours : moitié bitume (code 1), moitié chemin (code 8).
  const amounts = Object.fromEntries(first.extras.surface.map((s) => [s.value, Math.round(s.amount)]));
  assert.deepEqual(amounts, { 1: 50, 8: 50 });
  assert.equal(second.extras.waytype[0].amount, 100);
  assert.throws(() => splitRoute({ ...raw, wayPoints: null }, [[0, 1]]));
});

test('erreur ORS : code et point en cause lus dans la réponse', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters of specified coordinate 3: 4.85 45.77.' } }),
  }));
  await assert.rejects(fetchRoute({ apiKey: 'k', profile: 'foot-walking', points: [[45.7, 4.8], [45.71, 4.81]] }), (error) => {
    assert.equal(error.code, 2010);
    assert.equal(error.coordinateIndex, 3);
    assert.equal(error.isFatal, false);
    return true;
  });
});
