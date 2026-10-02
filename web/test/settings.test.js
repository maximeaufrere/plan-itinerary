import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeFavorites, parseFavoritesFile } from '../js/settings.js';

const favorite = (id) => ({ id, name: `Parcours ${id}`, activity: 'running', savedAt: '2026-10-02T10:00:00.000Z', route: { coordinates: [], profile: [], distance: 1000 } });

test('import : ajoute les nouveaux favoris sans doublon', () => {
  const { favorites, added } = mergeFavorites([favorite('a')], [favorite('a'), favorite('b'), { id: 'cassé' }]);
  assert.deepEqual(favorites.map((f) => f.id), ['a', 'b']);
  assert.equal(added, 1);
});

test('import : accepte un export complet ou une simple liste', () => {
  const exported = JSON.stringify({ app: 'plan-itinerary', version: 1, favorites: [favorite('a')] });
  assert.equal(parseFavoritesFile(exported).length, 1);
  assert.equal(parseFavoritesFile(JSON.stringify([favorite('a'), favorite('b')])).length, 2);
});

test('import : refuse un fichier sans favoris', () => {
  assert.throws(() => parseFavoritesFile('{"hello": 1}'), /ne contient pas de favoris/);
  assert.throws(() => parseFavoritesFile('pas du json'), SyntaxError);
});
