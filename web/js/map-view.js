// Carte Leaflet : fond de carte et cadrage dans la partie visible (hors panneau).
import { $ } from './dom.js';
import { BASE_LAYERS, DEFAULT_BASE_LAYER } from './layers.js';
import { currentSheetHeight, hiddenMapBottom, hiddenMapRight, mobileQuery, safeArea, tabbarHeight } from './sheet.js';
import { KEYS, storage } from './storage.js';

/* global L */

export const map = L.map('map', { zoomControl: false }).setView([46.6, 2.4], 6);
map.attributionControl.setPrefix(false);
// Le panneau change de taille (résultats, rotation) : Leaflet doit recalculer la taille de la carte.
new ResizeObserver(() => map.invalidateSize()).observe($('map'));
L.control.zoom({ position: 'bottomright' }).addTo(map);
let baseLayer = null;

export function setBaseLayer(key) {
  const config = BASE_LAYERS[key] ?? BASE_LAYERS[DEFAULT_BASE_LAYER];
  baseLayer?.remove();
  baseLayer = L.tileLayer(config.url, {
    maxZoom: config.maxZoom,
    attribution: `${config.attribution} · <a href="https://openrouteservice.org">openrouteservice</a>`,
  }).addTo(map);
  baseLayer.bringToBack();
}

setBaseLayer(storage.get(KEYS.baseLayer, DEFAULT_BASE_LAYER));

/** Centre la carte sur un point dans la partie visible, au-dessus du panneau. */
export function centerOnVisible(point, zoom = map.getZoom(), options = {}) {
  const target = map.project(point, zoom).add([hiddenMapRight() / 2, hiddenMapBottom() / 2]);
  map.setView(map.unproject(target, zoom), zoom, options);
}

/** Si le point est caché sous le panneau (ou trop près des bords), le ramène dans la partie visible. */
export function revealPoint(point) {
  const position = map.latLngToContainerPoint(point);
  const visibleBottom = map.getSize().y - hiddenMapBottom();
  const visibleRight = map.getSize().x - hiddenMapRight();
  if (position.y > visibleBottom - 48 || position.y < 48 || position.x < 24 || position.x > visibleRight - 24) {
    centerOnVisible(point, map.getZoom(), { animate: true });
  }
}

/** Cadre la carte sur un ou deux points, dans la partie visible au-dessus du panneau. */
export function showPoints(points) {
  const valid = points.filter(Boolean);
  if (valid.length === 1) {
    centerOnVisible(valid[0], Math.max(map.getZoom(), 14), { animate: true });
  } else if (valid.length > 1) {
    map.fitBounds(L.latLngBounds(valid), {
      paddingTopLeft: [40, 60 + (mobileQuery.matches ? safeArea.top : 0)],
      paddingBottomRight: [40 + hiddenMapRight(), hiddenMapBottom() + 40],
      maxZoom: 15,
    });
  }
}

/** Cadre la carte sur un tracé, dans la partie visible. */
export function fitToLayer(layer, { animate = false } = {}) {
  map.invalidateSize();
  // Sur téléphone, la carte passe sous la feuille et les boutons flottants (« Générer »…) :
  // on garde le parcours dans la partie visible, avec la place des étiquettes Départ / Arrivée en haut.
  const floating = mobileQuery.matches ? $('sheet-actions').offsetHeight + 12 : 0;
  const bottom = mobileQuery.matches
    ? Math.min(currentSheetHeight() + tabbarHeight(), window.innerHeight * 0.65) + floating + 16
    : hiddenMapBottom() + 30;
  map.fitBounds(layer.getBounds(), {
    paddingTopLeft: [30, 64 + (mobileQuery.matches ? safeArea.top : 0)],
    paddingBottomRight: [30 + hiddenMapRight(), bottom],
    animate,
  });
}
