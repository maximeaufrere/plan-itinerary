// Stockage local : critères, clé API, favoris et préférences restent sur l'appareil.
// Chaque accès est protégé : en navigation privée ou si le stockage est bloqué, l'app fonctionne sans mémoriser.

export const KEYS = {
  criteria: 'criteria',
  apiKey: 'orsApiKey',
  favorites: 'favorites',
  theme: 'theme',
  baseLayer: 'baseLayer',
  welcomeDismissed: 'welcomeDismissed',
};

export const storage = {
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
      return false;
    }
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
