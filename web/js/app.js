import { initAccount } from './account.js';
import { initAddressField } from './address.js';
import { elevationChart, sparkline } from './chart.js';
import {
  ACTIVITIES,
  ELEVATION_PREFERENCES,
  SHAPES,
  SPEED_RANGES,
  SURFACES,
  estimatedDuration,
  sanitizeCriteria,
} from './criteria.js';
import { fromFavorite, isValidFavorite, toFavorite } from './favorites.js';
import { formatDistance, formatDuration, formatElevation, formatPace, formatPercent } from './format.js';
import { generateRoutes } from './generator.js';
import { reverse as reverseGeocode } from './geocode.js';
import { toGpx } from './gpx.js';
import { icons } from './icons.js';
import { BASE_LAYERS, DEFAULT_BASE_LAYER } from './layers.js';
import { initSettings } from './settings.js';
import { shareOrDownload } from './share.js';
import { KEYS, applyTheme, storage } from './storage.js';
import { currentView, onViewChange, showView } from './views.js';

/* global L */

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const state = {
  criteria: sanitizeCriteria(storage.get(KEYS.criteria, {})),
  start: null,
  end: null,
  routes: [],
  /** Activité avec laquelle les itinéraires affichés ont été calculés. */
  routesActivity: null,
  selectedId: null,
  controller: null,
  favorites: storage.get(KEYS.favorites, []).filter(isValidFavorite),
};

// MARK: - Carte

const map = L.map('map', { zoomControl: false }).setView([46.6, 2.4], 6);
map.attributionControl.setPrefix(false);
// Le panneau change de taille (résultats, rotation) : Leaflet doit recalculer la taille de la carte.
new ResizeObserver(() => map.invalidateSize()).observe($('map'));
L.control.zoom({ position: 'bottomright' }).addTo(map);
let baseLayer = null;

function setBaseLayer(key) {
  const config = BASE_LAYERS[key] ?? BASE_LAYERS[DEFAULT_BASE_LAYER];
  baseLayer?.remove();
  baseLayer = L.tileLayer(config.url, {
    maxZoom: config.maxZoom,
    attribution: `${config.attribution} · <a href="https://openrouteservice.org">openrouteservice</a>`,
  }).addTo(map);
  baseLayer.bringToBack();
}

setBaseLayer(storage.get(KEYS.baseLayer, DEFAULT_BASE_LAYER));

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
}

const isPointToPoint = () => state.criteria.shape === 'point_to_point';
const placing = () => document.querySelector('input[name="placing"]:checked').value;

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

/** Cadre la carte sur un ou deux points, dans la partie visible au-dessus du panneau. */
function showPoints(points) {
  const valid = points.filter(Boolean);
  if (valid.length === 1) {
    centerOnVisible(valid[0], Math.max(map.getZoom(), 14), { animate: true });
  } else if (valid.length > 1) {
    map.fitBounds(L.latLngBounds(valid), {
      paddingTopLeft: [40, 60 + (mobileQuery.matches ? safeArea.top : 0)],
      paddingBottomRight: [40, hiddenMapBottom() + 40],
      maxZoom: 15,
    });
  }
}

map.on('click', (event) => {
  const point = [event.latlng.lat, event.latlng.lng];
  if (isPointToPoint() && placing() === 'end') {
    setPoint('end', point);
  } else {
    setPoint('start', point);
    // Après le départ, on enchaîne naturellement sur l'arrivée.
    if (isPointToPoint() && !state.end) document.querySelector('input[name="placing"][value="end"]').checked = true;
  }
  setStatus('');
});

function locate({ silent = false } = {}) {
  if (!('geolocation' in navigator)) {
    if (!silent) setStatus('Géolocalisation indisponible : touchez la carte pour choisir un départ.');
    return;
  }
  if (!silent) setStatus('Recherche de votre position…');
  $('locate').classList.add('locating');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      $('locate').classList.remove('locating');
      const point = [position.coords.latitude, position.coords.longitude];
      setPoint('start', point, { label: 'Ma position' });
      centerOnVisible(point, 14);
      setStatus('');
    },
    (error) => {
      $('locate').classList.remove('locating');
      setStatus(
        error.code === error.PERMISSION_DENIED
          ? 'Localisation refusée : touchez la carte pour choisir un départ.'
          : 'Position introuvable : touchez la carte pour choisir un départ.',
      );
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

// MARK: - Formulaire

const chips = (name, entries) =>
  entries.map(([value, label]) => `<label class="chip"><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`).join('');

function buildForm() {
  $('activity').innerHTML = chips('activity', Object.entries(ACTIVITIES).map(([key, a]) => [key, a.label]));
  $('shape').innerHTML = Object.entries(SHAPES)
    .map(([key, label]) => `<label><input type="radio" name="shape" value="${key}"><span>${label}</span></label>`)
    .join('');
  $('elevation').innerHTML = chips('elevation', Object.entries(ELEVATION_PREFERENCES).map(([key, p]) => [key, p.label]));
  $('surface').innerHTML = chips('surface', Object.entries(SURFACES));
}

/** À pied, le curseur règle une allure en secondes par km ; à vélo, une vitesse en km/h. */
function speedSlider(activityKey) {
  const { kind } = ACTIVITIES[activityKey];
  const [minSpeed, maxSpeed] = SPEED_RANGES[kind];
  if (kind === 'foot') {
    return {
      label: 'Allure',
      min: Math.round(3600 / maxSpeed),
      max: Math.round(3600 / minSpeed),
      step: 5,
      toSlider: (speed) => Math.round(3600 / speed / 5) * 5,
      fromSlider: (seconds) => 3600 / seconds,
      format: (speed) => formatPace(speed),
    };
  }
  return {
    label: 'Vitesse moyenne',
    min: minSpeed,
    max: maxSpeed,
    step: 1,
    toSlider: (speed) => Math.round(speed),
    fromSlider: (value) => value,
    format: (speed) => `${Math.round(speed)} km/h`,
  };
}

/** Partie remplie des curseurs (le navigateur ne la colore pas partout de la même façon). */
function fillRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${(ratio * 100).toFixed(1)}%`);
}

function syncForm() {
  const { criteria } = state;
  const activity = ACTIVITIES[criteria.activity];
  document.querySelector(`input[name="activity"][value="${criteria.activity}"]`).checked = true;
  document.querySelector(`input[name="shape"][value="${criteria.shape}"]`).checked = true;
  $('placing-field').hidden = !isPointToPoint();
  $('end-field').hidden = !isPointToPoint();

  const distance = $('distance');
  [distance.min, distance.max] = activity.range;
  distance.value = criteria.distanceKm;
  $('distance-output').textContent = `${criteria.distanceKm} km`;

  const slider = speedSlider(criteria.activity);
  const speed = $('speed');
  $('speed-label').textContent = slider.label;
  Object.assign(speed, { min: slider.min, max: slider.max, step: slider.step });
  speed.value = slider.toSlider(criteria.speeds[criteria.activity]);
  $('speed-output').textContent = slider.format(criteria.speeds[criteria.activity]);

  document.querySelector(`input[name="elevation"][value="${criteria.elevation}"]`).checked = true;
  document.querySelector(`input[name="surface"][value="${criteria.surface}"]`).checked = true;
  $('avoid-major-roads').checked = criteria.avoidMajorRoads;
  $('proposals').textContent = String(criteria.proposals);
  $('proposals-minus').disabled = criteria.proposals <= 1;
  $('proposals-plus').disabled = criteria.proposals >= 5;
  $('limit-gain').checked = criteria.maxGain != null;
  $('max-gain').disabled = criteria.maxGain == null;
  $('max-gain-field').classList.toggle('disabled', criteria.maxGain == null);
  $('max-gain').value = criteria.maxGain ?? 200;
  for (const range of [distance, speed]) fillRange(range);
  $('criteria-summary-text').textContent = criteriaSummary();
  updatePeek();
}

function criteriaSummary() {
  const { criteria } = state;
  return [
    ACTIVITIES[criteria.activity].label,
    SHAPES[criteria.shape],
    `${criteria.distanceKm} km`,
    speedSlider(criteria.activity).format(criteria.speeds[criteria.activity]),
  ].join(' · ');
}

/** Après un calcul, les critères se replient pour laisser la place au parcours. */
function setCriteriaCollapsed(collapsed) {
  $('criteria-form').classList.toggle('collapsed', collapsed);
  $('criteria-summary').setAttribute('aria-expanded', String(!collapsed));
  $('criteria-summary-text').textContent = criteriaSummary();
  updatePeek();
}

$('criteria-summary').addEventListener('click', () => {
  setCriteriaCollapsed(false);
  $('criteria-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
});

function updateCriteria(changes) {
  state.criteria = sanitizeCriteria({ ...state.criteria, ...changes });
  storage.set(KEYS.criteria, state.criteria);
  syncForm();
}

$('activity').addEventListener('change', (event) => {
  const activity = event.target.value;
  updateCriteria({ activity, distanceKm: ACTIVITIES[activity].defaultKm });
});
$('shape').addEventListener('change', (event) => {
  updateCriteria({ shape: event.target.value });
  if (isPointToPoint() && state.start && !state.end) {
    document.querySelector('input[name="placing"][value="end"]').checked = true;
    setStatus('Touchez la carte pour placer l\'arrivée.');
  }
});
$('distance').addEventListener('input', (event) => updateCriteria({ distanceKm: Number(event.target.value) }));
$('speed').addEventListener('input', (event) => {
  const key = state.criteria.activity;
  const speed = speedSlider(key).fromSlider(Number(event.target.value));
  updateCriteria({ speeds: { ...state.criteria.speeds, [key]: speed } });
  refreshDurations();
});
$('elevation').addEventListener('change', (event) => updateCriteria({ elevation: event.target.value }));
$('surface').addEventListener('change', (event) => updateCriteria({ surface: event.target.value }));
$('avoid-major-roads').addEventListener('change', (event) => updateCriteria({ avoidMajorRoads: event.target.checked }));
$('proposals-minus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals - 1 }));
$('proposals-plus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals + 1 }));
$('limit-gain').addEventListener('change', (event) =>
  updateCriteria({ maxGain: event.target.checked ? Number($('max-gain').value) || 200 : null }),
);
$('max-gain').addEventListener('change', (event) => updateCriteria({ maxGain: Number(event.target.value) }));
$('locate').addEventListener('click', () => locate());

function setStatus(message, isError = false) {
  // Une erreur ne doit pas rester cachée derrière le panneau réduit.
  if (isError && message && sheetState === 'peek') snapTo('mid');
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

// MARK: - Génération

function setGenerating(isGenerating) {
  $('generate').classList.toggle('loading', isGenerating);
  $('generate').setAttribute('aria-busy', String(isGenerating));
  $('generate-label').textContent = isGenerating ? 'Annuler' : 'Générer';
}

$('criteria-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  if (state.controller) {
    state.controller.abort();
    return;
  }
  const apiKey = storage.get(KEYS.apiKey, '');
  if (!apiKey) {
    settings.open('Ajoutez votre clé OpenRouteService (gratuite) pour générer des itinéraires. Le tutoriel explique comment l\'obtenir en 2 minutes.');
    return;
  }
  if (!state.start) {
    setStatus('Choisissez un départ : touchez la carte ou utilisez « Ma position ».', true);
    return;
  }
  if (isPointToPoint() && !state.end) {
    document.querySelector('input[name="placing"][value="end"]').checked = true;
    setStatus('Touchez la carte pour placer l\'arrivée.', true);
    return;
  }

  const controller = new AbortController();
  state.controller = controller;
  setGenerating(true);
  setStatus('Calcul des itinéraires…');

  try {
    const { routes, directIsLonger } = await generateRoutes({
      start: state.start,
      end: isPointToPoint() ? state.end : null,
      criteria: state.criteria,
      apiKey,
      signal: controller.signal,
      onProgress: (index, total) => setStatus(`Calcul de l'itinéraire ${index + 1} sur ${total}…`),
    });
    showRoutes(routes, state.criteria.activity);
    setStatus(
      directIsLonger
        ? `Le trajet direct (${formatDistance(routes[0].distance)}) est déjà plus long que la distance visée : c'est lui qui est proposé.`
        : '',
    );
  } catch (error) {
    if (error.name === 'AbortError') setStatus('Génération annulée.');
    else setStatus(error.message, true);
  } finally {
    state.controller = null;
    setGenerating(false);
  }
});

// MARK: - Résultats

function showRoutes(routes, activity) {
  showView('route');
  state.routes = routes;
  state.routesActivity = activity;
  state.routesShape = state.criteria.shape;
  renderRoutes();
  selectRoute(routes[0].id);
  setCriteriaCollapsed(true);
  // Le premier parcours est généré : le message de bienvenue a fait son office.
  dismissWelcome();
  $('panel-scroll').scrollTo({ top: 0 });
}

const routeDuration = (route) => formatDuration(estimatedDuration(route, state.routesActivity, state.criteria.speeds));

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
    .map(
      (route, index) => `
      <button type="button" class="card" role="option" data-id="${route.id}">
        <small>${state.routes.length > 1 ? `Proposition ${index + 1}` : escapeHtml(route.name ?? 'Itinéraire')}</small>
        <strong>${formatDistance(route.distance)}</strong>
        <span>↗ ${formatElevation(route.ascent)} · <span class="card-duration">${routeDuration(route)}</span></span>
        ${sparkline(route.profile)}
      </button>`,
    )
    .join('');
  $('results').hidden = state.routes.length === 0;
}

/** L'allure a changé : on met à jour les durées affichées sans tout redessiner. */
function refreshDurations() {
  if (state.routesActivity !== state.criteria.activity) return;
  for (const card of $('cards').children) {
    const route = state.routes.find((r) => r.id === card.dataset.id);
    card.querySelector('.card-duration').textContent = routeDuration(route);
  }
  updatePeek();
  const duration = $('detail-duration');
  const selected = state.routes.find((r) => r.id === state.selectedId);
  if (duration && selected) duration.textContent = routeDuration(selected);
}

$('cards').addEventListener('click', (event) => {
  const card = event.target.closest('.card');
  if (card) selectRoute(card.dataset.id);
});

function selectRoute(id) {
  state.selectedId = id;
  const route = state.routes.find((r) => r.id === id);
  if (!route) return;

  styleRoutes();
  fitToRoute(id);

  for (const card of $('cards').children) {
    card.setAttribute('aria-selected', String(card.dataset.id === id));
  }
  renderDetails(route);
  updatePeek();
}

/** Hauteur (px) du bas de la carte masquée par le panneau et la barre d'onglets (téléphone uniquement). */
function hiddenMapBottom() {
  return mobileQuery.matches ? currentSheetHeight() + tabbarHeight() : 0;
}

/** Centre la carte sur un point dans la partie visible, au-dessus du panneau. */
function centerOnVisible(point, zoom = map.getZoom(), options = {}) {
  const offset = hiddenMapBottom() / 2;
  const target = map.project(point, zoom).add([0, offset]);
  map.setView(map.unproject(target, zoom), zoom, options);
}

/** Si le point est caché sous le panneau (ou trop près des bords), le ramène dans la partie visible. */
function revealPoint(point) {
  const position = map.latLngToContainerPoint(point);
  const visibleBottom = map.getSize().y - hiddenMapBottom();
  if (position.y > visibleBottom - 48 || position.y < 48 || position.x < 24 || position.x > map.getSize().x - 24) {
    centerOnVisible(point, map.getZoom(), { animate: true });
  }
}

function fitToRoute(id, { animate = false } = {}) {
  const layer = routeLayers.get(id);
  if (!layer) return;
  map.invalidateSize();
  // Sur téléphone, la carte passe sous la feuille : on garde le parcours dans la partie visible.
  const bottom = mobileQuery.matches ? Math.min(currentSheetHeight() + tabbarHeight(), window.innerHeight * 0.65) + 24 : 30;
  map.fitBounds(layer.getBounds(), {
    paddingTopLeft: [30, 40 + (mobileQuery.matches ? safeArea.top : 0)],
    paddingBottomRight: [30, bottom],
    animate,
  });
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

function surfaceBreakdown(surface) {
  if (!surface) return '';
  const parts = [
    ['paved', 'Bitume', surface.paved],
    ['unpaved', 'Chemins', surface.unpaved],
    ['unknown', 'Inconnu', surface.unknown],
  ].filter(([, , share]) => share > 0.005);
  return `
    <div>
      <div class="surface-bar" role="img" aria-label="Revêtement : ${parts.map(([, label, share]) => `${label} ${formatPercent(share)}`).join(', ')}">
        ${parts.map(([key, , share]) => `<span class="surface-${key}" style="width:${(share * 100).toFixed(1)}%"></span>`).join('')}
      </div>
      <div class="surface-legend">
        ${parts.map(([key, label, share]) => `<span><i class="surface-${key}"></i>${label} ${formatPercent(share)}</span>`).join('')}
      </div>
    </div>`;
}

function renderDetails(route) {
  const stat = (label, value, id = '') => `<div class="stat"><small>${label}</small><strong${id ? ` id="${id}"` : ''}>${value}</strong></div>`;
  const isFavorite = state.favorites.some((f) => f.id === route.id);
  const index = state.routes.findIndex((r) => r.id === route.id);
  const subtitle = route.name
    ? escapeHtml(route.name)
    : `${ACTIVITIES[state.routesActivity].label} · ${SHAPES[state.routesShape]}`;
  const badge = state.routes.length > 1 ? `<span class="badge">Prop. ${index + 1} sur ${state.routes.length}</span>` : '';
  const chart = elevationChart(route.profile);
  $('details').innerHTML = `
    <div class="detail-header">
      <div><small>${subtitle}</small><strong>${formatDistance(route.distance)}</strong></div>
      ${badge}
    </div>
    ${
      chart
        ? `<div class="profile-card">
            <header><span>Profil</span><span>↗ ${formatElevation(route.ascent)} · ↘ ${formatElevation(route.descent)}</span></header>
            ${chart}
          </div>`
        : ''
    }
    <div class="stats">
      ${stat('Durée', routeDuration(route), 'detail-duration')}
      ${stat('Alt. min', formatElevation(route.minAltitude))}
      ${stat('Alt. max', formatElevation(route.maxAltitude))}
      ${stat('Repassages', route.overlap == null ? '–' : formatPercent(route.overlap))}
      ${stat('Grands axes', route.majorRoads == null ? '–' : formatPercent(route.majorRoads))}
      ${stat('Chemins', route.surface ? formatPercent(route.surface.unpaved) : '–')}
    </div>
    ${surfaceBreakdown(route.surface)}
    <div class="actions actions-grid">
      <button type="button" id="save-favorite" class="secondary" ${isFavorite ? 'disabled' : ''}>${isFavorite ? `${icons.starFilled} Enregistré` : `${icons.star} Enregistrer`}</button>
      <button type="button" id="export-gpx" class="secondary">${icons.download} GPX</button>
      <button type="button" id="share-route" class="secondary">${icons.share} Partager</button>
      <button type="button" id="log-outing" class="secondary">${icons.check} Réalisé</button>
    </div>`;
  const routeName = () => route.name ?? `${ACTIVITIES[state.routesActivity].label} ${formatDistance(route.distance)}`;
  $('export-gpx').addEventListener('click', () => exportGpx(route));
  $('save-favorite').addEventListener('click', () => saveFavorite(route));
  $('share-route').addEventListener('click', () => account.shareRoute(route, { activity: state.routesActivity, name: routeName() }));
  $('log-outing').addEventListener('click', () =>
    account.logOuting(route, {
      activity: state.routesActivity,
      name: routeName(),
      duration: estimatedDuration(route, state.routesActivity, state.criteria.speeds),
    }),
  );
}

async function exportGpx(route) {
  const name = route.name ?? `${ACTIVITIES[state.routesActivity].label} ${formatDistance(route.distance)}`;
  const fileName = `${name.replace(/[^\p{L}\p{N}]+/gu, '-')}.gpx`;
  const file = new File([toGpx(route, name)], fileName, { type: 'application/gpx+xml' });
  await shareOrDownload(file, name);
}

// MARK: - Favoris

function saveFavorite(route) {
  const activity = state.routesActivity;
  const suggested = `${ACTIVITIES[activity].label} ${formatDistance(route.distance)}`;
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
  const saved = { ...fromFavorite(favorite), score: route.score };
  state.routes = state.routes.map((r) => (r.id === route.id ? saved : r));
  renderRoutes();
  selectRoute(saved.id);
  setStatus(`« ${favorite.name} » ajouté aux favoris.`);
}

function renderFavorites() {
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
  $('favorites-list').innerHTML = state.favorites.length
    ? state.favorites
        .map(
          (favorite) => `
        <li>
          <button type="button" class="favorite-open" data-id="${favorite.id}">
            <strong>${escapeHtml(favorite.name)}</strong>
            <small>${ACTIVITIES[favorite.activity]?.label ?? ''} · ${formatDistance(favorite.route.distance)} · ↗ ${formatElevation(favorite.route.ascent)} · ${dateFormat.format(new Date(favorite.savedAt))}</small>
          </button>
          <button type="button" class="favorite-delete" data-id="${favorite.id}" aria-label="Supprimer ${escapeHtml(favorite.name)}">${icons.trash}</button>
        </li>`,
        )
        .join('')
    : '<li class="favorites-empty">Aucun favori pour l\'instant. Utilisez « Enregistrer » sous un itinéraire.</li>';
}

$('open-favorites').addEventListener('click', () => {
  renderFavorites();
  showView('favorites');
});

$('favorites-list').addEventListener('click', (event) => {
  const open = event.target.closest('.favorite-open');
  const remove = event.target.closest('.favorite-delete');
  if (open) {
    const favorite = state.favorites.find((f) => f.id === open.dataset.id);
    if (!favorite) return;
    if (ACTIVITIES[favorite.activity]) updateCriteria({ activity: favorite.activity });
    showRoutes([{ ...fromFavorite(favorite), name: favorite.name }], favorite.activity);
    setStatus('');
  } else if (remove) {
    const favorite = state.favorites.find((f) => f.id === remove.dataset.id);
    if (!favorite || !window.confirm(`Supprimer « ${favorite.name} » ?`)) return;
    state.favorites = state.favorites.filter((f) => f.id !== favorite.id);
    storage.set(KEYS.favorites, state.favorites);
    renderFavorites();
    const shown = state.routes.find((r) => r.id === favorite.id);
    if (shown) renderDetails(shown);
  }
});

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
    state.criteria = sanitizeCriteria({});
    storage.set(KEYS.criteria, state.criteria);
    syncForm();
  },
});

$('open-settings').addEventListener('click', () => settings.open());

// MARK: - Panneau : feuille glissable (téléphone), volet repliable (ordinateur)

const VIEW_TITLES = { favorites: 'Favoris', account: 'Mon compte', settings: 'Réglages' };

/** Texte de la barre d'aperçu affichée quand le panneau est réduit. */
function updatePeek() {
  const route = state.routes.find((r) => r.id === state.selectedId);
  const view = currentView();
  if (view !== 'route') {
    $('panel-peek-text').textContent = VIEW_TITLES[view] ?? '';
    return;
  }
  $('panel-peek-text').textContent = route
    ? `${formatDistance(route.distance)} · ↗ ${formatElevation(route.ascent)} · ${routeDuration(route)}`
    : criteriaSummary();
}

const mobileQuery = matchMedia('(max-width: 899px)');
const panel = $('panel');
const SHEET_STATES = ['peek', 'mid', 'full'];
/** Position du panneau : « peek » (réduit à une barre), « mid » (mi-hauteur) ou « full » (presque plein écran). */
let sheetState = normalizeSheetState(storage.get(KEYS.panelCollapsed, 'mid'));

function normalizeSheetState(value) {
  if (value === true) return 'peek'; // ancienne valeur enregistrée
  if (value === false) return 'mid';
  return SHEET_STATES.includes(value) ? value : 'mid';
}

/** Marges de sécurité de l'écran (encoche, barre d'accueil), mesurées une fois. */
const safeArea = (() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.append(probe);
  const { paddingTop, paddingBottom } = getComputedStyle(probe);
  probe.remove();
  return { top: parseFloat(paddingTop) || 0, bottom: parseFloat(paddingBottom) || 0 };
})();

const tabbarHeight = () => $('tabbar').offsetHeight;

/** Hauteurs (px) des trois positions de la feuille, posée sur la barre d'onglets. */
function sheetHeights() {
  const available = window.innerHeight - tabbarHeight();
  return {
    peek: 78,
    mid: Math.round(available * 0.55),
    full: Math.round(available - safeArea.top - 48), // laisse visibles les crédits de la carte
  };
}

function currentSheetHeight() {
  return parseFloat(panel.style.getPropertyValue('--sheet-h')) || sheetHeights()[sheetState];
}

/** Applique une hauteur de feuille ; sans animation pendant que le doigt la déplace. */
function setSheetHeight(height, { animate = true } = {}) {
  panel.classList.toggle('dragging', !animate);
  panel.style.setProperty('--sheet-h', `${Math.round(height)}px`);
  // La feuille repose exactement sur la barre d'onglets (sa hauteur dépend de l'appareil).
  panel.style.bottom = `${tabbarHeight()}px`;
  document.querySelector('.layout').classList.toggle('map-full', height <= sheetHeights().peek + 12);
  // Le bouton de localisation s'efface quand la feuille monte jusqu'à lui.
  const locateButton = $('locate');
  const opacity = Math.max(0, Math.min(1, (window.innerHeight - tabbarHeight() - height - 70) / 50));
  locateButton.style.opacity = String(opacity);
  locateButton.style.pointerEvents = opacity < 0.5 ? 'none' : '';
}

/** Amène le panneau dans une position (téléphone) ou l'ouvre / le ferme (ordinateur). */
function snapTo(position, { save = true, fit = true } = {}) {
  sheetState = position;
  const collapsed = position === 'peek';
  const toggle = $('panel-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute(
    'aria-label',
    collapsed ? 'Afficher le panneau des critères et résultats' : 'Réduire le panneau pour voir la carte en plein écran',
  );
  if (mobileQuery.matches) {
    setSheetHeight(sheetHeights()[position]);
  } else {
    panel.style.removeProperty('--sheet-h');
    panel.style.bottom = '';
    $('locate').style.opacity = '';
    $('locate').style.pointerEvents = '';
    panel.classList.remove('dragging');
    document.querySelector('.layout').classList.toggle('map-full', collapsed);
  }
  updatePeek();
  if (save) storage.set(KEYS.panelCollapsed, position);
  // Une fois l'animation terminée, la carte se recadre sur le parcours, au-dessus de la feuille.
  if (fit && position !== 'full') {
    setTimeout(() => {
      if (sheetState !== position) return; // un autre geste a eu lieu entre-temps
      map.invalidateSize();
      if (selectedRouteId()) fitToRoute(selectedRouteId(), { animate: mobileQuery.matches });
      else if (state.start) revealPoint(state.start);
    }, 340);
  }
}

const selectedRouteId = () => (state.routes.some((r) => r.id === state.selectedId) ? state.selectedId : null);

// Glisser la poignée : la feuille suit le doigt, puis se cale sur la position la plus proche
// en tenant compte de l'élan (un petit coup rapide suffit à changer de position).
{
  const toggle = $('panel-toggle');
  let drag = null;
  let suppressClick = false;

  const nearestState = (height) => {
    const heights = sheetHeights();
    return SHEET_STATES.reduce((best, s) => (Math.abs(heights[s] - height) < Math.abs(heights[best] - height) ? s : best), 'mid');
  };

  toggle.addEventListener('pointerdown', (event) => {
    if (!mobileQuery.matches) return;
    toggle.setPointerCapture(event.pointerId);
    drag = {
      startY: event.clientY,
      startHeight: currentSheetHeight(),
      startState: sheetState,
      moved: false,
      samples: [{ y: event.clientY, t: event.timeStamp }],
    };
  });

  toggle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    const { peek, full } = sheetHeights();
    let height = drag.startHeight - dy;
    // Résistance élastique au-delà des limites.
    if (height > full) height = full + (height - full) * 0.25;
    if (height < peek) height = peek - (peek - height) * 0.25;
    setSheetHeight(height, { animate: false });
    drag.samples.push({ y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
  });

  const endDrag = (event) => {
    if (!drag) return;
    const { moved, samples, startState } = drag;
    drag = null;
    if (!moved) return; // simple toucher : géré par « click »
    suppressClick = true;
    const first = samples[0];
    const last = { y: event.clientY, t: event.timeStamp };
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px/ms, positif vers le bas
    if (Math.abs(velocity) > 0.45) {
      // Geste vif : position suivante dans le sens du geste.
      const index = SHEET_STATES.indexOf(startState) + (velocity > 0 ? -1 : 1);
      snapTo(SHEET_STATES[Math.max(0, Math.min(SHEET_STATES.length - 1, index))]);
    } else {
      // Geste lent : position la plus proche de l'endroit où la feuille a été lâchée.
      snapTo(nearestState(currentSheetHeight()));
    }
  };
  toggle.addEventListener('pointerup', endDrag);
  toggle.addEventListener('pointercancel', endDrag);

  toggle.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    snapTo(sheetState === 'peek' ? 'mid' : 'peek');
  });

  // Rotation de l'écran, clavier virtuel, passage téléphone ↔ ordinateur : on recale le panneau.
  window.addEventListener('resize', () => snapTo(sheetState, { save: false, fit: false }));
  mobileQuery.addEventListener('change', () => snapTo(sheetState, { save: false }));
}
// MARK: - Adresses de départ et d'arrivée

addressFields.start = initAddressField({
  kind: 'start',
  getApiKey: () => storage.get(KEYS.apiKey, ''),
  getFocus: () => state.start ?? [map.getCenter().lat, map.getCenter().lng],
  shortcuts: [{ label: 'Ma position', action: () => locate() }],
  onSelect: ({ label, point }) => {
    setPoint('start', point, { label });
    setStatus('');
    if (isPointToPoint() && !state.end) {
      document.querySelector('input[name="placing"][value="end"]').checked = true;
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

const account = initAccount({
  getFavorites: () => state.favorites,
  setFavorites: (favorites) => {
    state.favorites = favorites.filter(isValidFavorite);
    storage.set(KEYS.favorites, state.favorites, { silent: true });
    const shown = state.routes.find((r) => r.id === state.selectedId);
    if (shown) renderDetails(shown);
  },
  applySettings: (row) => {
    if (row.criteria) {
      state.criteria = sanitizeCriteria(row.criteria);
      storage.set(KEYS.criteria, state.criteria, { silent: true });
      syncForm();
    }
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
  openRoute: (route, activity) => {
    if (ACTIVITIES[activity]) updateCriteria({ activity });
    showRoutes([route], activity);
  },
  setStatus,
});

// MARK: - Barre d'onglets

// « Parcours » réduit ou rouvre le panneau ; « Sorties » ouvre l'historique du compte.
// « Parcours » affiche la vue Parcours ; si elle est déjà affichée, réduit ou rouvre le panneau.
$('tab-route').addEventListener('click', () => {
  if (currentView() !== 'route') showView('route');
  else snapTo(sheetState === 'peek' ? 'mid' : 'peek');
});

// Changer de vue rouvre la feuille si elle était réduite et revient en haut de son contenu.
onViewChange(() => {
  $('panel-scroll').scrollTo({ top: 0 });
  if (sheetState === 'peek') snapTo('mid', { fit: false });
  updatePeek();
});
$('tab-outings').addEventListener('click', () => account.openOutings());

// MARK: - Bienvenue

if (!storage.get(KEYS.welcomeDismissed, false)) $('welcome').hidden = false;
function dismissWelcome() {
  storage.set(KEYS.welcomeDismissed, true);
  $('welcome').hidden = true;
}
$('dismiss-welcome').addEventListener('click', dismissWelcome);
$('welcome').querySelector('a').addEventListener('click', dismissWelcome);

// MARK: - Démarrage

buildForm();
syncForm();
snapTo(sheetState, { save: false, fit: false });
locate({ silent: true });
