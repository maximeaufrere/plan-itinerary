// Pendant le calcul : étapes dans le panneau et formes étudiées en pointillés sur la carte.
import { $ } from './dom.js';
import { map } from './map-view.js';

/* global L */

let outlineLayers = [];

export function clearOutlines() {
  for (const layer of outlineLayers) layer.remove();
  outlineLayers = [];
}

/** Formes étudiées, dessinées en pointillés pendant le tracé. */
export function drawOutlines(outlines) {
  clearOutlines();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--route').trim();
  outlineLayers = outlines.map((points) =>
    L.polyline(points, { color, weight: 3, opacity: 0.75, dashArray: '6 10', className: 'outline-draft', interactive: false }).addTo(map),
  );
}

export function setStep(id, stepState, text) {
  const item = $(id);
  item.dataset.state = stepState;
  if (text) item.querySelector('span').textContent = text;
}

/** Affiche ou masque l'écran de calcul (étapes + cartes en attente) à la place des critères et résultats. */
export function showProgress(isGenerating) {
  const button = $('quick-generate');
  button.classList.toggle('loading', isGenerating);
  button.setAttribute('aria-busy', String(isGenerating));
  $('cancel-generate').hidden = !isGenerating;
  $('locate').hidden = isGenerating;
  $('route-view').classList.toggle('generating', isGenerating);
  $('progress').hidden = !isGenerating;
  if (isGenerating) {
    setStep('step-relief', 'active', 'Analyse du relief autour du départ');
    setStep('step-trace', 'todo', 'Tracé par les chemins');
    setStep('step-rank', 'todo', 'Classement selon vos critères');
    $('quick-generate-label').textContent = 'Calcul…';
  } else {
    clearOutlines();
  }
}
