import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { autocomplete, parseGeocodeResults, parsePhotonResults, photonLabel, reverse } from '../js/geocode.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const feature = (properties, lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('analyse ORS : coordonnées remises dans l\'ordre [lat, lon], résultats incomplets ignorés', () => {
  const results = parseGeocodeResults({
    features: [feature({ label: 'Place Bellecour, Lyon, France' }, 4.8323, 45.7578), { properties: { label: 'sans géométrie' } }],
  });
  assert.deepEqual(results, [{ label: 'Place Bellecour, Lyon, France', point: [45.7578, 4.8323] }]);
  assert.deepEqual(parseGeocodeResults(null), []);
});

test('ORS : clé et paramètres dans l\'adresse, aucun en-tête personnalisé (pas de pré-requête CORS)', async () => {
  let called;
  globalThis.fetch = async (url, options) => {
    called = { url: new URL(url), options };
    return json({ features: [feature({ label: 'Parc de la Tête d\'Or, Lyon' }, 4.852, 45.777)] });
  };
  const results = await autocomplete({ apiKey: 'cle', text: 'tête d\'or', focus: [45.764, 4.8357] });
  assert.equal(called.url.host, 'api.openrouteservice.org');
  assert.equal(called.url.pathname, '/geocode/autocomplete');
  assert.equal(called.url.searchParams.get('api_key'), 'cle');
  assert.equal(called.url.searchParams.get('text'), 'tête d\'or');
  assert.equal(called.url.searchParams.get('focus.point.lat'), '45.76400');
  assert.equal(called.options.headers, undefined);
  assert.equal(results[0].label, 'Parc de la Tête d\'Or, Lyon');
});

test('secours Photon quand ORS est injoignable', async () => {
  const hosts = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    hosts.push(u.host);
    if (u.host === 'api.openrouteservice.org') throw new TypeError('Failed to fetch');
    assert.equal(u.searchParams.get('q'), 'bellecour');
    assert.equal(u.searchParams.has('api_key'), false);
    return json({ features: [feature({ name: 'Place Bellecour', postcode: '69002', city: 'Lyon', country: 'France' }, 4.8323, 45.7578)] });
  };
  const results = await autocomplete({ apiKey: 'k', text: 'bellecour', focus: [45.76, 4.83] });
  assert.deepEqual(hosts, ['api.openrouteservice.org', 'photon.komoot.io']);
  assert.deepEqual(results, [{ label: 'Place Bellecour, 69002 Lyon, France', point: [45.7578, 4.8323] }]);
});

test('secours Photon aussi sans clé et pour retrouver l\'adresse d\'un point', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    assert.equal(u.host, 'photon.komoot.io');
    return json({ features: [feature({ housenumber: '12', street: 'Rue de la République', postcode: '69001', city: 'Lyon', country: 'France' }, 4.836, 45.763)] });
  };
  assert.equal(await reverse({ apiKey: '', point: [45.763, 4.836] }), '12 Rue de la République, 69001 Lyon, France');
});

test('erreur d\'origine conservée si les deux services échouent', async () => {
  globalThis.fetch = async (url) => (new URL(url).host === 'api.openrouteservice.org' ? json({}, 429) : json({}, 500));
  await assert.rejects(autocomplete({ apiKey: 'k', text: 'abc' }), /Quota/);
});

test('libellés Photon sans répétition', () => {
  assert.equal(photonLabel({ name: 'Lyon', city: 'Lyon', country: 'France' }), 'Lyon, France');
  assert.equal(photonLabel({ name: 'Gare Part-Dieu', street: 'Place Charles Béraudier', postcode: '69003', city: 'Lyon' }), 'Gare Part-Dieu, Place Charles Béraudier, 69003 Lyon');
  assert.deepEqual(parsePhotonResults({ features: [feature({}, 1, 2)] }), []);
});
