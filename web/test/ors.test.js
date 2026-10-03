import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { fetchRoute, OrsError } from '../js/ors.js';

const okResponse = () => ({
  ok: true,
  json: async () => ({
    features: [{ geometry: { coordinates: [[4.8, 45.7, 200], [4.81, 45.71, 210]] }, properties: { summary: { distance: 1500 } } }],
  }),
});

test('réseau injoignable : erreur bloquante, qui évoque la limite par minute', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Load failed');
  });
  await assert.rejects(fetchRoute({ apiKey: 'k', profile: 'foot-walking', points: [[45.7, 4.8], [45.71, 4.81]] }), (error) => {
    assert.ok(error instanceof OrsError);
    assert.equal(error.isFatal, true);
    assert.match(error.message, /40 itinéraires par minute/);
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
