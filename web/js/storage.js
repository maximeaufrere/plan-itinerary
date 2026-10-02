// Stockage local : critères, clé API, favoris et préférences restent sur l'appareil.
// Chaque accès est protégé : en navigation privée ou si le stockage est bloqué, l'app fonctionne sans mémoriser.

export const KEYS = {
  criteria: 'criteria',
  apiKey: 'orsApiKey',
  favorites: 'favorites',
  theme: 'theme',
  baseLayer: 'baseLayer',
  welcomeDismissed: 'welcomeDismissed',
  panelCollapsed: 'panelCollapsed',
  /** Favoris déjà présents dans le compte lors de la dernière synchronisation. */
  syncedFavoriteIds: 'syncedFavoriteIds',
  /** Date de la dernière modification locale des réglages synchronisés. */
  settingsUpdatedAt: 'settingsUpdatedAt',
};

const listeners = new Set();

export const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  /** `silent` : n'avertit pas les observateurs (données venant du compte en ligne). */
  set(key, value, { silent = false } = {}) {
    let saved;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      saved = true;
    } catch {
      saved = false;
    }
    if (!silent) for (const listener of listeners) listener(key, value);
    return saved;
  },
  /** Observe les modifications faites par l'app (pour la synchronisation). */
  onChange(listener) {
    listeners.add(listener);
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Rien à faire.
    }
  },
  clearAll() {
    for (const key of Object.values(KEYS)) this.remove(key);
  },
};

/** Applique le thème choisi (« auto » suit le réglage du téléphone). */
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
