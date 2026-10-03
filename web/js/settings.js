import { ACTIVITIES, SPEED_RANGES } from './criteria.js';
import { isValidFavorite } from './favorites.js';
import { formatPace } from './format.js';
import { BASE_LAYERS, DEFAULT_BASE_LAYER } from './layers.js';
import { DAILY_QUOTA, fetchRoute, requestsToday } from './ors.js';
import { shareOrDownload } from './share.js';
import { KEYS, applyTheme, storage } from './storage.js';
import { showView } from './views.js';

export const APP_VERSION = '2.0';

// Deux points proches à Paris : un itinéraire minuscule suffit pour vérifier la clé.
const TEST_POINTS = [
  [48.8566, 2.3522],
  [48.8606, 2.3376],
];

const $ = (id) => document.getElementById(id);

/**
 * Vérifie une clé OpenRouteService avec un itinéraire minuscule.
 * @returns {Promise<{ok: boolean, message: string, kind: 'ok' | 'warning' | 'error'}>}
 */
export async function testApiKey(apiKey) {
  try {
    await fetchRoute({ apiKey, profile: 'foot-walking', points: TEST_POINTS });
    return { ok: true, message: 'Clé valide, tout est prêt.', kind: 'ok' };
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, message: 'Clé refusée : vérifiez qu\'elle a été copiée en entier.', kind: 'error' };
    }
    if (error.status === 429) return { ok: true, message: 'Clé valide, mais le quota est atteint pour le moment.', kind: 'warning' };
    return { ok: false, message: error.message, kind: 'error' };
  }
}

/** Réglage d'allure : à pied en secondes par km (pas de 5 s), à vélo en km/h (pas de 1). */
export function stepSpeed(activityKey, speedKmh, direction) {
  const { kind } = ACTIVITIES[activityKey];
  const [min, max] = SPEED_RANGES[kind];
  let next;
  if (kind === 'foot') {
    // Allure plus rapide = moins de secondes par km.
    const seconds = Math.round(3600 / speedKmh / 5) * 5 - direction * 5;
    next = 3600 / seconds;
  } else {
    next = Math.round(speedKmh) + direction;
  }
  return Math.min(max, Math.max(min, next));
}

export const formatSpeed = (activityKey, speedKmh) =>
  ACTIVITIES[activityKey].kind === 'foot' ? formatPace(speedKmh) : `${Math.round(speedKmh)} km/h`;

/** Fusionne des favoris importés avec les existants (sans doublon d'identifiant). */
export function mergeFavorites(existing, imported) {
  const known = new Set(existing.map((f) => f.id));
  const added = imported.filter((f) => isValidFavorite(f) && !known.has(f.id));
  return { favorites: [...existing, ...added], added: added.length };
}

/** Lit un fichier d'export (ou une simple liste de favoris). */
export function parseFavoritesFile(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.favorites;
  if (!Array.isArray(list)) throw new Error('Ce fichier ne contient pas de favoris.');
  return list;
}

/**
 * Branche le panneau de réglages.
 * @returns {{ open: (message?: string) => void }}
 */
export function initSettings({ getFavorites, setFavorites, onBaseLayerChange, onThemeChange, onResetCriteria, getSpeeds, setSpeed }) {
  const dialog = $('settings');
  const keyInput = $('api-key');

  // MARK: Clé
  const keyStatus = (message, kind = '') => {
    $('key-status').textContent = message;
    $('key-status').className = `key-status ${kind}`;
  };

  keyInput.addEventListener('input', () => {
    storage.set(KEYS.apiKey, keyInput.value.trim());
    keyStatus('');
    refreshKeyState();
  });

  $('toggle-key').addEventListener('click', (event) => {
    const visible = keyInput.type === 'password';
    keyInput.type = visible ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-pressed', String(visible));
    event.currentTarget.setAttribute('aria-label', visible ? 'Masquer la clé' : 'Afficher la clé');
  });

  $('test-key').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      keyStatus('Collez d\'abord votre clé.', 'error');
      return;
    }
    button.disabled = true;
    keyStatus('Test en cours…');
    const result = await testApiKey(apiKey);
    keyStatus(result.message, result.kind);
    button.disabled = false;
    refreshKeyState();
    refreshQuota();
  });

  /** État de la clé ; l'éditeur s'ouvre d'office s'il n'y en a pas. */
  function refreshKeyState({ forceEditor = false } = {}) {
    const hasKey = Boolean(storage.get(KEYS.apiKey, ''));
    $('key-dot').classList.toggle('on', hasKey);
    $('key-state-text').textContent = hasKey ? 'Clé enregistrée' : 'Aucune clé';
    const open = forceEditor || !hasKey || !$('key-editor').hidden;
    $('key-editor').hidden = !open;
    $('change-key').hidden = !hasKey;
    $('change-key').textContent = open ? 'Fermer' : 'Changer';
    $('change-key').setAttribute('aria-expanded', String(open));
  }

  $('change-key').addEventListener('click', () => {
    const open = $('key-editor').hidden;
    $('key-editor').hidden = !open;
    refreshKeyState();
    if (open) keyInput.focus({ preventScroll: true });
  });

  /** Requêtes envoyées aujourd'hui depuis cet appareil. */
  function refreshQuota() {
    const used = requestsToday();
    const left = Math.max(0, DAILY_QUOTA - used);
    $('quota-count').textContent = `${used.toLocaleString('fr-FR')} / ${DAILY_QUOTA.toLocaleString('fr-FR')}`;
    $('quota-bar').style.width = `${Math.min(100, (used / DAILY_QUOTA) * 100).toFixed(1)}%`;
    $('quota-bar').classList.toggle('high', used > DAILY_QUOTA * 0.8);
    $('quota-note').textContent = left
      ? `Environ ${Math.floor(left / 2).toLocaleString('fr-FR')} générations encore possibles aujourd'hui (comptées sur cet appareil).`
      : 'Quota du jour probablement atteint : il se renouvelle dans la nuit.';
  }

  // MARK: Allure
  function renderPaces() {
    const speeds = getSpeeds();
    $('pace-list').innerHTML = Object.entries(ACTIVITIES)
      .map(
        ([key, activity]) => `
        <div class="list-row">
          <span class="list-label">${activity.label}</span>
          <div class="stepper" role="group" aria-label="${activity.kind === 'foot' ? 'Allure' : 'Vitesse moyenne'} ${activity.label}">
            <button type="button" data-pace="${key}" data-step="-1" aria-label="Plus lent"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg></button>
            <output class="pace-value">${formatSpeed(key, speeds[key])}</output>
            <button type="button" data-pace="${key}" data-step="1" aria-label="Plus rapide"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>
          </div>
        </div>`,
      )
      .join('');
  }

  $('pace-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pace]');
    if (!button) return;
    const key = button.dataset.pace;
    setSpeed(key, stepSpeed(key, getSpeeds()[key], Number(button.dataset.step)));
    renderPaces();
  });

  // MARK: Affichage
  $('base-layer').innerHTML = Object.entries(BASE_LAYERS)
    .map(
      ([key, layer]) => `
      <label>
        <input type="radio" name="base-layer" value="${key}">
        <strong>${layer.label}</strong>
        <small>${layer.description}</small>
      </label>`,
    )
    .join('');

  $('theme').addEventListener('change', (event) => {
    storage.set(KEYS.theme, event.target.value);
    applyTheme(event.target.value);
    onThemeChange();
  });

  $('base-layer').addEventListener('change', (event) => {
    storage.set(KEYS.baseLayer, event.target.value);
    onBaseLayerChange(event.target.value);
  });

  // MARK: Données
  const dataStatus = (message, kind = 'ok') => {
    $('data-status').textContent = message;
    $('data-status').className = `key-status ${kind}`;
  };
  const refreshCount = () => {
    const count = getFavorites().length;
    $('settings-favorites-count').textContent = count ? `(${count})` : '';
    $('export-favorites').disabled = count === 0;
  };

  $('export-favorites').addEventListener('click', () => {
    const date = new Date().toISOString().slice(0, 10);
    const payload = { app: 'plan-itinerary', version: 1, exportedAt: new Date().toISOString(), favorites: getFavorites() };
    const file = new File([JSON.stringify(payload)], `favoris-plan-itineraire-${date}.json`, { type: 'application/json' });
    shareOrDownload(file, 'Favoris Plan Itinéraire');
  });

  $('import-favorites').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    try {
      const { favorites, added } = mergeFavorites(getFavorites(), parseFavoritesFile(await file.text()));
      if (!setFavorites(favorites)) throw new Error('Le stockage de ce navigateur est plein ou désactivé.');
      dataStatus(added ? `${added} favori${added > 1 ? 's' : ''} importé${added > 1 ? 's' : ''}.` : 'Aucun nouveau favori dans ce fichier.');
      refreshCount();
    } catch (error) {
      dataStatus(`Import impossible : ${error instanceof SyntaxError ? 'fichier illisible.' : error.message}`, 'error');
    }
  });

  $('reset-criteria').addEventListener('click', () => {
    if (!window.confirm('Revenir aux critères par défaut (activité, distance, allures…) ?')) return;
    onResetCriteria();
    dataStatus('Critères réinitialisés.');
  });

  $('clear-all').addEventListener('click', () => {
    if (!window.confirm('Effacer toutes les données de l\'app sur cet appareil (clé, favoris, réglages) ? C\'est définitif.')) return;
    storage.clearAll();
    window.location.reload();
  });

  $('app-version').textContent = `v${APP_VERSION}`;

  return {
    open(message, { focusPace = false } = {}) {
      $('settings-message').hidden = !message;
      $('settings-message').textContent = message ?? '';
      keyInput.value = storage.get(KEYS.apiKey, '');
      keyStatus('');
      $('data-status').textContent = '';
      const theme = storage.get(KEYS.theme, 'auto');
      dialog.querySelector(`input[name="theme"][value="${['light', 'dark'].includes(theme) ? theme : 'auto'}"]`).checked = true;
      const layer = storage.get(KEYS.baseLayer, DEFAULT_BASE_LAYER);
      dialog.querySelector(`input[name="base-layer"][value="${BASE_LAYERS[layer] ? layer : DEFAULT_BASE_LAYER}"]`).checked = true;
      $('key-editor').hidden = true;
      refreshKeyState({ forceEditor: Boolean(message) });
      refreshQuota();
      renderPaces();
      refreshCount();
      showView('settings');
      if (message) keyInput.focus({ preventScroll: true });
      if (focusPace) requestAnimationFrame(() => $('pace-section').scrollIntoView({ block: 'start', behavior: 'smooth' }));
    },
    refreshQuota,
  };
}
