// Panneau : feuille glissable posée sur la barre d'onglets (téléphone), carte flottante repliable (ordinateur).
import { $ } from './dom.js';
import { KEYS, storage } from './storage.js';

export const mobileQuery = matchMedia('(max-width: 899px)');
const panel = $('panel');
const layout = document.querySelector('.layout');
const SHEET_STATES = ['peek', 'mid', 'full'];
const PEEK_HEIGHT = 78;

/** Position du panneau : « peek » (réduit à une barre), « mid » (mi-hauteur) ou « full » (presque plein écran). */
let sheetState = normalizeSheetState(storage.get(KEYS.panelCollapsed, 'mid'));
export const getSheetState = () => sheetState;

const hooks = { onSnap: () => {}, onSettled: () => {} };

function normalizeSheetState(value) {
  if (value === true) return 'peek'; // ancienne valeur enregistrée
  if (value === false) return 'mid';
  return SHEET_STATES.includes(value) ? value : 'mid';
}

/** Marges de sécurité de l'écran (encoche, barre d'accueil), mesurées une fois. */
export const safeArea = (() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.append(probe);
  const { paddingTop, paddingBottom } = getComputedStyle(probe);
  probe.remove();
  return { top: parseFloat(paddingTop) || 0, bottom: parseFloat(paddingBottom) || 0 };
})();

/**
 * Place occupée en bas de l'écran par la barre d'onglets. Sur téléphone, elle flotte au-dessus du bord :
 * on compte de son haut jusqu'au bas de l'écran, plus un petit espace avant la feuille.
 */
const SHEET_GAP = 0; // la feuille est posée sur la barre : les deux forment une seule carte
const PEEK_GAP = 10; // téléphone, panneau réduit : la barre d'onglets s'efface, la feuille descend jusqu'en bas
export const tabbarHeight = () => {
  if (mobileQuery.matches && layout.classList.contains('map-full')) return Math.round(PEEK_GAP + safeArea.bottom);
  return restingTabbarHeight();
};

/** Place de la barre d'onglets quand elle est affichée (sans le décalage qui la cache, feuille réduite). */
function restingTabbarHeight() {
  if (!mobileQuery.matches) return $('tabbar').offsetHeight;
  return Math.round(parseFloat(getComputedStyle($('tabbar')).bottom) + $('tabbar').offsetHeight) + SHEET_GAP;
}

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
  const available = window.innerHeight - restingTabbarHeight();
  const fit = Math.max(160, measureContent());
  return {
    peek: PEEK_HEIGHT,
    mid: Math.min(Math.round(available * 0.55), fit),
    full: Math.min(Math.round(available - safeArea.top - 48), fit), // laisse visibles les crédits de la carte
  };
}

export function currentSheetHeight() {
  return parseFloat(panel.style.getPropertyValue('--sheet-h')) || sheetHeights()[sheetState];
}

/** Applique une hauteur de feuille ; sans animation pendant que le doigt la déplace. */
function setSheetHeight(height, { animate = true } = {}) {
  panel.classList.toggle('dragging', !animate);
  panel.style.setProperty('--sheet-h', `${Math.round(height)}px`);
  // Réduite, la feuille descend seule en bas de l'écran (la barre d'onglets s'efface) ;
  // sinon elle repose exactement sur la barre d'onglets (sa hauteur dépend de l'appareil).
  layout.classList.toggle('map-full', height <= PEEK_HEIGHT + 12);
  panel.style.bottom = `${tabbarHeight()}px`;
  // Les boutons « Générer » et de localisation suivent le haut de la feuille…
  const actions = $('sheet-actions');
  actions.classList.toggle('dragging', !animate);
  actions.style.bottom = `${Math.round(height + tabbarHeight() + 12)}px`;
  // … et s'effacent quand elle monte jusqu'en haut de l'écran.
  const opacity = Math.max(0, Math.min(1, (window.innerHeight - tabbarHeight() - height - 90 - safeArea.top) / 50));
  actions.style.opacity = String(opacity);
  actions.style.pointerEvents = opacity < 0.5 ? 'none' : '';
}

/**
 * Ordinateur : « Générer » reste collé en bas de la colonne (toujours au même endroit) ;
 * panneau replié, il se place juste au-dessus de la petite carte restante.
 */
const DESKTOP_INSET = 22; // marge intérieure de la colonne
function placeDesktopActions() {
  const actions = $('sheet-actions');
  if (mobileQuery.matches) {
    actions.style.right = '';
    actions.style.width = '';
    return;
  }
  document.documentElement.style.setProperty('--tabbar-h', `${$('tabbar').offsetHeight}px`);
  const rect = panel.getBoundingClientRect();
  if (layout.classList.contains('map-full')) {
    actions.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
    actions.style.width = `${Math.round(rect.width)}px`;
    actions.style.bottom = `${Math.round(window.innerHeight - rect.top + 12)}px`;
  } else {
    actions.style.right = `${Math.round(window.innerWidth - rect.right + DESKTOP_INSET)}px`;
    actions.style.width = `${Math.round(rect.width - DESKTOP_INSET * 2)}px`;
    actions.style.bottom = `${Math.round(window.innerHeight - rect.bottom + 16)}px`;
  }
}

/** Amène le panneau dans une position (téléphone) ou l'ouvre / le ferme (ordinateur). */
export function snapTo(position, { save = true, fit = true } = {}) {
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
    layout.classList.toggle('map-full', collapsed);
    placeDesktopActions();
  }
  hooks.onSnap();
  if (save) storage.set(KEYS.panelCollapsed, position);
  // Une fois l'animation terminée, la carte se recadre (sur le parcours), au-dessus de la feuille.
  if (fit && position !== 'full') {
    setTimeout(() => {
      if (sheetState !== position) return; // un autre geste a eu lieu entre-temps
      hooks.onSettled();
    }, 340);
  }
}

/** Réduit le panneau, ou le rouvre s'il est réduit. */
export const toggleSheet = () => snapTo(sheetState === 'peek' ? 'mid' : 'peek');

/** Hauteur (px) du bas de la carte masquée par le panneau et la barre d'onglets. */
export function hiddenMapBottom() {
  if (mobileQuery.matches) return currentSheetHeight() + tabbarHeight();
  // Ordinateur, panneau replié : seule la petite carte reste en bas à droite.
  if (layout.classList.contains('map-full')) return Math.round(window.innerHeight - panel.getBoundingClientRect().top);
  // Profil du parcours en bandeau sous la carte.
  const strip = document.querySelector('#details .profile-card');
  if (strip?.getClientRects().length) return Math.round(window.innerHeight - strip.getBoundingClientRect().top);
  return 0;
}

/** Largeur (px) de la carte masquée à droite par le panneau flottant (ordinateur uniquement). */
export function hiddenMapRight() {
  if (mobileQuery.matches || layout.classList.contains('map-full')) return 0;
  return Math.round(window.innerWidth - panel.getBoundingClientRect().left);
}

/**
 * @param {object} options
 * @param {() => void} options.onSnap  le panneau change de position
 * @param {() => void} options.onSettled  le panneau a fini de bouger : recadrer la carte
 */
export function initSheet({ onSnap, onSettled }) {
  Object.assign(hooks, { onSnap, onSettled });
  new ResizeObserver(() => placeDesktopActions()).observe(panel);
  window.addEventListener('resize', () => placeDesktopActions());

  // Glisser la poignée : la feuille suit le doigt, puis se cale sur la position la plus proche
  // en tenant compte de l'élan (un petit coup rapide suffit à changer de position).
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
    toggleSheet();
  });

  // Rotation de l'écran, clavier virtuel, passage téléphone ↔ ordinateur : on recale le panneau.
  window.addEventListener('resize', () => snapTo(sheetState, { save: false, fit: false }));
  mobileQuery.addEventListener('change', () => snapTo(sheetState, { save: false }));

  // Le contenu change (résultats, sous-écran, autre onglet…) : la feuille suit sa hauteur.
  let settleTimer = null;
  const refit = () => {
    if (!mobileQuery.matches || sheetState === 'peek' || panel.classList.contains('dragging')) return;
    const target = sheetHeights()[sheetState];
    if (Math.abs(target - currentSheetHeight()) <= 4) return;
    setSheetHeight(target);
    // Une fois la feuille à sa nouvelle hauteur, la carte se recadre au-dessus d'elle.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => hooks.onSettled(), 400);
  };
  const observer = new ResizeObserver(() => requestAnimationFrame(refit));
  for (const view of $('panel-scroll').children) observer.observe(view);
}
