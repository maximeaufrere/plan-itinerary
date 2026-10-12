// Réseau simulé : fonds de carte, relief et OpenRouteService répondent sans sortir de la machine.
import { expect } from '@playwright/test';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPo6OgAAAKCAUFlbCB0AAAAAElFTkSuQmCC', 'base64');

/** Itinéraire plausible passant par les points demandés (petits zigzags, altitude qui varie). */
function fakeDirections(body) {
  const points = body.coordinates;
  const coordinates = [];
  const wayPoints = [];
  points.forEach((point, i) => {
    if (i) {
      const previous = points[i - 1];
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        coordinates.push([
          previous[0] + (point[0] - previous[0]) * t + Math.sin(k + i) * 0.0008,
          previous[1] + (point[1] - previous[1]) * t + Math.cos(k * i) * 0.0006,
          215 + 40 * Math.sin(i + t * 3) + i * 3,
        ]);
      }
    }
    wayPoints.push(coordinates.length);
    coordinates.push([point[0], point[1], 215]);
  });
  let distance = 0;
  for (let i = 1; i < coordinates.length; i++) {
    distance += Math.hypot((coordinates[i][0] - coordinates[i - 1][0]) * 78_600, (coordinates[i][1] - coordinates[i - 1][1]) * 111_200);
  }
  const n = coordinates.length - 1;
  const third = Math.floor(n / 3);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          summary: { distance: distance * 1.25, duration: 1 },
          way_points: wayPoints,
          extras: {
            surface: { values: [[0, third, 1], [third, 2 * third, 8], [2 * third, n, 3]], summary: [] },
            waytype: { values: [[0, n, 3]], summary: [] },
          },
        },
      },
    ],
  };
}

/** Coupe tout accès extérieur et répond à la place des services utilisés par l'app. */
export async function mockNetwork(context) {
  const calls = { directions: 0 };
  await context.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  await context.route(/tile|opentopomap|cyclosm|elevation-tiles/, (route) => route.fulfill({ body: PIXEL, contentType: 'image/png' }));
  await context.route('https://api.openrouteservice.org/v2/directions/**', (route) => {
    calls.directions += 1;
    route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(fakeDirections(JSON.parse(route.request().postData()))) });
  });
  return calls;
}

/** Utilisateur déjà installé : mise en route faite, clé enregistrée. */
export async function returningUser(context, extra = {}) {
  await context.addInitScript((values) => {
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
  }, { welcomeDismissed: true, orsApiKey: 'cle-de-test', ...extra });
}

/** Erreurs JavaScript de la page, à vérifier en fin de test. */
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

export async function generate(page) {
  await expect(page.locator('.start-marker')).toBeVisible();
  await page.click('#quick-generate');
  await expect(page.locator('.card').first()).toBeVisible({ timeout: 20_000 });
}
