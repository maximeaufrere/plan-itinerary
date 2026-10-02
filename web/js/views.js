// Vues du panneau : Parcours, Favoris, Compte (et Sorties), Réglages.
// Une seule vue est affichée à la fois dans la feuille, sous la barre d'onglets.

const listeners = [];
let current = 'route';

/** Appelé à chaque changement de vue (la feuille s'ouvre si elle était réduite, etc.). */
export function onViewChange(listener) {
  listeners.push(listener);
}

export const currentView = () => current;

/**
 * Affiche une vue du panneau.
 * @param {string} name  « route », « favorites », « account » ou « settings »
 * @param {{ tab?: string }} [options]  onglet à mettre en avant (par défaut, celui de la vue)
 */
export function showView(name, { tab = name } = {}) {
  current = name;
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const listener of listeners) listener(name);
}
