import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCriteria } from '../js/criteria.js';
import { cumulativeDistances, destination, distance, pointAtDistance, pointsAlong } from '../js/geo.js';
import { directionLabel, labelRoutes } from '../js/labels.js';
import { monthOutings, timesDone } from '../js/library.js';
import { formatSpeed, stepSpeed } from '../js/settings.js';
import { routeThumbnail } from '../js/thumbnail.js';

const start = [45.764, 4.8357];
const line = [start, destination(start, 1000, 90), destination(start, 2000, 90)];

test('point à une distance donnée le long d\'un tracé, avec le cap', () => {
  const found = pointAtDistance(line, 1500);
  assert.ok(Math.abs(distance(start, found.point) - 1500) < 5);
  assert.ok(Math.abs(found.bearing - 90) < 1);
  assert.deepEqual(pointAtDistance(line, -10).point, start);
  assert.ok(Math.abs(distance(start, pointAtDistance(line, 99_999).point) - 2000) < 5);
});

test('repères réguliers, recalés sur la longueur officielle', () => {
  // Tracé de 2 km à vol d'oiseau, mais 4 km par la route : un repère tous les km officiels.
  const marks = pointsAlong(line, 4000, 1000);
  assert.deepEqual(marks.map((m) => m.distance), [1000, 2000, 3000]);
  assert.ok(Math.abs(distance(start, marks[1].point) - 1000) < 5);
  const arrows = pointsAlong(line, 4000, 1000, { offset: 500 });
  assert.equal(arrows[0].distance, 500);
  assert.deepEqual(pointsAlong([start], 1000, 100), []);
});

test('flèches de sens : un petit zigzag ne fausse pas la direction', () => {
  // Tracé vers l'est avec un décrochement de 15 m vers le nord puis retour, toutes les 50 m.
  const zigzag = [start];
  for (let i = 1; i <= 40; i++) {
    const base = destination(start, i * 50, 90);
    zigzag.push(i % 2 ? destination(base, 15, 0) : base);
  }
  for (const { bearing } of pointsAlong(zigzag, 2000, 400, { offset: 200 })) {
    assert.ok(Math.abs(bearing - 90) < 20, `cap ${Math.round(bearing)}°`);
  }
});

test('direction générale d\'un parcours', () => {
  const east = [start, destination(start, 2000, 90), start];
  assert.equal(directionLabel(start, east), 'Vers l\'est');
  const north = [start, destination(start, 2000, 0), start];
  assert.equal(directionLabel(start, north, { prefix: 'Détour par' }), 'Détour par le nord');
});

test('étiquettes : chaque caractéristique va au parcours qui l\'incarne, sans doublon', () => {
  const route = (id, heading, ascent, unpaved, dist = 10_000) => ({
    id,
    distance: dist,
    ascent,
    surface: { paved: 1 - unpaved, unpaved, unknown: 0 },
    coordinates: [start, destination(start, 2000, heading), start],
  });
  const routes = [route('a', 0, 40, 0.1, 10_050), route('b', 90, 200, 0.8, 10_400), route('c', 180, 120, 0.2, 9_500)];
  const flat = labelRoutes(routes, { criteria: { ...defaultCriteria(), elevation: 'flat' }, start });
  assert.equal(flat.get('a').tag, 'La plus plate');
  // « Au plus près » reviendrait aussi à « a » : déjà étiqueté, il passe ; « b » est la plus nature.
  assert.equal(flat.get('b').tag, 'La plus nature');
  assert.equal(flat.get('c').tag, 'Vers le sud');
  assert.equal(flat.get('a').detail, '10 % de chemins');
  assert.equal(flat.get('b').detail, 'Vers l\'est');

  const single = labelRoutes([routes[1]], { criteria: defaultCriteria(), start });
  assert.equal(single.get('b').tag, 'Vers l\'est');
});

test('miniature : tracé dans le carré, départ marqué', () => {
  const svg = routeThumbnail([start, destination(start, 3000, 45), destination(start, 3000, 135), start]);
  assert.match(svg, /<path d="M[\d.]+,[\d.]+L/);
  assert.match(svg, /class="thumbnail-start"/);
  const coords = [...svg.matchAll(/(\d+\.\d),(\d+\.\d)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(coords.every((v) => v >= 8 - 0.01 && v <= 48 + 0.01), 'dans la marge de 8 px');
  assert.equal(routeThumbnail([]), '');
});

test('allure : pas de 5 s/km à pied, 1 km/h à vélo, dans les limites', () => {
  assert.equal(formatSpeed('running', stepSpeed('running', 10, 1)), '5\'55/km');
  assert.equal(formatSpeed('running', stepSpeed('running', 10, -1)), '6\'05/km');
  assert.equal(stepSpeed('road', 25, 1), 26);
  assert.equal(stepSpeed('road', 45, 1), 45);
  assert.equal(formatSpeed('bike', 18.4), '18 km/h');
});

test('historique : sorties du mois et nombre de fois qu\'un favori a été fait', () => {
  const outings = [
    { name: 'Berges', activity: 'running', done_on: '2026-10-02', distance_m: 10_000 },
    { name: 'Berges', activity: 'running', done_on: '2026-09-28', distance_m: 10_000 },
    { name: 'Berges', activity: 'bike', done_on: '2026-10-01', distance_m: 30_000 },
  ];
  assert.equal(monthOutings(outings, new Date('2026-10-15T12:00:00')).length, 2);
  assert.deepEqual(timesDone({ name: 'Berges', activity: 'running' }, outings), { count: 2, last: '2026-10-02' });
  assert.deepEqual(timesDone({ name: 'Autre', activity: 'running' }, outings), { count: 0, last: null });
  assert.ok(cumulativeDistances(line).at(-1) > 0);
});
