// Règles de synchronisation entre le stockage local et le compte en ligne (fonctions pures, testées).

/**
 * Fusionne les favoris locaux et ceux du compte.
 * - Un favori seulement local et jamais synchronisé (créé hors connexion) est envoyé au compte.
 * - Un favori seulement local mais déjà synchronisé auparavant a été supprimé depuis un autre appareil : on l'oublie.
 * @returns {{ favorites: object[], toUpload: object[] }}
 */
export function mergeFavoriteLists(local, remote, syncedIds = []) {
  const remoteIds = new Set(remote.map((f) => f.id));
  const synced = new Set(syncedIds);
  const toUpload = local.filter((f) => !remoteIds.has(f.id) && !synced.has(f.id));
  const favorites = [...remote, ...toUpload].sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return { favorites, toUpload };
}

/** Favoris ajoutés ou supprimés entre deux versions de la liste. */
export function diffFavorites(previous, next) {
  const before = new Map(previous.map((f) => [f.id, f]));
  const after = new Map(next.map((f) => [f.id, f]));
  return {
    added: next.filter((f) => !before.has(f.id)),
    removed: previous.filter((f) => !after.has(f.id)).map((f) => f.id),
  };
}

/**
 * Choisit la version des réglages à garder : la plus récente l'emporte.
 * Un compte encore vide reçoit toujours les réglages de l'appareil (dont la clé OpenRouteService).
 * @returns {'remote' | 'local'}
 */
export function newerSettings(localUpdatedAt, remote) {
  if (!remote) return 'local';
  if (!localUpdatedAt) return 'remote';
  return Date.parse(remote.updated_at) >= Date.parse(localUpdatedAt) ? 'remote' : 'local';
}

/** Statistiques d'un ensemble de sorties. */
export function outingStats(outings) {
  const stats = { count: outings.length, distance: 0, ascent: 0, duration: 0, byActivity: {} };
  for (const outing of outings) {
    stats.distance += outing.distance_m ?? 0;
    stats.ascent += outing.ascent_m ?? 0;
    stats.duration += outing.duration_s ?? 0;
    stats.byActivity[outing.activity] = (stats.byActivity[outing.activity] ?? 0) + (outing.distance_m ?? 0);
  }
  return stats;
}

/** Sorties d'une période : « 30 » derniers jours, « year » (année en cours) ou « all ». */
export function filterOutings(outings, period, today = new Date()) {
  if (period === 'all') return outings;
  if (period === 'year') {
    const year = String(today.getFullYear());
    return outings.filter((o) => String(o.done_on).startsWith(year));
  }
  const since = new Date(today);
  since.setDate(since.getDate() - 30);
  const limit = since.toISOString().slice(0, 10);
  return outings.filter((o) => String(o.done_on) >= limit);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Identifiant aléatoire non devinable pour les liens de partage. */
export function randomId(length = 12, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
