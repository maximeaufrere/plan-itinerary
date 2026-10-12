// Sur la carte : sens du parcours, repères kilométriques et point qui suit le curseur du profil.
import { formatGrade, gradeAt } from './chart.js';
import { formatDistance, formatElevation } from './format.js';
import { cumulativeDistances, distance, pointAtDistance, pointsAlong } from './geo.js';
import { map, revealPoint } from './map-view.js';

/* global L */

let decorations = [];
let profileMarker = null;

const FLAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4h13l-2 4 2 4H5" /></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';

/** Étiquette d'extrémité : un point sur le tracé, et au-dessus « Départ », « Arrivée » ou les deux. */
function endpointMarker(point, kind) {
  const label = { start: `${PLAY}Départ`, end: `${FLAG}Arrivée`, both: `${PLAY}Départ · Arrivée${FLAG}` }[kind];
  return L.marker(point, {
    icon: L.divIcon({
      className: '',
      html: `<div class="route-end ${kind}"><span class="route-end-label">${label}</span><span class="route-end-dot"></span></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 700,
  });
}

/** Écart entre deux repères kilométriques, selon la longueur du parcours. */
const kmStep = (km) => (km <= 6 ? 1 : km <= 15 ? 2 : km <= 40 ? 5 : km <= 100 ? 10 : 20);

export function decorateRoute(route) {
  for (const layer of decorations) layer.remove();
  decorations = [];
  hideProfileCursor();
  if (route.coordinates.length < 2) return;
  const marker = (point, html, size) =>
    L.marker(point, {
      icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      interactive: false,
      keyboard: false,
    }).addTo(map);

  const arrowSpacing = route.distance / 7;
  for (const { point, bearing } of pointsAlong(route.coordinates, route.distance, arrowSpacing, { offset: arrowSpacing / 2 })) {
    decorations.push(
      marker(
        point,
        `<span class="route-arrow" style="transform: rotate(${Math.round(bearing)}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l7 13H5z"/></svg></span>`,
        18,
      ),
    );
  }
  const step = kmStep(route.distance / 1000) * 1000;
  for (const { distance: at, point } of pointsAlong(route.coordinates, route.distance, step)) {
    decorations.push(marker(point, `<span class="km-marker">${Math.round(at / 1000)}</span>`, 24));
  }

  // Départ et arrivée : une seule étiquette quand ils se confondent (boucle, aller-retour).
  const [first, last] = [route.coordinates[0], route.coordinates.at(-1)];
  if (distance(first, last) < 80) decorations.push(endpointMarker(first, 'both').addTo(map));
  else decorations.push(endpointMarker(first, 'start').addTo(map), endpointMarker(last, 'end').addTo(map));
}

/** Point du parcours et altitude à une distance donnée (mètres, distance officielle). */
function routePointAt(route, at) {
  const cumulative = cumulativeDistances(route.coordinates);
  const scale = cumulative.at(-1) > 0 ? route.distance / cumulative.at(-1) : 1;
  const found = pointAtDistance(route.coordinates, at / scale, cumulative);
  let elevation = null;
  const profile = route.profile;
  if (profile.length > 1) {
    const i = Math.max(1, profile.findIndex((p) => p.distance >= at));
    const [p0, p1] = [profile[i - 1], profile[i] ?? profile[i - 1]];
    const t = p1.distance > p0.distance ? (at - p0.distance) / (p1.distance - p0.distance) : 0;
    elevation = p0.elevation + (p1.elevation - p0.elevation) * Math.min(1, Math.max(0, t));
  }
  return { point: found?.point, elevation };
}

function hideProfileCursor() {
  profileMarker?.remove();
  profileMarker = null;
  const cursor = document.querySelector('.chart-cursor');
  if (cursor) cursor.hidden = true;
}

/** Toucher ou survoler le profil : un curseur sur le graphique, le point correspondant sur la carte. */
export function bindProfileCursor(route) {
  const plot = document.querySelector('#details .chart-plot');
  if (!plot || route.profile.length < 2) return;
  const cursor = plot.querySelector('.chart-cursor');
  const tip = cursor.querySelector('.chart-tip');
  const total = route.profile.at(-1).distance;

  const move = (event) => {
    const rect = plot.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const at = ratio * total;
    const { point, elevation } = routePointAt(route, at);
    cursor.hidden = false;
    cursor.style.left = `${(ratio * 100).toFixed(2)}%`;
    cursor.classList.toggle('flip', ratio > 0.6);
    tip.textContent = `${formatDistance(at)} · ${formatElevation(elevation)} · ${formatGrade(gradeAt(route.profile, at))}`;
    if (!point) return;
    if (profileMarker) profileMarker.setLatLng(point);
    else {
      profileMarker = L.marker(point, {
        icon: L.divIcon({ className: '', html: '<span class="profile-marker"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 800,
      }).addTo(map);
    }
    revealPoint(point);
  };
  plot.addEventListener('pointerdown', (event) => {
    plot.setPointerCapture(event.pointerId);
    move(event);
  });
  plot.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || plot.hasPointerCapture(event.pointerId)) move(event);
  });
  plot.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hideProfileCursor();
  });
}
