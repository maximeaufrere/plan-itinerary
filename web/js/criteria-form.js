// Critères du parcours : activité, forme, distance, et l'écran « Plus de critères ».
import { ACTIVITIES, ELEVATION_PREFERENCES, SHAPES, SURFACES, sanitizeCriteria } from './criteria.js';
import { $, escapeHtml } from './dom.js';
import { formatElevation } from './format.js';
import { activityIcons } from './icons.js';
import { getSheetState, snapTo } from './sheet.js';
import { isPointToPoint, state } from './state.js';
import { KEYS, storage } from './storage.js';

/** Libellés courts des contrôles segmentés. */
const ELEVATION_SHORT = { any: 'Libre', flat: 'Plat', rolling: 'Vallonné', hilly: 'Montagne' };
const SURFACE_SHORT = { any: 'Libre', paved: 'Bitume', unpaved: 'Chemins' };
const ACTIVITY_SHORT = { road: 'Route', bike: 'Balade' };
const GAIN_STEP = 50;

const hooks = { onChange: () => {}, onSync: () => {}, setStatus: () => {}, openPace: () => {}, onSearchChange: () => {} };

/** Dernière limite de D+ choisie, reprise quand on réactive la limite. */
let lastMaxGain = state.criteria.maxGain ?? 200;

const segments = (name, entries) =>
  entries.map(([value, label]) => `<label><input type="radio" name="${name}" value="${value}"><span>${label}</span></label>`).join('');

function buildForm() {
  $('activity').innerHTML = Object.entries(ACTIVITIES)
    .map(
      ([key, activity]) => `
      <label class="activity-option">
        <input type="radio" name="activity" value="${key}" aria-label="${activity.label}">
        <span>${activityIcons[key]}${ACTIVITY_SHORT[key] ?? activity.label}</span>
      </label>`,
    )
    .join('');
  $('shape').innerHTML = segments('shape', Object.entries(SHAPES));
  $('elevation').innerHTML = segments('elevation', Object.keys(ELEVATION_PREFERENCES).map((key) => [key, ELEVATION_SHORT[key]]));
  $('surface').innerHTML = segments('surface', Object.keys(SURFACES).map((key) => [key, SURFACE_SHORT[key]]));
}

/** Partie remplie des curseurs (le navigateur ne la colore pas partout de la même façon). */
function fillRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${(ratio * 100).toFixed(1)}%`);
}

/** Critères avancés qui s'écartent des valeurs par défaut, en pastilles courtes. */
function advancedTags() {
  const { criteria } = state;
  const tags = [];
  if (criteria.elevation !== 'any') tags.push(ELEVATION_PREFERENCES[criteria.elevation].label);
  if (criteria.maxGain != null) tags.push(`D+ ≤ ${formatElevation(criteria.maxGain)}`);
  if (criteria.surface !== 'any') tags.push(SURFACES[criteria.surface]);
  if (criteria.avoidMajorRoads) tags.push('Sans grands axes');
  if (!criteria.preferNew) tags.push('Chemins connus acceptés');
  if (criteria.proposals !== 3) tags.push(`${criteria.proposals} proposition${criteria.proposals > 1 ? 's' : ''}`);
  return tags;
}

/** Résumé d'une ligne des critères (« Course · Boucle · 10 km »). */
export function criteriaSummary() {
  const { criteria } = state;
  return [ACTIVITIES[criteria.activity].label, SHAPES[criteria.shape], `${criteria.distanceKm} km`, ...advancedTags()].join(' · ');
}

/** Met le formulaire en accord avec les critères enregistrés. */
export function syncForm() {
  const { criteria } = state;
  const activity = ACTIVITIES[criteria.activity];
  document.querySelector(`input[name="activity"][value="${criteria.activity}"]`).checked = true;
  document.querySelector(`input[name="shape"][value="${criteria.shape}"]`).checked = true;
  $('placing-field').hidden = !isPointToPoint();
  $('end-field').hidden = !isPointToPoint();

  const distance = $('distance');
  [distance.min, distance.max] = activity.range;
  distance.value = criteria.distanceKm;
  $('distance-output').textContent = `${criteria.distanceKm} km`;
  fillRange(distance);

  document.querySelector(`input[name="elevation"][value="${criteria.elevation}"]`).checked = true;
  document.querySelector(`input[name="surface"][value="${criteria.surface}"]`).checked = true;
  $('avoid-major-roads').checked = criteria.avoidMajorRoads;
  $('prefer-new').checked = criteria.preferNew;
  $('proposals').textContent = String(criteria.proposals);
  $('proposals-minus').disabled = criteria.proposals <= 1;
  $('proposals-plus').disabled = criteria.proposals >= 5;
  const limited = criteria.maxGain != null;
  $('limit-gain').checked = limited;
  $('max-gain-row').classList.toggle('disabled', !limited);
  $('max-gain').textContent = formatElevation(criteria.maxGain ?? lastMaxGain);
  $('gain-minus').disabled = !limited || criteria.maxGain <= GAIN_STEP;
  $('gain-plus').disabled = !limited;

  const tags = advancedTags();
  $('more-summary').innerHTML = tags.length
    ? tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')
    : '<span class="muted">Dénivelé, revêtement, options</span>';
  $('criteria-summary-text').textContent = criteriaSummary();
  hooks.onSync();
}

/** Écran « Plus de critères » (dans la même feuille). */
function setMoreOpen(open) {
  $('criteria-more').hidden = !open;
  $('criteria-main').hidden = open;
  $('open-more').setAttribute('aria-expanded', String(open));
  $('panel-scroll').scrollTo({ top: 0 });
}

/** Écran « Nouvelle recherche » : critères ouverts alors que des propositions existent (mises de côté). */
let searching = false;
export const isSearching = () => searching;

/** Après un calcul, les critères se replient pour laisser la place aux propositions. */
export function setCriteriaCollapsed(collapsed) {
  $('criteria-form').classList.toggle('collapsed', collapsed);
  if (collapsed) setMoreOpen(false);
  $('criteria-summary-text').textContent = criteriaSummary();
  const nowSearching = !collapsed && state.routes.length > 0;
  $('route-view').classList.toggle('searching', nowSearching);
  $('new-search-header').hidden = !nowSearching;
  if (nowSearching) {
    const count = state.routes.length;
    $('new-search-hint').textContent =
      count > 1 ? `Vos ${count} propositions actuelles restent accessibles avec la flèche.` : 'Le parcours affiché reste accessible avec la flèche.';
  }
  if (nowSearching !== searching) {
    searching = nowSearching;
    hooks.onSearchChange(searching);
  }
  hooks.onSync();
}

/** Change des critères, les enregistre et met le formulaire à jour. */
export function updateCriteria(changes) {
  state.criteria = sanitizeCriteria({ ...state.criteria, ...changes });
  if (state.criteria.maxGain != null) lastMaxGain = state.criteria.maxGain;
  storage.set(KEYS.criteria, state.criteria);
  hooks.onChange(changes);
  syncForm();
}

/** Remplace tous les critères (réglages par défaut, critères venus du compte). */
export function replaceCriteria(criteria, { silent = false } = {}) {
  state.criteria = sanitizeCriteria(criteria);
  storage.set(KEYS.criteria, state.criteria, { silent });
  syncForm();
}

/** Place l'arrivée au prochain toucher sur la carte. */
export const placeEndNext = () => {
  document.querySelector('input[name="placing"][value="end"]').checked = true;
};
/** Point que le prochain toucher sur la carte va placer : « start » ou « end ». */
export const placing = () => document.querySelector('input[name="placing"]:checked').value;

/**
 * @param {object} options
 * @param {(changes: object) => void} options.onChange  les critères ont changé
 * @param {() => void} options.onSync  le résumé des critères a changé
 * @param {(message: string, isError?: boolean) => void} options.setStatus
 * @param {() => void} options.openPace  ouvre le réglage de l'allure
 * @param {(searching: boolean) => void} options.onSearchChange  entrée ou sortie de « Nouvelle recherche »
 */
export function initCriteriaForm(options) {
  Object.assign(hooks, options);
  buildForm();

  $('edit-criteria').addEventListener('click', () => {
    setCriteriaCollapsed(false);
    if (getSheetState() === 'peek') snapTo('mid');
    $('panel-scroll').scrollTo({ top: 0 });
  });
  $('back-to-results').addEventListener('click', () => {
    setCriteriaCollapsed(true);
    $('panel-scroll').scrollTo({ top: 0 });
  });
  $('open-more').addEventListener('click', () => setMoreOpen(true));
  $('close-more').addEventListener('click', () => setMoreOpen(false));
  $('reset-more').addEventListener('click', () => {
    const defaults = sanitizeCriteria({});
    updateCriteria({
      elevation: defaults.elevation,
      maxGain: defaults.maxGain,
      surface: defaults.surface,
      avoidMajorRoads: defaults.avoidMajorRoads,
      preferNew: defaults.preferNew,
      proposals: defaults.proposals,
    });
  });
  $('goto-pace').addEventListener('click', () => hooks.openPace());

  $('activity').addEventListener('change', (event) => {
    const activity = event.target.value;
    updateCriteria({ activity, distanceKm: ACTIVITIES[activity].defaultKm });
  });
  $('shape').addEventListener('change', (event) => {
    updateCriteria({ shape: event.target.value });
    if (isPointToPoint() && state.start && !state.end) {
      placeEndNext();
      hooks.setStatus('Touchez la carte pour placer l\'arrivée.');
    }
  });
  $('distance').addEventListener('input', (event) => updateCriteria({ distanceKm: Number(event.target.value) }));
  $('elevation').addEventListener('change', (event) => updateCriteria({ elevation: event.target.value }));
  $('surface').addEventListener('change', (event) => updateCriteria({ surface: event.target.value }));
  $('avoid-major-roads').addEventListener('change', (event) => updateCriteria({ avoidMajorRoads: event.target.checked }));
  $('prefer-new').addEventListener('change', (event) => updateCriteria({ preferNew: event.target.checked }));
  $('proposals-minus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals - 1 }));
  $('proposals-plus').addEventListener('click', () => updateCriteria({ proposals: state.criteria.proposals + 1 }));
  $('limit-gain').addEventListener('change', (event) => updateCriteria({ maxGain: event.target.checked ? lastMaxGain : null }));
  $('gain-minus').addEventListener('click', () => updateCriteria({ maxGain: Math.max(GAIN_STEP, state.criteria.maxGain - GAIN_STEP) }));
  $('gain-plus').addEventListener('click', () => updateCriteria({ maxGain: state.criteria.maxGain + GAIN_STEP }));
}
