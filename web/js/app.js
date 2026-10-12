// Écran principal : relie la carte, le panneau, les critères, le calcul et les résultats.
import { initAccount } from './account.js';
import { initAddressField } from './address.js';
import { elevationChart, sparkline } from './chart.js';
import { ACTIVITIES, estimatedDuration } from './criteria.js';
import {
  criteriaSummary,
  initCriteriaForm,
  placeEndNext,
  placing,
  replaceCriteria,
  setCriteriaCollapsed,
  syncForm,
  updateCriteria,
} from './criteria-form.js';
import { $, escapeHtml } from './dom.js';
import { fromFavorite, isValidFavorite, toFavorite } from './favorites.js';
import { formatDistance, formatDuration, formatElevation, formatPercent } from './format.js';
import { generateRoutes } from './generator.js';
import { reverse as reverseGeocode } from './geocode.js';
import { toGpx } from './gpx.js';
import { icons } from './icons.js';
import { labelRoutes } from './labels.js';
import { initLibrary } from './library.js';
import { centerOnVisible, fitToLayer, map, revealPoint, setBaseLayer, showPoints } from './map-view.js';
import { getMyPosition, initMyPosition, isMyPosition, watchMyPosition } from './my-position.js';
import { initOnboarding } from './onboarding.js';
import { drawOutlines, setStep, showProgress } from './progress.js';
import { bindProfileCursor, decorateRoute } from './route-decor.js';
import { initSettings } from './settings.js';
import { shareOrDownload } from './share.js';
import { routeDataFromHash } from './share-link.js';
import { getSheetState, initSheet, mobileQuery, snapTo, toggleSheet } from './sheet.js';
import { isPointToPoint, selectedRoute, state } from './state.js';
import { KEYS, applyTheme, storage } from './storage.js';
import { hideToast, showToast } from './toast.js';
import { currentView, onViewChange, showView } from './views.js';

/* global L */

// Pas de zoom de la page (la carte, elle, se zoome toujours) : Safari sur iPhone ignore « user-scalable=no »,
// on bloque donc ses gestes de pincement ; le double-toucher est bloqué en CSS (touch-action).
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// MARK: - Départ et arrivée

const pinIcon = (className) => L.divIcon({ className: '', html: `<div class="${className}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const markers = { start: null, end: null };
const routeLayers = new Map();

/** Champs d'adresse (départ, arrivée), initialisés plus bas. */
const addressFields = {};

/**
 * Place le départ ou l'arrivée.
 * @param {{ label?: string }} [options]  adresse à afficher ; à défaut, elle est recherchée à partir du point
 */
function setPoint(kind, point, { label } = {}) {
  state[kind] = point;
  markResultsStale();
  if (!point) {
    markers[kind]?.remove();
    markers[kind] = null;
    addressFields[kind]?.setLabel('');
    return;
  }
  if (label !== undefined) addressFields[kind]?.setLabel(label);
  else describePoint(kind, point);
  if (markers[kind]) markers[kind].setLatLng(point);
  else {
    markers[kind] = L.marker(point, {
      icon: pinIcon(kind === 'start' ? 'start-marker' : 'end-marker'),
      title: kind === 'start' ? 'Départ' : 'Arrivée',
      keyboard: false,
    }).addTo(map);
  }
  if (kind === 'start') syncStartRing();
}

/** Affiche l'adresse d'un point touché sur la carte (si la clé OpenRouteService est disponible). */
async function describePoint(kind, point) {
  addressFields[kind]?.setLabel('Point choisi sur la carte');
  try {
    const label = await reverseGeocode({ apiKey: storage.get(KEYS.apiKey, ''), point });
    if (label && state[kind] === point) addressFields[kind]?.setLabel(label);
  } catch {
    // Sans adresse, le libellé « Point choisi sur la carte » suffit.
  }
}

/** Quand le départ est ma position, il s'affiche en anneau autour du point bleu (les deux restent visibles). */
function syncStartRing() {
  const element = markers.start?.getElement()?.querySelector('.start-marker');
  if (element) element.classList.toggle('at-me', isMyPosition(state.start));
}

map.on('click', (event) => {
  const point = [event.latlng.lat, event.latlng.lng];
  if (isPointToPoint() && placing() === 'end') {
    setPoint('end', point);
  } else {
    setPoint('start', point);
    // Après le départ, on enchaîne naturellement sur l'arrivée.
    if (isPointToPoint() && !state.end) placeEndNext();
  }
  setStatus('');
});

// MARK: - Ma position (point bleu, indépendant du départ et de l'arrivée)

initMyPosition({
  onMove: syncStartRing,
  // Au premier repérage, la position sert de départ si aucun n'a été choisi.
  onFirstFix: (point) => {
    if (state.start) return;
    setPoint('start', point, { label: 'Ma position' });
    centerOnVisible(point, 14);
  },
});

/** Bouton de localisation : recentre la carte sur ma position, sans toucher au départ ni à l'arrivée. */
async function centerOnMe() {
  $('locate').classList.add('locating');
  try {
    const point = await getMyPosition();
    centerOnVisible(point, Math.max(map.getZoom(), 15), { animate: true });
    watchMyPosition();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('locate').classList.remove('locating');
  }
}

/** Raccourci « Ma position » du champ Départ : le départ devient ma position. */
async function useMyPositionAsStart() {
  try {
    const point = await getMyPosition();
    setPoint('start', point, { label: 'Ma position' });
    setStatus('');
    showPoints(isPointToPoint() ? [state.start, state.end] : [state.start]);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// MARK: - Critères

initCriteriaForm({
  // Les propositions affichées ne correspondent plus aux critères : « Générer » redevient la seule action.
  onChange: (changes) => {
    if (!('speeds' in changes)) markResultsStale();
  },
  onSync: () => updatePeek(),
  setStatus: (message, isError) => setStatus(message, isError),
  openPace: () => settings.open('', { focusPace: true }),
});

$('locate').addEventListener('click', () => centerOnMe());
$('quick-generate').addEventListener('click', () => {
  if (state.controller) return; // le calcul en cours s'annule avec « Annuler »
  $('criteria-form').requestSubmit();
});
$('cancel-generate').addEventListener('click', () => state.controller?.abort());

/** Messages d'information dans le panneau ; les erreurs, dans la bulle près du bouton « Générer ». */
function setStatus(message, isError = false) {
  const status = $('status');
  if (isError && message) {
    // La bulle doit rester visible : la feuille ne doit ni masquer ni pousser hors de l'écran le bouton.
    if (getSheetState() !== 'mid') snapTo('mid', { fit: false });
    showToast(message);
    status.textContent = '';
    status.classList.remove('error');
    return;
  }
  if (!message) hideToast();
  status.textContent = message;
  status.classList.remove('error');
}

// MARK: - Génération

function setGenerating(isGenerating) {
  showProgress(isGenerating);
  if (!isGenerating) updateGenerateLabel();
}

$('criteria-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.controller) return;

  const apiKey = storage.get(KEYS.apiKey, '');
  if (!apiKey) {
    onboarding.askKey('Il faut une clé OpenRouteService (gratuite) pour générer des parcours.');
    return;
  }
  if (!state.start) {
    setCriteriaCollapsed(false);
    setStatus('Choisissez un départ : touchez la carte ou utilisez « Ma position ».', true);
    return;
  }
  if (isPointToPoint() && !state.end) {
    setCriteriaCollapsed(false);
    placeEndNext();
    setStatus('Touchez la carte pour placer l\'arrivée.', true);
    return;
  }

  if (navigator.onLine === false) {
    setStatus('Vous êtes hors ligne : il faut une connexion pour calculer de nouveaux parcours. Vos favoris et votre historique restent consultables.', true);
    return;
  }

  showView('route');
  const controller = new AbortController();
  state.controller = controller;
  setStatus('');
  setGenerating(true);
  // La carte doit rester visible pour suivre les formes étudiées.
  if (getSheetState() !== 'mid') snapTo('mid', { fit: false });
  $('panel-scroll').scrollTo({ top: 0 });

  try {
    const { routes, directIsLonger, maxGainUnmet, overMaxGain } = await generateRoutes({
      start: state.start,
      end: isPointToPoint() ? state.end : null,
      criteria: state.criteria,
      apiKey,
      signal: controller.signal,
      onPhase: (phase, info) => {
        if (phase === 'relief') {
          setStep(
            'step-relief',
            'done',
            info.reused ? 'Formes déjà étudiées : réutilisées' : `Relief analysé : ${info.studied} formes étudiées`,
          );
          setStep('step-trace', 'active');
        } else if (phase === 'trace') {
          drawOutlines(info.outlines);
        } else if (phase === 'rank') {
          setStep('step-trace', 'done');
          setStep('step-rank', 'active');
        }
      },
      onProgress: (done, total) => {
        setStep('step-trace', 'active', `Tracé par les chemins : ${done} sur ${total}`);
        $('quick-generate-label').textContent = `Calcul… ${done} sur ${total}`;
      },
      onWait: (seconds) => setStep('step-trace', 'active', `Pause de ${seconds} s (limite de 40 itinéraires par minute)`),
    });
    showRoutes(routes, state.criteria.activity, { fresh: true });
    const messages = [];
    if (directIsLonger) {
      messages.push(`Le trajet direct (${formatDistance(routes[0].distance)}) est déjà plus long que la distance visée : c'est lui qui est proposé.`);
    }
    if (overMaxGain && routes.length < state.criteria.proposals && !maxGainUnmet) {
      messages.push(
        `${overMaxGain} parcours écarté${overMaxGain > 1 ? 's' : ''} : plus de ${formatElevation(state.criteria.maxGain)} de D+. ` +
          '« Autres parcours » en cherche d\'autres.',
      );
    }
    if (maxGainUnmet) {
      messages.push(
        `Aucun parcours trouvé sous ${formatElevation(state.criteria.maxGain)} de D+ : voici les moins vallonnés. ` +
          'Essayez une distance plus courte, un autre départ, ou générez à nouveau.',
      );
    }
    setStatus(messages.join(' '));
  } catch (error) {
    if (error.name === 'AbortError') setStatus('Génération annulée.');
    else setStatus(error.message, true);
  } finally {
    state.controller = null;
    setGenerating(false);
  }
});

// MARK: - Résultats

/**
 * Affiche des itinéraires.
 * @param {{ fresh?: boolean }} [options]  `fresh` : ils viennent d'être générés avec les critères actuels
 *   (le bouton propose alors « Autres parcours »)
 */
function showRoutes(routes, activity, { fresh = false } = {}) {
  showView('route');
  state.routes = routes;
  state.routesActivity = activity;
  state.routesShape = state.criteria.shape;
  state.routesCriteria = { ...state.criteria };
  state.routesStart = state.start;
  state.resultsFresh = fresh;
  state.labels = labelRoutes(routes, { criteria: state.routesCriteria, start: state.start });
  renderRoutes();
  selectRoute(routes[0].id);
  setCriteriaCollapsed(true);
  updateGenerateLabel();
  $('panel-scroll').scrollTo({ top: 0 });
}

/** « Générer » devient « Autres parcours » tant que les propositions affichées correspondent aux critères. */
function updateGenerateLabel() {
  if (state.controller) return;
  const again = Boolean(state.resultsFresh && state.routes.length);
  $('quick-generate').classList.toggle('again', again);
  $('quick-generate-label').textContent = again ? 'Autres parcours' : 'Générer';
}

function markResultsStale() {
  if (!state.resultsFresh) return;
  state.resultsFresh = false;
  updateGenerateLabel();
}

const routeDuration = (route) => formatDuration(estimatedDuration(route, state.routesActivity, state.criteria.speeds));
const routeName = (route) => route.name ?? `${ACTIVITIES[state.routesActivity].label} ${formatDistance(route.distance)}`;
/** Étiquette d'une proposition (« La plus plate »…) ou nom d'un parcours enregistré. */
const routeTag = (route) => (route.name ? escapeHtml(route.name) : escapeHtml(state.labels?.get(route.id)?.tag ?? ''));

function renderRoutes() {
  for (const layer of routeLayers.values()) layer.remove();
  routeLayers.clear();

  for (const route of state.routes) {
    const layer = L.polyline(route.coordinates, { weight: 5, opacity: 0.9 }).addTo(map);
    layer.on('click', (event) => {
      L.DomEvent.stopPropagation(event); // ne pas déplacer le départ
      selectRoute(route.id);
    });
    routeLayers.set(route.id, layer);
  }

  $('cards').innerHTML = state.routes
    .map((route) => {
      const detail = route.name ? '' : state.labels?.get(route.id)?.detail ?? '';
      return `
      <button type="button" class="card" role="option" data-id="${route.id}">
        <span class="card-tag">${routeTag(route)}</span>
        <strong>${formatDistance(route.distance)}</strong>
        <span>↗ ${formatElevation(route.ascent)} · <span class="card-duration">${routeDuration(route)}</span></span>
        ${detail ? `<span class="card-detail">${escapeHtml(detail)}</span>` : ''}
        ${route.overMaxGain ? '<span class="over-limit">D+ &gt; max</span>' : ''}
        ${sparkline(route.profile)}
      </button>`;
    })
    .join('');
  $('results').hidden = state.routes.length === 0;
}

/** L'allure a changé : on met à jour les durées affichées sans tout redessiner. */
function refreshDurations() {
  if (!state.routes.length) return;
  for (const card of $('cards').children) {
    const route = state.routes.find((r) => r.id === card.dataset.id);
    card.querySelector('.card-duration').textContent = routeDuration(route);
  }
  updatePeek();
  const duration = $('detail-duration');
  const selected = selectedRoute();
  if (duration && selected) duration.textContent = routeDuration(selected);
}

$('cards').addEventListener('click', (event) => {
  const card = event.target.closest('.card');
  if (card) selectRoute(card.dataset.id);
});

function selectRoute(id) {
  state.selectedId = id;
  const route = selectedRoute();
  if (!route) return;

  styleRoutes();
  decorateRoute(route);
  fitToRoute(id);

  for (const card of $('cards').children) {
    card.setAttribute('aria-selected', String(card.dataset.id === id));
  }
  renderDetails(route);
  updatePeek();
}

function fitToRoute(id, options) {
  const layer = routeLayers.get(id);
  if (layer) fitToLayer(layer, options);
}

/** Couleurs des tracés (dépendent du thème). */
function styleRoutes() {
  const styles = getComputedStyle(document.documentElement);
  for (const [routeId, layer] of routeLayers) {
    const selected = routeId === state.selectedId;
    layer.setStyle({
      color: styles.getPropertyValue(selected ? '--route' : '--route-other').trim(),
      weight: selected ? 6 : 4,
      opacity: selected ? 0.95 : 0.7,
    });
    if (selected) layer.bringToFront();
  }
}

// MARK: Détail

function surfaceBreakdown(route) {
  const { surface } = route;
  if (!surface) return '';
  const parts = [
    ['paved', 'Bitume', surface.paved],
    ['unpaved', 'Chemins', surface.unpaved],
    ['unknown', 'Inconnu', surface.unknown],
  ].filter(([, , share]) => share > 0.005);
  const majorRoads = route.majorRoads > 0.005 ? `<span class="legend-extra">Grands axes ${formatPercent(route.majorRoads)}</span>` : '';
  return `
    <div>
      <div class="surface-bar" role="img" aria-label="Revêtement : ${parts.map(([, label, share]) => `${label} ${formatPercent(share)}`).join(', ')}">
        ${parts.map(([key, , share]) => `<span class="surface-${key}" style="width:${(share * 100).toFixed(1)}%"></span>`).join('')}
      </div>
      <div class="surface-legend">
        ${parts.map(([key, label, share]) => `<span><i class="surface-${key}"></i>${label} ${formatPercent(share)}</span>`).join('')}
        ${majorRoads}
      </div>
    </div>`;
}

const isSaved = (route) => state.favorites.some((f) => f.id === route.id);

function renderDetails(route) {
  const stat = (label, value) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`;
  const index = state.routes.findIndex((r) => r.id === route.id);
  const saved = isSaved(route);
  const chart = elevationChart(route.profile);
  const tag = routeTag(route);
  $('details').innerHTML = `
    <div class="detail-head">
      <div>
        ${tag ? `<span class="card-tag">${tag}</span>` : ''}
        <h3 class="detail-title">${formatDistance(route.distance)} · <span id="detail-duration">${routeDuration(route)}</span></h3>
      </div>
      ${state.routes.length > 1 ? `<span class="detail-count">${index + 1} sur ${state.routes.length}</span>` : ''}
    </div>
    <div class="stats stats-4">
      ${stat('D+', formatElevation(route.ascent))}
      ${stat('D−', formatElevation(route.descent))}
      ${stat('Sommet', formatElevation(route.maxAltitude))}
      ${stat('Repassage', route.overlap == null ? '–' : formatPercent(route.overlap))}
    </div>
    ${
      chart
        ? `<div class="profile-card">
            <header><span>Profil</span><span class="muted">Touchez pour situer sur la carte</span></header>
            ${chart}
          </div>`
        : ''
    }
    ${surfaceBreakdown(route)}
    <button type="button" id="export-gpx" class="primary wide">${icons.download} Envoyer vers ma montre (GPX)</button>
    <div class="tile-actions">
      <button type="button" id="save-favorite" ${saved ? 'disabled' : ''}>${saved ? icons.bookmarkFilled : icons.bookmark}<span>${saved ? 'Enregistré' : 'Enregistrer'}</span></button>
      <button type="button" id="share-route">${icons.share}<span>Partager</span></button>
      <button type="button" id="log-outing">${icons.check}<span>Marquer fait</span></button>
    </div>`;
  $('export-gpx').addEventListener('click', () => exportGpx(route));
  $('save-favorite').addEventListener('click', () => saveFavorite(route));
  $('share-route').addEventListener('click', () => account.shareRoute(route, { activity: state.routesActivity, name: routeName(route) }));
  $('log-outing').addEventListener('click', () =>
    library.logOuting(route, {
      activity: state.routesActivity,
      name: routeName(route),
      duration: estimatedDuration(route, state.routesActivity, state.criteria.speeds),
    }),
  );
  bindProfileCursor(route);

  // Actions rapides, sous les propositions.
  $('quick-save').innerHTML = saved ? icons.bookmarkFilled : icons.bookmark;
  $('quick-save').disabled = saved;
  $('quick-save').setAttribute('aria-label', saved ? 'Déjà dans mes parcours' : 'Enregistrer dans mes parcours');
}

$('quick-gpx').addEventListener('click', () => selectedRoute() && exportGpx(selectedRoute()));
$('quick-save').addEventListener('click', () => selectedRoute() && saveFavorite(selectedRoute()));
$('show-detail').addEventListener('click', () => {
  snapTo('full', { fit: false });
  setTimeout(() => $('details').scrollIntoView({ block: 'start', behavior: 'smooth' }), 350);
});

async function exportGpx(route) {
  const name = routeName(route);
  const fileName = `${name.replace(/[^\p{L}\p{N}]+/gu, '-')}.gpx`;
  const file = new File([toGpx(route, name)], fileName, { type: 'application/gpx+xml' });
  await shareOrDownload(file, name);
}

// MARK: - Favoris

function saveFavorite(route) {
  const activity = state.routesActivity;
  const suggested = routeName(route);
  const name = window.prompt('Nom du parcours', suggested);
  if (name === null) return;

  const favorite = toFavorite(route, { name: name.trim() || suggested, activity });
  const favorites = [favorite, ...state.favorites];
  if (!storage.set(KEYS.favorites, favorites)) {
    setStatus('Impossible d\'enregistrer : le stockage de ce navigateur est plein ou désactivé.', true);
    return;
  }
  state.favorites = favorites;
  // L'itinéraire affiché devient le favori (même identifiant), pour refléter l'état « enregistré ».
  const saved = { ...fromFavorite(favorite), name: favorite.name, score: route.score, overMaxGain: route.overMaxGain };
  const label = state.labels?.get(route.id);
  if (label) state.labels.set(saved.id, label);
  state.routes = state.routes.map((r) => (r.id === route.id ? saved : r));
  renderRoutes();
  selectRoute(saved.id);
  setStatus(`« ${favorite.name} » ajouté à Mes parcours.`);
}

function removeFavorite(id) {
  state.favorites = state.favorites.filter((f) => f.id !== id);
  storage.set(KEYS.favorites, state.favorites);
  const shown = state.routes.find((r) => r.id === id);
  if (shown && shown.id === state.selectedId) renderDetails(shown);
}

// MARK: - Réglages

const settings = initSettings({
  getFavorites: () => state.favorites,
  setFavorites: (favorites) => {
    if (!storage.set(KEYS.favorites, favorites)) return false;
    state.favorites = favorites;
    return true;
  },
  onBaseLayerChange: setBaseLayer,
  onThemeChange: styleRoutes,
  onResetCriteria: () => {
    markResultsStale();
    replaceCriteria({});
  },
  getSpeeds: () => state.criteria.speeds,
  setSpeed: (activity, speed) => {
    updateCriteria({ speeds: { ...state.criteria.speeds, [activity]: speed } });
    refreshDurations();
  },
});

$('tab-settings').addEventListener('click', () => settings.open());

// MARK: - Panneau : feuille glissable (téléphone), volet repliable (ordinateur)

const VIEW_TITLES = { library: 'Mes parcours', account: 'Mon compte', settings: 'Réglages' };

/** Texte de la barre d'aperçu affichée quand le panneau est réduit. */
function updatePeek() {
  const route = selectedRoute();
  const view = currentView();
  if (view !== 'route') {
    $('panel-peek-text').textContent = VIEW_TITLES[view] ?? '';
    return;
  }
  $('panel-peek-text').textContent = route
    ? `${formatDistance(route.distance)} · ↗ ${formatElevation(route.ascent)} · ${routeDuration(route)}`
    : criteriaSummary();
}

initSheet({
  onSnap: updatePeek,
  // Le panneau a fini de bouger : la carte se recadre sur le parcours (ou le départ), au-dessus de lui.
  onSettled: () => {
    map.invalidateSize();
    if (selectedRoute()) fitToRoute(state.selectedId, { animate: mobileQuery.matches });
    else if (state.start) revealPoint(state.start);
  },
});

// MARK: - Adresses de départ et d'arrivée

addressFields.start = initAddressField({
  kind: 'start',
  getApiKey: () => storage.get(KEYS.apiKey, ''),
  getFocus: () => state.start ?? [map.getCenter().lat, map.getCenter().lng],
  shortcuts: [{ label: 'Ma position', action: () => useMyPositionAsStart() }],
  onSelect: ({ label, point }) => {
    setPoint('start', point, { label });
    setStatus('');
    if (isPointToPoint() && !state.end) {
      placeEndNext();
      $('end-address').focus();
    }
    showPoints(isPointToPoint() ? [state.start, state.end] : [state.start]);
  },
});

addressFields.end = initAddressField({
  kind: 'end',
  getApiKey: () => storage.get(KEYS.apiKey, ''),
  getFocus: () => state.end ?? state.start ?? [map.getCenter().lat, map.getCenter().lng],
  onSelect: ({ label, point }) => {
    setPoint('end', point, { label });
    setStatus('');
    showPoints([state.start, state.end]);
  },
  onClear: () => setPoint('end', null),
});

// MARK: - Compte

// Arrivée par un lien de parcours : on montre le parcours, pas l'accueil (lu avant que le lien soit effacé).
const openedFromLink = Boolean(routeDataFromHash(location.hash));
const account = initAccount({
  getFavorites: () => state.favorites,
  setFavorites: (favorites) => {
    state.favorites = favorites.filter(isValidFavorite);
    storage.set(KEYS.favorites, state.favorites, { silent: true });
    const shown = selectedRoute();
    if (shown) renderDetails(shown);
    if (currentView() === 'library') library.refresh();
  },
  applySettings: (row) => {
    if (row.criteria) replaceCriteria(row.criteria, { silent: true });
    if (row.ors_api_key) storage.set(KEYS.apiKey, row.ors_api_key, { silent: true });
    if (row.theme) {
      storage.set(KEYS.theme, row.theme, { silent: true });
      applyTheme(row.theme);
      styleRoutes();
    }
    if (row.base_layer) {
      storage.set(KEYS.baseLayer, row.base_layer, { silent: true });
      setBaseLayer(row.base_layer);
    }
  },
  openRoute: (route, activity) => openSavedRoute(route, activity),
  setStatus,
  onUserChange: () => {
    if (currentView() === 'library') library.refresh();
  },
});

/** Affiche un parcours enregistré (favori, sortie, lien de partage). */
function openSavedRoute(route, activity) {
  if (ACTIVITIES[activity]) updateCriteria({ activity });
  showRoutes([route], activity);
  setStatus('');
}

// MARK: - Mes parcours

const library = initLibrary({
  getFavorites: () => state.favorites,
  removeFavorite,
  openRoute: openSavedRoute,
  isSignedIn: () => account.signedIn,
  setStatus,
});

$('tab-library').addEventListener('click', () => {
  showView('library');
  library.refresh();
});

// MARK: - Barre d'onglets

$('tab-route').addEventListener('click', () => showView('route'));

// Toucher l'onglet déjà affiché (quel qu'il soit) réduit ou rouvre le panneau, au lieu de rouvrir la vue.
$('tabbar').addEventListener(
  'click',
  (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab?.classList.contains('active')) return;
    // Depuis « Mon compte », l'onglet Réglages ramène aux réglages.
    if (tab.dataset.tab === 'settings' && currentView() === 'account') return;
    event.stopPropagation(); // l'action habituelle de l'onglet n'est pas exécutée
    toggleSheet();
  },
  true,
);

// Changer de vue rouvre la feuille si elle était réduite et revient en haut de son contenu.
onViewChange((view) => {
  // « Générer » n'a de sens que dans la vue Parcours.
  $('sheet-actions').classList.toggle('route-only-hidden', view !== 'route');
  $('panel-scroll').scrollTo({ top: 0 });
  if (getSheetState() === 'peek') snapTo('mid', { fit: false });
  updatePeek();
});

// MARK: - Sources de la carte (repliées derrière un bouton « i »)

$('map-credits').addEventListener('click', () => {
  const open = !document.body.classList.contains('credits-open');
  document.body.classList.toggle('credits-open', open);
  $('map-credits').setAttribute('aria-expanded', String(open));
});

// MARK: - Mise en route

const onboarding = initOnboarding({
  onLocate: () => {
    watchMyPosition();
    getMyPosition().catch((error) => setStatus(error.message, true));
  },
  onSkipLocate: () => setStatus('Tapez une adresse de départ ou touchez la carte.'),
  onDone: () => settings.refreshQuota(),
});
$('replay-onboarding').addEventListener('click', () => onboarding.start());

// MARK: - Démarrage

syncForm();
snapTo(getSheetState(), { save: false, fit: false });
if (onboarding.needed && !openedFromLink) onboarding.start();
else watchMyPosition();

// Mode hors ligne : l'app est gardée sur l'appareil (voir sw.js).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
