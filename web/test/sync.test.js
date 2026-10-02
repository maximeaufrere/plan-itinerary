import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffFavorites, filterOutings, mergeFavoriteLists, newerSettings, outingStats, randomId } from '../js/sync.js';

const fav = (id, savedAt = '2026-10-01T10:00:00Z') => ({ id, name: id, activity: 'running', savedAt, route: {} });

test('fusion : envoie les favoris créés hors connexion', () => {
  const { favorites, toUpload } = mergeFavoriteLists([fav('local')], [fav('remote')], []);
  assert.deepEqual(favorites.map((f) => f.id).sort(), ['local', 'remote']);
  assert.deepEqual(toUpload.map((f) => f.id), ['local']);
});

test('fusion : oublie un favori supprimé depuis un autre appareil', () => {
  const { favorites, toUpload } = mergeFavoriteLists([fav('gone'), fav('kept')], [fav('kept')], ['gone', 'kept']);
  assert.deepEqual(favorites.map((f) => f.id), ['kept']);
  assert.equal(toUpload.length, 0);
});

test('fusion : trie du plus récent au plus ancien', () => {
  const { favorites } = mergeFavoriteLists([fav('a', '2026-01-01T00:00:00Z')], [fav('b', '2026-06-01T00:00:00Z')]);
  assert.deepEqual(favorites.map((f) => f.id), ['b', 'a']);
});

test('différences entre deux listes de favoris', () => {
  const { added, removed } = diffFavorites([fav('a'), fav('b')], [fav('b'), fav('c')]);
  assert.deepEqual(added.map((f) => f.id), ['c']);
  assert.deepEqual(removed, ['a']);
});

test('réglages : la version la plus récente l\'emporte', () => {
  assert.equal(newerSettings(null, null), 'local');
  assert.equal(newerSettings('2026-10-02T10:00:00Z', null), 'local');
  assert.equal(newerSettings(null, { updated_at: '2026-10-02T10:00:00Z' }), 'remote');
  assert.equal(newerSettings('2026-10-02T12:00:00Z', { updated_at: '2026-10-02T10:00:00Z' }), 'local');
  assert.equal(newerSettings('2026-10-02T09:00:00Z', { updated_at: '2026-10-02T10:00:00Z' }), 'remote');
});

test('statistiques et périodes des sorties', () => {
  const outings = [
    { activity: 'running', done_on: '2026-09-25', distance_m: 10_000, ascent_m: 100, duration_s: 3600 },
    { activity: 'bike', done_on: '2026-05-01', distance_m: 40_000, ascent_m: 400, duration_s: 7200 },
    { activity: 'running', done_on: '2025-12-31', distance_m: 5_000, ascent_m: null, duration_s: null },
  ];
  const today = new Date('2026-10-02T12:00:00Z');
  assert.equal(filterOutings(outings, '30', today).length, 1);
  assert.equal(filterOutings(outings, 'year', today).length, 2);
  assert.equal(filterOutings(outings, 'all', today).length, 3);
  const stats = outingStats(outings);
  assert.equal(stats.count, 3);
  assert.equal(stats.distance, 55_000);
  assert.equal(stats.ascent, 500);
  assert.equal(stats.byActivity.running, 15_000);
});

test('identifiant de partage : longueur et alphabet sans caractères ambigus', () => {
  const id = randomId(12);
  assert.match(id, /^[A-Za-z0-9]{12}$/);
  assert.doesNotMatch(id, /[0O1lI]/);
  assert.notEqual(randomId(12), id);
});
