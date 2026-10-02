import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { autocomplete, parseGeocodeResults, reverse } from '../js/geocode.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const feature = (label, lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { label } });

test('analyse : coordonnées remises dans l\'ordre [lat, lon], résultats incomplets ignorés', () => {
  const results = parseGeocodeResults({
    features: [feature('Place Bellecour, Lyon, France', 4.8323, 45.7578), { properties: { label: 'sans géométrie' } }],
  });
  assert.deepEqual(results, [{ label: 'Place Bellecour, Lyon, France', point: [45.7578, 4.8323] }]);
  assert.deepEqual(parseGeocodeResults(null), []);
});

test('autocomplétion : texte, langue et point de priorité envoyés, clé dans l\'en-tête', async () => {
  let called;
  globalThis.fetch = async (url, options) => {
    called = { url: new URL(url), options };
    return new Response(JSON.stringify({ features: [feature('Parc de la Tête d\'Or, Lyon', 4.852, 45.777)] }), { status: 200 });
  };
  const results = await autocomplete({ apiKey: 'cle', text: 'tête d\'or', focus: [45.764, 4.8357] });
  assert.equal(called.url.pathname, '/geocode/autocomplete');
  assert.equal(called.url.searchParams.get('text'), 'tête d\'or');
  assert.equal(called.url.searchParams.get('lang'), 'fr');
  assert.equal(called.url.searchParams.get('focus.point.lat'), '45.76400');
  assert.equal(called.options.headers.Authorization, 'cle');
  assert.equal(results[0].label, 'Parc de la Tête d\'Or, Lyon');
});

test('adresse d\'un point et erreurs lisibles', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ features: [feature('12 Rue X, Lyon', 4.83, 45.76)] }), { status: 200 });
  assert.equal(await reverse({ apiKey: 'k', point: [45.76, 4.83] }), '12 Rue X, Lyon');

  globalThis.fetch = async () => new Response('{}', { status: 429 });
  await assert.rejects(autocomplete({ apiKey: 'k', text: 'abc' }), /Quota/);
  globalThis.fetch = async () => new Response('{}', { status: 403 });
  await assert.rejects(reverse({ apiKey: 'k', point: [0, 0] }), /Clé OpenRouteService invalide/);
});
