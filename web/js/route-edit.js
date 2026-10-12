// Ajuster un parcours à la main : des poignées le long du tracé, à faire glisser ; chaque déplacement
// recalcule l'itinéraire en passant par les poignées (1 requête OpenRouteService).
import { $ } from './dom.js';
import { formatDistance } from './format.js';
import { cumulativeDistances, pointAtDistance } from './geo.js';
import { traceThrough } from './generator.js';
import { map } from './map-view.js';

/* global L */

/** Nombre de poignées : environ une tous les 2,5 km, de 3 à 8. */
export const handleCount = (distance) => Math.max(3, Math.min(8, Math.round(distance / 2500)));

/** Points de passage d'un parcours : départ, poignées réparties le long du tracé, arrivée. */
export function viaPoints(route) {
  const { coordinates } = route;
  const cumulative = cumulativeDistances(coordinates);
  const total = cumulative.at(-1);
  const count = handleCount(route.distance);
  const handles = Array.from({ length: count }, (_, k) => pointAtDistance(coordinates, (total * (k + 1)) / (count + 1), cumulative).point);
  return [coordinates[0], ...handles, coordinates.at(-1)];
}

const handleIcon = L.divIcon({ className: '', html: '<span class="edit-handle"></span>', iconSize: [28, 28], iconAnchor: [14, 14] });

/**
 * @param {object} hooks
 * @param {() => object | undefined} hooks.getRoute  parcours affiché
 * @param {() => string} hooks.getActivity
 * @param {() => string} hooks.getApiKey
 * @param {(route: object, previous: object) => void} hooks.replaceRoute  remplace le parcours affiché
 * @param {(message: string, isError?: boolean) => void} hooks.setStatus  erreurs
 * @param {(editing: boolean) => void} hooks.onToggle
 */
export function initRouteEdit(hooks) {
  const hint = (text) => {
    $('edit-hint').textContent = text;
    $('edit-hint').hidden = !text;
  };
  let editing = null; // { original, via, markers, controller }

  function clearMarkers() {
    for (const marker of editing?.markers ?? []) marker.remove();
  }

  function placeHandles() {
    clearMarkers();
    // Départ et arrivée restent fixes : seules les poignées intermédiaires se déplacent.
    editing.markers = editing.via.slice(1, -1).map((point, index) => {
      const marker = L.marker(point, { icon: handleIcon, draggable: true, keyboard: false, zIndexOffset: 900, title: 'Faire glisser pour modifier le tracé' }).addTo(map);
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        editing.via[index + 1] = [lat, lng];
        retrace();
      });
      return marker;
    });
  }

  async function retrace() {
    editing.controller?.abort();
    const controller = new AbortController();
    editing.controller = controller;
    const previous = hooks.getRoute();
    $('edit-done').classList.add('loading');
    hint('Nouveau tracé…');
    try {
      const route = await traceThrough({ points: editing.via, activity: hooks.getActivity(), apiKey: hooks.getApiKey(), signal: controller.signal });
      if (editing?.controller !== controller) return;
      hooks.replaceRoute(route, previous);
      hint(`Tracé modifié : ${formatDistance(route.distance)}. Faites glisser un autre point, ou « Terminé ».`);
      placeHandles();
    } catch (error) {
      if (error.name === 'AbortError') return;
      hint('');
      hooks.setStatus(error.message, true);
      placeHandles(); // les poignées reviennent sur le tracé affiché
    } finally {
      if (editing?.controller === controller) $('edit-done').classList.remove('loading');
    }
  }

  function start() {
    const route = hooks.getRoute();
    if (!route || route.coordinates.length < 2) return;
    if (!hooks.getApiKey()) {
      hooks.setStatus('Il faut une clé OpenRouteService pour recalculer le tracé (Réglages).', true);
      return;
    }
    editing = { original: route, via: viaPoints(route), markers: [] };
    placeHandles();
    hooks.onToggle(true);
    hint('Faites glisser un point blanc : le tracé passera par là.');
  }

  function stop({ revert = false } = {}) {
    if (!editing) return;
    editing.controller?.abort();
    clearMarkers();
    const { original } = editing;
    editing = null;
    $('edit-done').classList.remove('loading');
    if (revert && hooks.getRoute() !== original) hooks.replaceRoute(original, hooks.getRoute());
    hint('');
    hooks.onToggle(false);
  }

  $('edit-done').addEventListener('click', () => stop());
  $('edit-undo').addEventListener('click', () => stop({ revert: true }));

  return { start, stop, get active() { return Boolean(editing); } };
}
