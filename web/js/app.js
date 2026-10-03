import { initAccount } from './account.js';
import { initAddressField } from './address.js';
import { elevationChart, sparkline } from './chart.js';
import { ACTIVITIES, ELEVATION_PREFERENCES, SHAPES, SURFACES, estimatedDuration, sanitizeCriteria } from './criteria.js';
import { fromFavorite, isValidFavorite, toFavorite } from './favorites.js';
import { formatDistance, formatDuration, formatElevation, formatPercent } from './format.js';
import { generateRoutes } from './generator.js';
import { reverse as reverseGeocode } from './geocode.js';
import { cumulativeDistances, distance, pointAtDistance, pointsAlong } from './geo.js';
import { toGpx } from './gpx.js';
import { activityIcons, icons } from './icons.js';
import { labelRoutes } from './labels.js';
import { BASE_LAYERS, DEFAULT_BASE_LAYER } from './layers.js';
import { initLibrary } from './library.js';
import { initOnboarding } from './onboarding.js';
import { DAILY_QUOTA, requestsToday } from './ors.js';
import { initSettings } from './settings.js';
import { shareOrDownload } from './share.js';
import { KEYS, applyTheme, storage } from './storage.js';
import { currentView, onViewChange, showView } from './views.js';

/* global L */

const $ = (id) => document.getElementById(id);

// Pas de zoom de la page (la carte, elle, se zoome toujours) : Safari sur iPhone ignore « user-scalable=no »,
// on bloque donc ses gestes de pincement ; le double-toucher est bloqué en CSS (touch-action).
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
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

// MARK: - Ma position (point bleu, indépendant du départ et de l'arrivée)

/** Dernière position connue de l'utilisateur, [lat, lon], ou null. */
let myPosition = null;
let myMarker = null;
let myAccuracy = null;
let positionWatch = null;
let firstFixHandled = false;

const myIcon = L.divIcon({ className: '', html: '<div class="me-marker"><span></span></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

function showMyPosition(point, accuracy) {
  myPosition = point;
  if (!myMarker) {
    myAccuracy = L.circle(point, { radius: accuracy, className: 'me-accuracy', interactive: false }).addTo(map);
    myMarker = L.marker(point, { icon: myIcon, title: 'Ma position', keyboard: false, interactive: false, zIndexOffset: 500 }).addTo(map);
  } else {
    myMarker.setLatLng(point);
    myAccuracy.setLatLng(point).setRadius(accuracy);
  }
  syncStartRing();
}

/** Quand le départ est ma position, il s'affiche en anneau autour du point bleu (les deux restent visibles). */
function syncStartRing() {
  const element = markers.start?.getElement()?.querySelector('.start-marker');
  if (!element) return;
  const atMe = Boolean(myPosition && state.start && distance(myPosition, state.start) < 20);
  element.classList.toggle('at-me', atMe);
}

const positionErrorMessage = (error) =>
  error.code === error.PERMISSION_DENIED
    ? 'Localisation refusée : touchez la carte ou tapez une adresse pour choisir un départ.'
    : 'Position introuvable : touchez la carte ou tapez une adresse pour choisir un départ.';

/** Suit la position en continu pour garder le point bleu à jour. */
function watchMyPosition() {
  if (!('geolocation' in navigator) || positionWatch !== null) return;
  positionWatch = navigator.geolocation.watchPosition(
    (position) => {
      const point = [position.coords.latitude, position.coords.longitude];
      showMyPosition(point, position.coords.accuracy);
      // Au premier repérage, la position sert de départ si aucun n'a été choisi.
      if (!firstFixHandled) {
        firstFixHandled = true;
        if (!state.start) {
          setPoint('start', point, { label: 'Ma position' });
          centerOnVisible(point, 14);
        }
      }
    },
    () => {
      // Erreurs signalées par les actions explicites (bouton, raccourci « Ma position »).
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

/** Position actuelle : la dernière connue si elle est récente, sinon une nouvelle mesure. */
function getMyPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Géolocalisation indisponible : touchez la carte ou tapez une adresse pour choisir un départ.'));
      return;
    }
    if (myPosition) {
      resolve(myPosition);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = [position.coords.latitude, position.coords.longitude];
        showMyPosition(point, position.coords.accuracy);
        resolve(point);
      },
      (error) => reject(new Error(positionErrorMessage(error))),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

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

// MARK: - Formulaire

/** Libellés courts des contrôles segmentés. */
const ELEVATION_SHORT = { any: 'Libre', flat: 'Plat', rolling: 'Vallonné', hilly: 'Montagne' };
const SURFACE_SHORT = { any: 'Libre', paved: 'Bitume', unpaved: 'Chemins' };
const ACTIVITY_SHORT = { road: 'Route' };
const GAIN_STEP = 50;

const segments = (name, entries) =>
  entries.map(([value, label]) => `<label><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`).join('');

function buildForm() {
  $('activity').innerHTML = Object.entries(ACTIVITIES)
    .map(
      ([key, activity]) => `
      <label class="activity-option">
        <input type="radio" name="activity" value="${key}" aria-label="${activity.label}">
        <span>${activityIcons[key]}${ACTIVITY_SHORT[key] ?? activity.label}</span>
      </label>`,
    )
    .join('');
  $('shape').innerHTML = segments('shape', Object.entries(SHAPES));
  $('elevation').innerHTML = segments('elevation', Object.keys(ELEVATION_PREFERENCES).map((key) => [key, ELEVATION_SHORT[key]]));
  $('surface').innerHTML = segments('surface', Object.keys(SURFACES).map((key) => [key, SURFACE_SHORT[key]]));
}

/** Partie remplie des curseurs (le navigateur ne la colore pas partout de la même façon). */
function fillRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${(ratio * 100).toFixed(1)}%`);
}

/** Critères avancés qui s'écartent des valeurs par défaut, en pastilles courtes. */
function advancedTags() {
  const { criteria } = state;
  const tags = [];
  if (criteria.elevation !== 'any') tags.push(ELEVATION_PREFERENCES[criteria.elevation].label);
  if (criteria.maxGain != null) tags.push(`D+ ≤ ${formatElevation(criteria.maxGain)}`);
  if (criteria.surface !== 'any') tags.push(SURFACES[criteria.surface]);
  if (criteria.avoidMajorRoads) tags.push('Sans grands axes');
  if (criteria.proposals !== 3) tags.push(`${criteria.proposals} proposition${criteria.proposals > 1 ? 's' : ''}`);
  return tags;
}

const proposalsLabel = (n) => `Générer ${n} parcours`;

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
  fillRange(distance);

  document.querySelector(`input[name="elevation"][value="${criteria.elevation}"]`).checked = true;
  document.querySelector(`input[name="surface"][value="${criteria.surface}"]`).checked = true;
  $('avoid-major-roads').checked = criteria.avoidMajorRoads;
  $('proposals').textContent = String(criteria.proposals);
  $('proposals-minus').disabled = criteria.proposals <= 1;
  $('proposals-plus').disabled = criteria.proposals >= 5;
  const limited = criteria.maxGain != null;
  $('limit-gain').checked = limited;
  $('max-gain-row').classList.toggle('disabled', !limited);
  $('max-gain').textContent = formatElevation(criteria.maxGain ?? lastMaxGain);
  $('gain-minus').disabled = !limited || criteria.maxGain <= GAIN_STEP;
  $('gain-plus').disabled = !limited;

  const tags = advancedTags();
  $('more-summary').innerHTML = tags.length
    ? tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')
    : '<span class="muted">Dénivelé, revêtement, options</span>';
  $('more-generate-label').textContent = proposalsLabel(criteria.proposals);
  $('criteria-summary-text').textContent = criteriaSummary();
  updatePeek();
}

function criteriaSummary() {
  const { criteria } = state;
  return [ACTIVITIES[criteria.activity].label, SHAPES[criteria.shape], `${criteria.distanceKm} km`, ...advancedTags()].join(' · ');
}

/** Dernière limite de D+ choisie, reprise quand on réactive la limite. */
let lastMaxGain = state.criteria.maxGain ?? 200;

/** Écran « Plus de critères » (dans la même feuille). */
function setMoreOpen(open) {
  $('criteria-more').hidden = !open;
  $('criteria-main').hidden = open;
  $('open-more').setAttribute('aria-expanded', String(open));
  $('panel-scroll').scrollTo({ top: 0 });
  if (open && sheetState !== 'full') snapTo('full', { fit: false });
}

/** Après un calcul, les critères se replient pour laisser la place aux propositions. */
function setCriteriaCollapsed(collapsed) {
  $('criteria-form').classList.toggle('collapsed', collapsed);
  if (collapsed) setMoreOpen(false);
  $('criteria-summary-text').textContent = criteriaSummary();
  updatePeek();
}

$('edit-criteria').addEventListener('click', () => {
  setCriteriaCollapsed(false);
  if (sheetState === 'peek') snapTo('mid');
  $('panel-scroll').scrollTo({ top: 0, behavior: 'smooth' });
});
$('open-more').addEventListener('click', () => setMoreOpen(true));
$('close-more').addEventListener('click', () => setMoreOpen(false));
$('reset-more').addEventListener('click', () => {
  const defaults = sanitizeCriteria({});
  updateCriteria({
    elevation: defaults.elevation,
    maxGain: defaults.maxGain,
    surface: defaults.surface,
    avoidMajorRoads: defaults.avoidMajorRoads,
    proposals: defaults.proposals,
  });
});
$('goto-pace').addEventListener('click', () => settings.open('', { focusPace: true }));

function updateCriteria(changes) {
  state.criteria = sanitizeCriteria({ ...state.criteria, ...changes });
  if (state.criteria.maxGain != null) lastMaxGain = state.criteria.maxGain;
  storage.set(KEYS.criteria, state.criteria);
  // Les propositions affichées ne correspondent plus aux critères : « Générer » redevient la seule action.
  if (!('speeds' in changes)) markResultsStale();
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
$('elevation').addEventListener('change', (event) => updateCriteria({ elevation: event.target.value }));
$('surface').addEventListener('change', (event) => updateCriteria({ surface: event.target.value }));
$('avoid-major-roads').addEventListener('change', (event) => updateCriteria({ avoidMajorRoads: event.target.checked }));
$('proposals-minus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals - 1 }));
$('proposals-plus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals + 1 }));
$('limit-gain').addEventListener('change', (event) => updateCriteria({ maxGain: event.target.checked ? lastMaxGain : null }));
$('gain-minus').addEventListener('click', () => updateCriteria({ maxGain: Math.max(GAIN_STEP, state.criteria.maxGain - GAIN_STEP) }));
$('gain-plus').addEventListener('click', () => updateCriteria({ maxGain: state.criteria.maxGain + GAIN_STEP }));
$('locate').addEventListener('click', () => centerOnMe());
$('quick-generate').addEventListener('click', () => {
  if (state.controller) return; // le calcul en cours s'annule avec « Annuler »
  $('criteria-form').requestSubmit();
});
$('cancel-generate').addEventListener('click', () => state.controller?.abort());

function setStatus(message, isError = false) {
  // Une erreur ne doit pas rester cachée derrière le panneau réduit.
  if (isError && message && sheetState === 'peek') snapTo('mid');
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

// MARK: - Génération

/** Formes étudiées, dessinées en pointillés pendant le tracé. */
let outlineLayers = [];

function clearOutlines() {
  for (const layer of outlineLayers) layer.remove();
  outlineLayers = [];
}

function setStep(id, stepState, text) {
  const item = $(id);
  item.dataset.state = stepState;
  if (text) item.querySelector('span').textContent = text;
}

/** Affiche ou masque l'écran de calcul (étapes + cartes en attente) à la place des critères et résultats. */
function setGenerating(isGenerating) {
  const button = $('quick-generate');
  button.classList.toggle('loading', isGenerating);
  button.setAttribute('aria-busy', String(isGenerating));
  $('cancel-generate').hidden = !isGenerating;
  $('locate').hidden = isGenerating;
  $('route-view').classList.toggle('generating', isGenerating);
  $('progress').hidden = !isGenerating;
  if (isGenerating) {
    setStep('step-relief', 'active', 'Analyse du relief autour du départ');
    setStep('step-trace', 'todo', 'Tracé par les chemins');
    setStep('step-rank', 'todo', 'Classement selon vos critères');
    $('request-note').textContent = '';
    $('quick-generate-label').textContent = 'Calcul…';
  } else {
    clearOutlines();
    updateGenerateLabel();
  }
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
    document.querySelector('input[name="placing"][value="end"]').checked = true;
    setStatus('Touchez la carte pour placer l\'arrivée.', true);
    return;
  }

  showView('route');
  const controller = new AbortController();
  state.controller = controller;
  const requestsBefore = requestsToday();
  setStatus('');
  setGenerating(true);
  // La carte doit rester visible pour suivre les formes étudiées.
  if (sheetState !== 'mid') snapTo('mid', { fit: false });
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
          clearOutlines();
          const color = getComputedStyle(document.documentElement).getPropertyValue('--route').trim();
          outlineLayers = info.outlines.map((points) =>
            L.polyline(points, { color, weight: 3, opacity: 0.75, dashArray: '6 10', className: 'outline-draft', interactive: false }).addTo(map),
          );
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
    const used = requestsToday() - requestsBefore;
    state.lastRequestNote = `${used} requête${used > 1 ? 's' : ''} OpenRouteService pour cette génération · ${requestsToday().toLocaleString('fr-FR')} / ${DAILY_QUOTA.toLocaleString('fr-FR')} aujourd'hui`;
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
  decorateRoute(route);
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

// MARK: Sens du parcours, repères kilométriques et curseur du profil

let decorations = [];
let profileMarker = null;

/** Écart entre deux repères kilométriques, selon la longueur du parcours. */
const kmStep = (km) => (km <= 6 ? 1 : km <= 15 ? 2 : km <= 40 ? 5 : km <= 100 ? 10 : 20);

function decorateRoute(route) {
  for (const layer of decorations) layer.remove();
  decorations = [];
  hideProfileCursor();
  if (route.coordinates.length < 2) return;
  const marker = (point, html, size) =>
    L.marker(point, {
      icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      interactive: false,
      keyboard: false,
    }).addTo(map);

  const arrowSpacing = route.distance / 7;
  for (const { point, bearing } of pointsAlong(route.coordinates, route.distance, arrowSpacing, { offset: arrowSpacing / 2 })) {
    decorations.push(
      marker(
        point,
        `<span class="route-arrow" style="transform: rotate(${Math.round(bearing)}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l7 13H5z"/></svg></span>`,
        18,
      ),
    );
  }
  const step = kmStep(route.distance / 1000) * 1000;
  for (const { distance: at, point } of pointsAlong(route.coordinates, route.distance, step)) {
    decorations.push(marker(point, `<span class="km-marker">${Math.round(at / 1000)}</span>`, 24));
  }
}

/** Point du parcours et altitude à une distance donnée (mètres, distance officielle). */
function routePointAt(route, at) {
  const cumulative = cumulativeDistances(route.coordinates);
  const scale = cumulative.at(-1) > 0 ? route.distance / cumulative.at(-1) : 1;
  const found = pointAtDistance(route.coordinates, at / scale, cumulative);
  let elevation = null;
  const profile = route.profile;
  if (profile.length > 1) {
    const i = Math.max(1, profile.findIndex((p) => p.distance >= at));
    const [p0, p1] = [profile[i - 1], profile[i] ?? profile[i - 1]];
    const t = p1.distance > p0.distance ? (at - p0.distance) / (p1.distance - p0.distance) : 0;
    elevation = p0.elevation + (p1.elevation - p0.elevation) * Math.min(1, Math.max(0, t));
  }
  return { point: found?.point, elevation };
}

function hideProfileCursor() {
  profileMarker?.remove();
  profileMarker = null;
  const cursor = document.querySelector('.chart-cursor');
  if (cursor) cursor.hidden = true;
}

/** Toucher ou survoler le profil : un curseur sur le graphique, le point correspondant sur la carte. */
function bindProfileCursor(route) {
  const plot = document.querySelector('#details .chart-plot');
  if (!plot || route.profile.length < 2) return;
  const cursor = plot.querySelector('.chart-cursor');
  const tip = cursor.querySelector('.chart-tip');
  const total = route.profile.at(-1).distance;

  const move = (event) => {
    const rect = plot.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const at = ratio * total;
    const { point, elevation } = routePointAt(route, at);
    cursor.hidden = false;
    cursor.style.left = `${(ratio * 100).toFixed(2)}%`;
    cursor.classList.toggle('flip', ratio > 0.6);
    tip.textContent = `${formatDistance(at)} · ${formatElevation(elevation)}`;
    if (!point) return;
    if (profileMarker) profileMarker.setLatLng(point);
    else {
      profileMarker = L.marker(point, {
        icon: L.divIcon({ className: '', html: '<span class="profile-marker"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 800,
      }).addTo(map);
    }
    revealPoint(point);
  };
  plot.addEventListener('pointerdown', (event) => {
    plot.setPointerCapture(event.pointerId);
    move(event);
  });
  plot.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || plot.hasPointerCapture(event.pointerId)) move(event);
  });
  plot.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hideProfileCursor();
  });
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
      ${stat('Point haut', formatElevation(route.maxAltitude))}
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

const selectedRoute = () => state.routes.find((r) => r.id === state.selectedId);
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
    state.criteria = sanitizeCriteria({});
    storage.set(KEYS.criteria, state.criteria);
    markResultsStale();
    syncForm();
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

/** Hauteur du contenu affiché dans la feuille (poignée comprise) ; dernière mesure si la feuille est réduite. */
let contentHeight = Infinity;
function measureContent() {
  const scroll = $('panel-scroll');
  const view = [...scroll.children].find((element) => !element.hidden);
  if (!view || scroll.offsetParent === null) return contentHeight;
  const style = getComputedStyle(scroll);
  contentHeight = Math.ceil(
    view.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + $('panel-toggle').offsetHeight + 8,
  );
  return contentHeight;
}

/**
 * Hauteurs (px) des trois positions de la feuille, posée sur la barre d'onglets.
 * La feuille ne monte jamais plus haut que son contenu : peu de contenu, feuille basse.
 */
function sheetHeights() {
  const available = window.innerHeight - tabbarHeight();
  const fit = Math.max(160, measureContent());
  return {
    peek: 78,
    mid: Math.min(Math.round(available * 0.55), fit),
    full: Math.min(Math.round(available - safeArea.top - 48), fit), // laisse visibles les crédits de la carte
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
  // Les boutons « Générer » et de localisation suivent le haut de la feuille…
  const actions = $('sheet-actions');
  actions.classList.toggle('dragging', !animate);
  actions.style.bottom = `${Math.round(height + tabbarHeight() + 12)}px`;
  // … et s'effacent quand elle monte jusqu'en haut de l'écran.
  const opacity = Math.max(0, Math.min(1, (window.innerHeight - tabbarHeight() - height - 90 - safeArea.top) / 50));
  actions.style.opacity = String(opacity);
  actions.style.pointerEvents = opacity < 0.5 ? 'none' : '';
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
    for (const prop of ['opacity', 'pointerEvents', 'bottom']) $('sheet-actions').style[prop] = '';
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
// Le contenu change (résultats, sous-écran, autre onglet…) : la feuille suit sa hauteur.
{
  const refit = () => {
    if (!mobileQuery.matches || sheetState === 'peek' || panel.classList.contains('dragging')) return;
    const target = sheetHeights()[sheetState];
    if (Math.abs(target - currentSheetHeight()) > 4) setSheetHeight(target);
  };
  const observer = new ResizeObserver(() => requestAnimationFrame(refit));
  for (const view of $('panel-scroll').children) observer.observe(view);
}

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
    if (currentView() === 'library') library.refresh();
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
    snapTo(sheetState === 'peek' ? 'mid' : 'peek');
  },
  true,
);

// Changer de vue rouvre la feuille si elle était réduite et revient en haut de son contenu.
onViewChange((view) => {
  // « Générer » n'a de sens que dans la vue Parcours.
  $('sheet-actions').classList.toggle('route-only-hidden', view !== 'route');
  $('panel-scroll').scrollTo({ top: 0 });
  if (sheetState === 'peek') snapTo('mid', { fit: false });
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

buildForm();
syncForm();
snapTo(sheetState, { save: false, fit: false });
if (onboarding.needed) onboarding.start();
else watchMyPosition();
