// Petits outils partagés pour manipuler la page.

export const $ = (id) => document.getElementById(id);

const ENTITIES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };

/** Texte sûr à insérer dans du HTML (noms de parcours, adresses, messages d'erreur…). */
export const escapeHtml = (text) => String(text).replace(/[<>&"']/g, (c) => ENTITIES[c]);
