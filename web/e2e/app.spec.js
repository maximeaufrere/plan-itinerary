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
  await page.click('#quick-save');
  await expect(page.locator('#quick-save')).toBeDisabled();

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
  await page.click('#quick-save');
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
  const before = await page.locator('.card[aria-selected="true"] strong').innerText();
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
  await expect(page.locator('.card[aria-selected="true"] strong')).not.toHaveText(before);

  await page.click('#edit-undo');
  await expect(page.locator('.card[aria-selected="true"] strong')).toHaveText(before);
  await expect(page.locator('.edit-handle')).toHaveCount(0);
  await expect(page.locator('#quick-generate')).toBeVisible();
  expect(errors).toEqual([]);
});

test('nouveauté : après un favori, les propositions indiquent leur part de chemins nouveaux', async ({ page, context }) => {
  await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  await expect(page.locator('.card-novelty')).toHaveCount(0); // pas encore d'historique
  page.once('dialog', (dialog) => dialog.accept('Boucle connue'));
  await page.click('#quick-save');
  await page.click('#quick-generate'); // « Autres parcours »
  await expect(page.locator('.card-novelty').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.card-novelty').first()).toHaveText(/nouveau|Déjà fait/);
  expect(errors).toEqual([]);
});

test('« Modifier » ouvre une nouvelle recherche à part ; la flèche ramène aux propositions', async ({ page, context }) => {
  await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  await expect(page.locator('#quick-generate-label')).toHaveText('Autres parcours');

  await page.click('#edit-criteria');
  await expect(page.locator('#new-search-header')).toBeVisible();
  await expect(page.locator('#results')).toBeHidden();
  await expect(page.locator('#quick-generate-label')).toHaveText('Générer');

  await page.click('#back-to-results');
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#new-search-header')).toBeHidden();
  await expect(page.locator('#quick-generate-label')).toHaveText('Autres parcours');

  // Nouvelle recherche puis calcul : on retrouve des propositions, l'écran de recherche se referme.
  await page.click('#edit-criteria');
  await page.click('#quick-generate');
  await expect(page.locator('#results')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#new-search-header')).toBeHidden();
  expect(errors).toEqual([]);
});

test('critères impossibles : aucune proposition, les causes à la place, sans requête', async ({ page, context }) => {
  const calls = await mockNetwork(context);
  await returningUser(context, { criteria: { activity: 'running', distanceKm: 10, elevation: 'hilly', maxGain: 100 } });
  const errors = collectErrors(page);
  await page.goto('./');
  await expect(page.locator('.start-marker')).toBeVisible();
  await page.click('#quick-generate');
  await expect(page.locator('#unmet')).toBeVisible();
  await expect(page.locator('#unmet-reasons')).toContainText('au moins 250 m');
  await expect(page.locator('#results')).toBeHidden();
  expect(calls.directions).toBe(0);

  // Changer un critère efface l'explication.
  await page.click('#open-more');
  await page.click('#elevation label:nth-child(1)');
  await expect(page.locator('#unmet')).toBeHidden();
  expect(errors).toEqual([]);
});

test('suivre le parcours : distance parcourue et restante, puis arrêt', async ({ page, context }) => {
  await mockNetwork(context);
  await returningUser(context);
  const errors = collectErrors(page);
  await page.goto('./');
  await generate(page);
  await page.click('#show-detail');
  await page.click('#follow-route');
  await expect(page.locator('#follow-stop')).toBeVisible();
  await expect(page.locator('#quick-generate')).toBeHidden();
  // Position simulée au départ du parcours (voir playwright.config.js).
  await expect(page.locator('#follow-info')).toContainText(/parcourus · reste|Hors du parcours/);
  await page.click('#follow-stop');
  await expect(page.locator('#follow-info')).toBeHidden();
  await expect(page.locator('#quick-generate')).toBeVisible();
  expect(errors).toEqual([]);
});

test('clavier : ← / → changent de proposition', async ({ page, context }) => {
  await mockNetwork(context);
  await returningUser(context);
  await page.goto('./');
  await generate(page);
  const first = await page.locator('.card').first().getAttribute('data-id');
  await expect(page.locator('.card[aria-selected="true"]')).toHaveAttribute('data-id', first);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.card[aria-selected="true"]')).not.toHaveAttribute('data-id', first);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.card[aria-selected="true"]')).toHaveAttribute('data-id', first);
});
