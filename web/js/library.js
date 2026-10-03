// « Mes parcours » : favoris et historique des sorties.
// Sans compte, les sorties sont gardées sur l'appareil ; avec un compte, elles sont aussi en ligne.
import * as cloud from './cloud.js';
import { ACTIVITIES } from './criteria.js';
import { fromFavorite, toFavorite } from './favorites.js';
import { formatDistance, formatDuration, formatElevation } from './format.js';
import { icons } from './icons.js';
import { KEYS, storage } from './storage.js';
import { filterOutings, outingStats, randomId } from './sync.js';
import { routeThumbnail } from './thumbnail.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const today = () => new Date().toISOString().slice(0, 10);
const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const formatDate = (iso) => dateFormat.format(new Date(`${String(iso).slice(0, 10)}T12:00:00`));
const isLocal = (id) => String(id).startsWith('local-');

/** Sorties du mois en cours. */
export function monthOutings(outings, now = new Date()) {
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return outings.filter((o) => String(o.done_on).startsWith(prefix));
}

/** Combien de fois un favori a été fait (sorties du même nom et de la même activité), et la dernière date. */
export function timesDone(favorite, outings) {
  const matching = outings.filter((o) => o.name === favorite.name && o.activity === favorite.activity);
  const last = matching.map((o) => String(o.done_on)).sort().at(-1) ?? null;
  return { count: matching.length, last };
}

/**
 * @param {object} hooks
 * @param {() => object[]} hooks.getFavorites
 * @param {(id: string) => void} hooks.removeFavorite
 * @param {(route: object, activity: string) => void} hooks.openRoute
 * @param {() => boolean} hooks.isSignedIn
 * @param {(message: string, isError?: boolean) => void} hooks.setStatus
 */
export function initLibrary(hooks) {
  let outings = [];
  let tab = 'favorites';
  let period = '30';
  let loadError = '';

  // MARK: Sorties : appareil + compte

  const localOutings = () => storage.get(KEYS.outings, []);

  async function loadOutings() {
    const mine = localOutings();
    loadError = '';
    if (!hooks.isSignedIn()) return mine;
    try {
      const remote = await cloud.fetchOutings();
      return [...remote, ...mine].sort((a, b) => String(b.done_on).localeCompare(String(a.done_on)));
    } catch (error) {
      loadError = `Sorties en ligne indisponibles : ${error.message}`;
      return mine;
    }
  }

  async function addOuting(outing) {
    if (hooks.isSignedIn()) return cloud.addOuting(outing);
    const saved = { id: `local-${randomId(10)}`, created_at: new Date().toISOString(), ...outing };
    if (!storage.set(KEYS.outings, [saved, ...localOutings()])) {
      throw new Error('Le stockage de ce navigateur est plein ou désactivé.');
    }
    return saved;
  }

  async function deleteOuting(id) {
    if (isLocal(id)) storage.set(KEYS.outings, localOutings().filter((o) => o.id !== id));
    else await cloud.deleteOuting(id);
  }

  // MARK: Affichage

  const routeItem = ({ open, remove, removeLabel, thumbnail, title, lines }) => `
    <li class="route-item">
      <button type="button" class="route-open" ${open}>
        ${thumbnail}
        <span class="route-text">
          <strong>${title}</strong>
          ${lines.filter(Boolean).map((line) => `<small>${line}</small>`).join('')}
        </span>
      </button>
      <button type="button" class="item-action" ${remove} aria-label="${removeLabel}">${icons.trash}</button>
    </li>`;

  function renderSummary() {
    const month = monthOutings(outings);
    const stats = outingStats(month);
    $('month-summary').innerHTML = month.length
      ? `<div><small>Ce mois-ci</small><strong>${stats.count} sortie${stats.count > 1 ? 's' : ''} · ${formatDistance(stats.distance)}</strong></div>
         <span>↗ ${formatElevation(stats.ascent)}</span>`
      : '<div><small>Ce mois-ci</small><strong>Aucune sortie pour l\'instant</strong></div><span class="muted">« Marquer fait » après une sortie</span>';
  }

  function renderFavorites() {
    const favorites = hooks.getFavorites();
    $('favorites-count').textContent = favorites.length ? `· ${favorites.length}` : '';
    $('favorites-list').innerHTML = favorites.length
      ? favorites
          .map((favorite) => {
            const { count, last } = timesDone(favorite, outings);
            const done = count ? `Fait ${count} fois · dernière le ${formatDate(last)}` : 'Pas encore fait';
            return routeItem({
              open: `data-open-favorite="${favorite.id}"`,
              remove: `data-delete-favorite="${favorite.id}"`,
              removeLabel: `Supprimer ${escapeHtml(favorite.name)}`,
              thumbnail: routeThumbnail(favorite.route.coordinates),
              title: escapeHtml(favorite.name),
              lines: [
                `${ACTIVITIES[favorite.activity]?.label ?? ''} · ${formatDistance(favorite.route.distance)} · ↗ ${formatElevation(favorite.route.ascent)}`,
                done,
              ],
            });
          })
          .join('')
      : '<li class="list-empty">Aucun favori pour l\'instant. Touchez l\'icône d\'enregistrement sous un parcours pour le garder ici.</li>';
  }

  function renderHistory() {
    $('history-count').textContent = outings.length ? `· ${outings.length}` : '';
    const shown = filterOutings(outings, period);
    const stats = outingStats(shown);
    $('outing-stats').innerHTML = [
      ['Sorties', String(stats.count)],
      ['Distance', formatDistance(stats.distance)],
      ['D+', formatElevation(stats.ascent)],
      ['Temps', stats.duration ? formatDuration(stats.duration) : '–'],
    ]
      .map(([label, value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`)
      .join('');
    $('outings-list').innerHTML = shown.length
      ? shown
          .map((o) =>
            routeItem({
              open: `data-open-outing="${o.id}" ${o.route ? '' : 'disabled'}`,
              remove: `data-delete-outing="${o.id}"`,
              removeLabel: `Supprimer la sortie ${escapeHtml(o.name)}`,
              thumbnail: o.route ? routeThumbnail(o.route.coordinates) : '<span class="thumbnail thumbnail-empty"></span>',
              title: escapeHtml(o.name),
              lines: [
                `${formatDate(o.done_on)} · ${ACTIVITIES[o.activity]?.label ?? ''}`,
                `${formatDistance(o.distance_m)} · ↗ ${formatElevation(o.ascent_m)}${o.duration_s ? ` · ${formatDuration(o.duration_s)}` : ''}`,
              ],
            }),
          )
          .join('')
      : '<li class="list-empty">Aucune sortie sur cette période. Touchez « Marquer fait » sous un parcours après l\'avoir fait.</li>';
    $('history-note').textContent =
      loadError ||
      (hooks.isSignedIn()
        ? ''
        : cloud.cloudEnabled
          ? 'Sorties gardées sur cet appareil. Connectez-vous (Réglages ▸ Compte) pour les retrouver partout.'
          : 'Sorties gardées sur cet appareil.');
  }

  function render() {
    $('library-favorites').hidden = tab !== 'favorites';
    $('library-history').hidden = tab !== 'history';
    renderSummary();
    renderFavorites();
    renderHistory();
  }

  async function refresh() {
    outings = await loadOutings();
    render();
  }

  // MARK: Interactions

  $('library-tabs').addEventListener('change', (event) => {
    tab = event.target.value;
    render();
  });

  $('outing-period').addEventListener('change', (event) => {
    period = event.target.value;
    renderHistory();
  });

  $('favorites-list').addEventListener('click', (event) => {
    const openId = event.target.closest('[data-open-favorite]')?.dataset.openFavorite;
    const deleteId = event.target.closest('[data-delete-favorite]')?.dataset.deleteFavorite;
    const favorite = hooks.getFavorites().find((f) => f.id === (openId ?? deleteId));
    if (!favorite) return;
    if (openId) {
      hooks.openRoute({ ...fromFavorite(favorite), name: favorite.name }, favorite.activity);
    } else if (window.confirm(`Supprimer « ${favorite.name} » ?`)) {
      hooks.removeFavorite(favorite.id);
      render();
    }
  });

  $('outings-list').addEventListener('click', async (event) => {
    const openId = event.target.closest('[data-open-outing]')?.dataset.openOuting;
    const deleteId = event.target.closest('[data-delete-outing]')?.dataset.deleteOuting;
    const outing = outings.find((o) => o.id === (openId ?? deleteId));
    if (!outing) return;
    if (openId) {
      if (outing.route) hooks.openRoute({ ...fromFavorite({ id: `outing-${outing.id}`, route: outing.route }), name: outing.name }, outing.activity);
    } else if (window.confirm(`Supprimer la sortie « ${outing.name} » ?`)) {
      try {
        await deleteOuting(outing.id);
        outings = outings.filter((o) => o.id !== outing.id);
        render();
      } catch (error) {
        hooks.setStatus(error.message, true);
      }
    }
  });

  // MARK: « Marquer comme fait »

  const dialog = $('outing-dialog');
  let pending = null;
  const dialogStatus = (text, kind = '') => {
    $('outing-status').textContent = text;
    $('outing-status').className = `key-status ${kind}`;
  };

  function logOuting(route, { activity, name, duration }) {
    pending = { route, activity };
    $('outing-name').value = name;
    $('outing-date').value = today();
    $('outing-date').max = today();
    const minutes = Math.round(duration / 60);
    $('outing-hours').value = Math.floor(minutes / 60);
    $('outing-minutes').value = minutes % 60;
    dialogStatus('');
    dialog.showModal();
  }

  $('outing-cancel').addEventListener('click', () => dialog.close());
  $('outing-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { route, activity } = pending;
    const duration = (Number($('outing-hours').value) || 0) * 3600 + (Number($('outing-minutes').value) || 0) * 60;
    try {
      await addOuting({
        name: $('outing-name').value.trim().slice(0, 120) || 'Sortie',
        activity,
        done_on: $('outing-date').value || today(),
        distance_m: Math.round(route.distance),
        ascent_m: route.ascent == null ? null : Math.round(route.ascent),
        duration_s: duration || null,
        route: toFavorite(route, { name: 'sortie', activity }).route,
      });
      dialog.close();
      hooks.setStatus('Sortie ajoutée à votre historique (Mes parcours ▸ Historique).');
      refresh();
    } catch (error) {
      dialogStatus(error.message, 'error');
    }
  });

  return { refresh, logOuting };
}
