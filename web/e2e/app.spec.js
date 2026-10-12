import { expect, test } from '@playwright/test';
import { encodeRouteData } from '../js/share-link.js';
import { collectErrors, generate, mockNetwork, returningUser } from './helpers.js';

test('première visite : la mise en route s\'affiche', async ({ page, context }) => {
  await mockNetwork(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await expect(page.locator('#onboarding')).toBeVisible();
  expect(errors).toEqual([]);
});

test('générer une boucle, voir le détail, l\'enregistrer en favori', async ({ page, context }) => {
  const calls = await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  expect(calls.directions).toBeGreaterThan(0);
  expect(calls.directions).toBeLessThanOrEqual(3);

  await page.click('#show-detail');
  await expect(page.locator('#details .chart-plot')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept('Boucle des berges'));
  await page.click('#save-favorite');
  await expect(page.locator('#save-favorite')).toBeDisabled();

  await page.click('#tab-library');
  await expect(page.locator('#favorites-list')).toContainText('Boucle des berges');
  await page.click('#tab-settings');
  await expect(page.locator('#quota-count')).toHaveText(new RegExp(`^${calls.directions} / 2`));
  expect(errors).toEqual([]);
});

test('lien de partage : le parcours s\'ouvre sans compte ni mise en route', async ({ page, context }) => {
  await mockNetwork(context);
  const errors = collectErrors(page);
  const coordinates = Array.from({ length: 200 }, (_, i) => {
    const angle = (i / 199) * 2 * Math.PI;
    return [45.19 + 0.03 * Math.sin(angle), 5.72 + 0.04 * (1 - Math.cos(angle))];
  });
  const route = {
    coordinates,
    distance: 18_400,
    ascent: 240,
    descent: 240,
    profile: coordinates.map((_, i) => ({ distance: i * 92, elevation: 220 + 60 * Math.sin(i / 30) })),
  };
  const data = await encodeRouteData(route, { name: 'Tour du parc', activity: 'running' });
  await page.goto(`./#trace=${data}`);
  await expect(page.locator('.card').first()).toContainText('18,4 km');
  await expect(page.locator('#onboarding')).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(errors).toEqual([]);
});

test('hors ligne : l\'app s\'ouvre et les favoris restent consultables', async ({ page, context }) => {
  await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  page.once('dialog', (dialog) => dialog.accept('Favori hors ligne'));
  await page.click('#save-favorite');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // la page est maintenant servie par le service worker, qui a tout gardé

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#quick-generate')).toBeVisible();
  await page.click('#tab-library');
  await expect(page.locator('#favorites-list')).toContainText('Favori hors ligne');
  await page.click('#tab-route');
  await page.click('#quick-generate');
  await expect(page.locator('#toast')).toContainText('hors ligne');
  expect(errors).toEqual([]);
});

test('ajuster le tracé : une poignée déplacée recalcule le parcours (1 requête), « Tracé d\'origine » le rétablit', async ({ page, context }) => {
  const calls = await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  await page.click('#show-detail');
  const before = await page.locator('#details .detail-title').innerText();
  const requests = calls.directions;

  await page.click('#edit-route');
  await expect(page.locator('#edit-done')).toBeVisible();
  await expect(page.locator('#quick-generate')).toBeHidden();
  const handle = page.locator('.edit-handle').nth(1);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y - 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => calls.directions).toBe(requests + 1);
  await expect(page.locator('#edit-hint')).toContainText('Tracé modifié');
  await expect(page.locator('#details .detail-title')).not.toHaveText(before);

  await page.click('#edit-undo');
  await expect(page.locator('#details .detail-title')).toHaveText(before);
  await expect(page.locator('.edit-handle')).toHaveCount(0);
  await expect(page.locator('#quick-generate')).toBeVisible();
  expect(errors).toEqual([]);
});
