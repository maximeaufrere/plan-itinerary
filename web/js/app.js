import { elevationChart } from './chart.js';
import { ACTIVITIES, ELEVATION_PREFERENCES, SHAPES, estimatedDuration, sanitizeCriteria } from './criteria.js';
import { formatDistance, formatDuration, formatElevation } from './format.js';
import { generateRoutes } from './generator.js';
import { toGpx } from './gpx.js';

/* global L */

// Stockage local : simple confort (critères, clé API), l'app fonctionne sans.
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
    } catch {
      // Navigation privée ou stockage bloqué : on continue sans mémoriser.
    }
  },
};

const $ = (id) => document.getElementById(id);

const state = {
  criteria: sanitizeCriteria(storage.get('criteria', {})),
  start: null,
  routes: [],
  selectedId: null,
  controller: null,
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

const startIcon = L.divIcon({ className: '', html: '<div class="start-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
let startMarker = null;
const routeLayers = new Map();

function setStart(point) {
  state.start = point;
  if (startMarker) startMarker.setLatLng(point);
  else startMarker = L.marker(point, { icon: startIcon, title: 'Départ', keyboard: false }).addTo(map);
}

map.on('click', (event) => {
  setStart([event.latlng.lat, event.latlng.lng]);
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
      setStart(point);
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
  $('elevation').innerHTML = Object.entries(ELEVATION_PREFERENCES)
    .map(([key, preference]) => `<option value="${key}">${preference.label}</option>`)
    .join('');
}

function syncForm() {
  const { criteria } = state;
  const activity = ACTIVITIES[criteria.activity];
  document.querySelector(`input[name="activity"][value="${criteria.activity}"]`).checked = true;
  document.querySelector(`input[name="shape"][value="${criteria.shape}"]`).checked = true;
  const distance = $('distance');
  [distance.min, distance.max] = activity.range;
  distance.value = criteria.distanceKm;
  $('distance-output').textContent = `${criteria.distanceKm} km`;
  $('elevation').value = criteria.elevation;
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
$('shape').addEventListener('change', (event) => updateCriteria({ shape: event.target.value }));
$('distance').addEventListener('input', (event) => updateCriteria({ distanceKm: Number(event.target.value) }));
$('elevation').addEventListener('change', (event) => updateCriteria({ elevation: event.target.value }));
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

  const controller = new AbortController();
  state.controller = controller;
  setGenerating(true);
  setStatus('Calcul des itinéraires…');

  try {
    const routes = await generateRoutes({
      start: state.start,
      criteria: state.criteria,
      apiKey,
      signal: controller.signal,
      onProgress: (index, total) => setStatus(`Calcul de l'itinéraire ${index + 1} sur ${total}…`),
    });
    state.routes = routes;
    renderRoutes();
    selectRoute(routes[0].id);
    setStatus('');
  } catch (error) {
    if (error.name === 'AbortError') setStatus('Génération annulée.');
    else setStatus(error.message, true);
  } finally {
    state.controller = null;
    setGenerating(false);
  }
});

// MARK: - Résultats

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
        <small>Proposition ${index + 1}</small>
        <strong>${formatDistance(route.distance)}</strong>
        <span>↗ ${formatElevation(route.ascent)}</span>
        <span>⏱ ${formatDuration(estimatedDuration(route, state.criteria.activity))}</span>
      </button>`,
    )
    .join('');
  $('results').hidden = state.routes.length === 0;
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
  map.fitBounds(routeLayers.get(id).getBounds(), { padding: [30, 30], animate: false });

  for (const card of $('cards').children) {
    card.setAttribute('aria-selected', String(card.dataset.id === id));
  }
  renderDetails(route);
}

function renderDetails(route) {
  const activity = state.criteria.activity;
  const stat = (label, value) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`;
  $('details').innerHTML = `
    <div class="stats">
      ${stat('Distance', formatDistance(route.distance))}
      ${stat('D+', formatElevation(route.ascent))}
      ${stat('D−', formatElevation(route.descent))}
      ${stat('Alt. min', formatElevation(route.minAltitude))}
      ${stat('Alt. max', formatElevation(route.maxAltitude))}
      ${stat('Durée', formatDuration(estimatedDuration(route, activity)))}
    </div>
    ${elevationChart(route.profile)}
    <div class="actions">
      <button type="button" id="export-gpx" class="secondary">⬇︎ Exporter en GPX</button>
    </div>`;
  $('export-gpx').addEventListener('click', () => exportGpx(route));
}

async function exportGpx(route) {
  const name = `${ACTIVITIES[state.criteria.activity].label} ${formatDistance(route.distance)}`;
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
