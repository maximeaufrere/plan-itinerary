import { elevationChart } from './chart.js';
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
import { toGpx } from './gpx.js';

/* global L */

// Stockage local : critères, clé API et favoris restent sur l'appareil.
const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      // Navigation privée, stockage bloqué ou plein.
      return false;
    }
  },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const state = {
  criteria: sanitizeCriteria(storage.get('criteria', {})),
  start: null,
  end: null,
  routes: [],
  /** Activité avec laquelle les itinéraires affichés ont été calculés. */
  routesActivity: null,
  selectedId: null,
  controller: null,
  favorites: storage.get('favorites', []).filter(isValidFavorite),
};

// MARK: - Carte

const map = L.map('map', { zoomControl: false }).setView([46.6, 2.4], 6);
map.attributionControl.setPrefix(false);
// Le panneau change de taille (résultats, rotation) : Leaflet doit recalculer la taille de la carte.
new ResizeObserver(() => map.invalidateSize()).observe($('map'));
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openrouteservice.org">openrouteservice</a>',
}).addTo(map);

const pinIcon = (className) => L.divIcon({ className: '', html: `<div class="${className}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const markers = { start: null, end: null };
const routeLayers = new Map();

function setPoint(kind, point) {
  state[kind] = point;
  if (!point) {
    markers[kind]?.remove();
    markers[kind] = null;
    return;
  }
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
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = [position.coords.latitude, position.coords.longitude];
      setPoint('start', point);
      map.setView(point, 14);
      setStatus('');
    },
    (error) => {
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

const options = (entries) => entries.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

function buildForm() {
  $('activity').innerHTML = Object.entries(ACTIVITIES)
    .map(
      ([key, activity]) =>
        `<label class="chip"><input type="radio" name="activity" value="${key}"><span>${activity.icon} ${activity.label}</span></label>`,
    )
    .join('');
  $('shape').innerHTML = Object.entries(SHAPES)
    .map(([key, label]) => `<label><input type="radio" name="shape" value="${key}"><span>${label}</span></label>`)
    .join('');
  $('elevation').innerHTML = options(Object.entries(ELEVATION_PREFERENCES).map(([key, p]) => [key, p.label]));
  $('surface').innerHTML = options(Object.entries(SURFACES));
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

function syncForm() {
  const { criteria } = state;
  const activity = ACTIVITIES[criteria.activity];
  document.querySelector(`input[name="activity"][value="${criteria.activity}"]`).checked = true;
  document.querySelector(`input[name="shape"][value="${criteria.shape}"]`).checked = true;
  $('placing-field').hidden = !isPointToPoint();

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

  $('elevation').value = criteria.elevation;
  $('surface').value = criteria.surface;
  $('avoid-major-roads').checked = criteria.avoidMajorRoads;
  $('proposals').value = String(criteria.proposals);
  $('limit-gain').checked = criteria.maxGain != null;
  $('max-gain').disabled = criteria.maxGain == null;
  $('max-gain').value = criteria.maxGain ?? 200;
}

function updateCriteria(changes) {
  state.criteria = sanitizeCriteria({ ...state.criteria, ...changes });
  storage.set('criteria', state.criteria);
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
$('proposals').addEventListener('change', (event) => updateCriteria({ proposals: Number(event.target.value) }));
$('limit-gain').addEventListener('change', (event) =>
  updateCriteria({ maxGain: event.target.checked ? Number($('max-gain').value) || 200 : null }),
);
$('max-gain').addEventListener('change', (event) => updateCriteria({ maxGain: Number(event.target.value) }));
$('locate').addEventListener('click', () => locate());

function setStatus(message, isError = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

// MARK: - Génération

function setGenerating(isGenerating) {
  const button = $('generate');
  button.textContent = isGenerating ? 'Annuler' : 'Générer';
  button.classList.toggle('primary', !isGenerating);
  button.classList.toggle('secondary', isGenerating);
}

$('criteria-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  if (state.controller) {
    state.controller.abort();
    return;
  }
  const apiKey = storage.get('orsApiKey', '');
  if (!apiKey) {
    openSettings('Ajoutez votre clé OpenRouteService (gratuite) pour générer des itinéraires.');
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
  state.routes = routes;
  state.routesActivity = activity;
  renderRoutes();
  selectRoute(routes[0].id);
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
        <span>↗ ${formatElevation(route.ascent)}</span>
        <span class="card-duration">⏱ ${routeDuration(route)}</span>
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
    card.querySelector('.card-duration').textContent = `⏱ ${routeDuration(route)}`;
  }
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

  const styles = getComputedStyle(document.documentElement);
  for (const [routeId, layer] of routeLayers) {
    const selected = routeId === id;
    layer.setStyle({
      color: styles.getPropertyValue(selected ? '--accent' : '--route-other').trim(),
      weight: selected ? 6 : 4,
      opacity: selected ? 0.95 : 0.7,
    });
    if (selected) layer.bringToFront();
  }
  map.invalidateSize();
  // Marge à droite pour ne pas cacher le tracé sous les boutons flottants (⚙️ ★ et zoom).
  map.fitBounds(routeLayers.get(id).getBounds(), { paddingTopLeft: [30, 30], paddingBottomRight: [70, 30], animate: false });

  for (const card of $('cards').children) {
    card.setAttribute('aria-selected', String(card.dataset.id === id));
  }
  renderDetails(route);
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
  $('details').innerHTML = `
    <div class="stats">
      ${stat('Distance', formatDistance(route.distance))}
      ${stat('D+', formatElevation(route.ascent))}
      ${stat('D−', formatElevation(route.descent))}
      ${stat('Alt. min', formatElevation(route.minAltitude))}
      ${stat('Alt. max', formatElevation(route.maxAltitude))}
      ${stat('Durée', routeDuration(route), 'detail-duration')}
      ${stat('Repassages', route.overlap == null ? '–' : formatPercent(route.overlap))}
      ${stat('Grands axes', route.majorRoads == null ? '–' : formatPercent(route.majorRoads))}
    </div>
    ${surfaceBreakdown(route.surface)}
    ${elevationChart(route.profile)}
    <div class="actions">
      <button type="button" id="save-favorite" class="secondary" ${isFavorite ? 'disabled' : ''}>${isFavorite ? '★ Enregistré' : '☆ Enregistrer'}</button>
      <button type="button" id="export-gpx" class="secondary">⬇︎ GPX</button>
    </div>`;
  $('export-gpx').addEventListener('click', () => exportGpx(route));
  $('save-favorite').addEventListener('click', () => saveFavorite(route));
}

async function exportGpx(route) {
  const name = route.name ?? `${ACTIVITIES[state.routesActivity].label} ${formatDistance(route.distance)}`;
  const fileName = `${name.replace(/[^\p{L}\p{N}]+/gu, '-')}.gpx`;
  const file = new File([toGpx(route, name)], fileName, { type: 'application/gpx+xml' });

  // Sur mobile, la feuille de partage permet d'envoyer directement vers Strava, Komoot, Fichiers…
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// MARK: - Favoris

function saveFavorite(route) {
  const activity = state.routesActivity;
  const suggested = `${ACTIVITIES[activity].label} ${formatDistance(route.distance)}`;
  const name = window.prompt('Nom du parcours', suggested);
  if (name === null) return;

  const favorite = toFavorite(route, { name: name.trim() || suggested, activity });
  const favorites = [favorite, ...state.favorites];
  if (!storage.set('favorites', favorites)) {
    setStatus('Impossible d\'enregistrer : le stockage de ce navigateur est plein ou désactivé.', true);
    return;
  }
  state.favorites = favorites;
  // L'itinéraire affiché devient le favori (même identifiant), pour refléter l'état « enregistré ».
  const saved = { ...fromFavorite(favorite), score: route.score };
  state.routes = state.routes.map((r) => (r.id === route.id ? saved : r));
  renderRoutes();
  selectRoute(saved.id);
  setStatus(`« ${favorite.name} » ajouté aux favoris ★`);
}

function renderFavorites() {
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
  $('favorites-list').innerHTML = state.favorites.length
    ? state.favorites
        .map(
          (favorite) => `
        <li>
          <button type="button" class="favorite-open" data-id="${favorite.id}">
            <strong>${ACTIVITIES[favorite.activity]?.icon ?? ''} ${escapeHtml(favorite.name)}</strong>
            <small>${formatDistance(favorite.route.distance)} · ↗ ${formatElevation(favorite.route.ascent)} · ${dateFormat.format(new Date(favorite.savedAt))}</small>
          </button>
          <button type="button" class="favorite-delete" data-id="${favorite.id}" aria-label="Supprimer ${escapeHtml(favorite.name)}">🗑</button>
        </li>`,
        )
        .join('')
    : '<li class="favorites-empty">Aucun favori pour l\'instant. Utilisez « ☆ Enregistrer » sous un itinéraire.</li>';
}

$('open-favorites').addEventListener('click', () => {
  renderFavorites();
  $('favorites').showModal();
});

$('favorites-list').addEventListener('click', (event) => {
  const open = event.target.closest('.favorite-open');
  const remove = event.target.closest('.favorite-delete');
  if (open) {
    const favorite = state.favorites.find((f) => f.id === open.dataset.id);
    if (!favorite) return;
    $('favorites').close();
    if (ACTIVITIES[favorite.activity]) updateCriteria({ activity: favorite.activity });
    showRoutes([{ ...fromFavorite(favorite), name: favorite.name }], favorite.activity);
    setStatus('');
  } else if (remove) {
    const favorite = state.favorites.find((f) => f.id === remove.dataset.id);
    if (!favorite || !window.confirm(`Supprimer « ${favorite.name} » ?`)) return;
    state.favorites = state.favorites.filter((f) => f.id !== favorite.id);
    storage.set('favorites', state.favorites);
    renderFavorites();
    const shown = state.routes.find((r) => r.id === favorite.id);
    if (shown) renderDetails(shown);
  }
});

// MARK: - Réglages

const settings = $('settings');

function openSettings(message) {
  $('settings-message').hidden = !message;
  $('settings-message').textContent = message ?? '';
  $('api-key').value = storage.get('orsApiKey', '');
  settings.showModal();
}

$('open-settings').addEventListener('click', () => openSettings());
settings.addEventListener('close', () => {
  if (settings.returnValue === 'save') {
    storage.set('orsApiKey', $('api-key').value.trim());
  }
});

// MARK: - Démarrage

buildForm();
syncForm();
locate({ silent: true });
