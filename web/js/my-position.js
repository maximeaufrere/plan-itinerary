// Ma position : point bleu sur la carte, indépendant du départ et de l'arrivée.
import { distance } from './geo.js';
import { map } from './map-view.js';

/* global L */

/** Dernière position connue de l'utilisateur, [lat, lon], ou null. */
let myPosition = null;
let myMarker = null;
let myAccuracy = null;
let positionWatch = null;
let firstFixHandled = false;
const hooks = { onMove: () => {}, onFirstFix: () => {} };

const myIcon = L.divIcon({ className: '', html: '<div class="me-marker"><span></span></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

/**
 * @param {object} options
 * @param {() => void} options.onMove  le point bleu a bougé
 * @param {(point: number[]) => void} options.onFirstFix  premier repérage de la position
 */
export function initMyPosition({ onMove, onFirstFix }) {
  Object.assign(hooks, { onMove, onFirstFix });
}

/** Le point est-il (à 20 m près) ma position ? */
export const isMyPosition = (point) => Boolean(myPosition && point && distance(myPosition, point) < 20);

function showMyPosition(point, accuracy) {
  myPosition = point;
  if (!myMarker) {
    myAccuracy = L.circle(point, { radius: accuracy, className: 'me-accuracy', interactive: false }).addTo(map);
    myMarker = L.marker(point, { icon: myIcon, title: 'Ma position', keyboard: false, interactive: false, zIndexOffset: 500 }).addTo(map);
  } else {
    myMarker.setLatLng(point);
    myAccuracy.setLatLng(point).setRadius(accuracy);
  }
  hooks.onMove();
}

const positionErrorMessage = (error) =>
  error.code === error.PERMISSION_DENIED
    ? 'Localisation refusée : touchez la carte ou tapez une adresse pour choisir un départ.'
    : 'Position introuvable : touchez la carte ou tapez une adresse pour choisir un départ.';

/** Suit la position en continu pour garder le point bleu à jour. */
export function watchMyPosition() {
  if (!('geolocation' in navigator) || positionWatch !== null) return;
  positionWatch = navigator.geolocation.watchPosition(
    (position) => {
      const point = [position.coords.latitude, position.coords.longitude];
      showMyPosition(point, position.coords.accuracy);
      if (!firstFixHandled) {
        firstFixHandled = true;
        hooks.onFirstFix(point);
      }
    },
    () => {
      // Erreurs signalées par les actions explicites (bouton, raccourci « Ma position »).
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

/** Position actuelle : la dernière connue si elle est récente, sinon une nouvelle mesure. */
export function getMyPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Géolocalisation indisponible : touchez la carte ou tapez une adresse pour choisir un départ.'));
      return;
    }
    if (myPosition) {
      resolve(myPosition);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = [position.coords.latitude, position.coords.longitude];
        showMyPosition(point, position.coords.accuracy);
        resolve(point);
      },
      (error) => reject(new Error(positionErrorMessage(error))),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}
