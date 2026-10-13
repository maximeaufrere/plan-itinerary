// Suivre un parcours sur le terrain : position GPS en direct, carte qui accompagne, distance parcourue et restante.
import { $ } from './dom.js';
import { formatDistance } from './format.js';
import { cumulativeDistances, projectOnRoute } from './geo.js';
import { centerOnVisible, map } from './map-view.js';
import { watchMyPosition } from './my-position.js';

/** Au-delà de cet écart (mètres), on signale que l'on a quitté le parcours. */
export const OFF_ROUTE = 60;

/** Texte affiché pendant le suivi, d'après la projection sur le tracé. */
export function followText({ along, offset }, total) {
  if (offset > OFF_ROUTE) return `Hors du parcours (${Math.round(offset)} m) : rejoignez le tracé orange.`;
  const done = Math.min(along, total);
  if (total - done < 50) return 'Arrivée !';
  return `${formatDistance(done)} parcourus · reste ${formatDistance(total - done)}`;
}

/**
 * @param {object} hooks
 * @param {() => object | undefined} hooks.getRoute  parcours affiché
 * @param {(following: boolean) => void} hooks.onToggle
 * @param {(message: string, isError?: boolean) => void} hooks.setStatus
 */
export function initFollow(hooks) {
  let following = null; // { route, cumulative, scale, watch, along, lock, centered }
  const info = (text) => {
    $('follow-info').textContent = text;
    $('follow-info').hidden = !text;
  };

  // L'écran reste allumé pendant le suivi (si le navigateur le permet).
  async function keepAwake() {
    try {
      if (following && document.visibilityState === 'visible') following.lock = await navigator.wakeLock?.request('screen');
    } catch {
      // Économie d'énergie, permission refusée : le suivi marche quand même.
    }
  }
  document.addEventListener('visibilitychange', keepAwake);

  // Déplacer la carte à la main suspend le recentrage ; le bouton de localisation le rétablit.
  map.on('dragstart', () => {
    if (following) following.centered = false;
  });

  function onPosition(position) {
    if (!following) return;
    const point = [position.coords.latitude, position.coords.longitude];
    const { route, cumulative, scale } = following;
    const projection = projectOnRoute(route.coordinates, point, cumulative, { near: following.along });
    if (!projection) return;
    // Hors du tracé, on garde la dernière distance parcourue pour reprendre au bon endroit.
    if (projection.offset <= OFF_ROUTE) following.along = projection.along;
    info(followText({ along: projection.along * scale, offset: projection.offset }, route.distance));
    if (following.centered) centerOnVisible(point, Math.max(map.getZoom(), 16), { animate: true });
  }

  function start() {
    const route = hooks.getRoute();
    if (!route || following) return;
    if (!('geolocation' in navigator)) {
      hooks.setStatus('Géolocalisation indisponible sur cet appareil : impossible de suivre le parcours.', true);
      return;
    }
    const cumulative = cumulativeDistances(route.coordinates);
    following = {
      route,
      cumulative,
      scale: cumulative.at(-1) > 0 ? route.distance / cumulative.at(-1) : 1,
      along: 0,
      centered: true,
      lock: null,
      watch: null,
    };
    watchMyPosition(); // point bleu
    following.watch = navigator.geolocation.watchPosition(onPosition, (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        stop();
        hooks.setStatus('Localisation refusée : autorisez-la pour suivre le parcours.', true);
      }
    }, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 });
    info('Recherche de votre position…');
    keepAwake();
    hooks.onToggle(true);
  }

  function stop() {
    if (!following) return;
    navigator.geolocation.clearWatch(following.watch);
    following.lock?.release().catch(() => {});
    following = null;
    info('');
    hooks.onToggle(false);
  }

  /** Recentre la carte sur la position et reprend l'accompagnement. */
  function recenter() {
    if (following) following.centered = true;
  }

  $('follow-stop').addEventListener('click', stop);
  return { start, stop, recenter, isFollowing: () => Boolean(following) };
}
