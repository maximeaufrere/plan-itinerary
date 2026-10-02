import { isValidFavorite } from './favorites.js';
import { BASE_LAYERS, DEFAULT_BASE_LAYER } from './layers.js';
import { fetchRoute } from './ors.js';
import { shareOrDownload } from './share.js';
import { KEYS, applyTheme, storage } from './storage.js';

export const APP_VERSION = '1.2';

// Deux points proches à Paris : un itinéraire minuscule suffit pour vérifier la clé.
const TEST_POINTS = [
  [48.8566, 2.3522],
  [48.8606, 2.3376],
];

const $ = (id) => document.getElementById(id);

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
export function initSettings({ getFavorites, setFavorites, onBaseLayerChange, onThemeChange, onResetCriteria }) {
  const dialog = $('settings');
  const keyInput = $('api-key');

  // Fermeture : bouton OK, ou toucher le fond grisé autour du panneau.
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });

  // MARK: Clé
  const keyStatus = (message, kind = '') => {
    $('key-status').textContent = message;
    $('key-status').className = `key-status ${kind}`;
  };

  keyInput.addEventListener('input', () => {
    storage.set(KEYS.apiKey, keyInput.value.trim());
    keyStatus('');
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
    try {
      await fetchRoute({ apiKey, profile: 'foot-walking', points: TEST_POINTS });
      keyStatus('Clé valide, tout est prêt.', 'ok');
    } catch (error) {
      if (error.status === 401 || error.status === 403) keyStatus('Clé refusée : vérifiez qu\'elle a été copiée en entier.', 'error');
      else if (error.status === 429) keyStatus('Clé valide, mais le quota est atteint pour le moment.', 'warning');
      else keyStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
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
    $('favorites-count').textContent = count ? `(${count})` : '';
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
    open(message) {
      $('settings-message').hidden = !message;
      $('settings-message').textContent = message ?? '';
      keyInput.value = storage.get(KEYS.apiKey, '');
      keyStatus('');
      $('data-status').textContent = '';
      const theme = storage.get(KEYS.theme, 'auto');
      dialog.querySelector(`input[name="theme"][value="${['light', 'dark'].includes(theme) ? theme : 'auto'}"]`).checked = true;
      const layer = storage.get(KEYS.baseLayer, DEFAULT_BASE_LAYER);
      dialog.querySelector(`input[name="base-layer"][value="${BASE_LAYERS[layer] ? layer : DEFAULT_BASE_LAYER}"]`).checked = true;
      refreshCount();
      dialog.showModal();
      if (message) keyInput.focus();
    },
  };
}
