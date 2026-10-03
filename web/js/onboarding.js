// Mise en route : 1) point de départ (ma position ou non), 2) clé OpenRouteService.
import { testApiKey } from './settings.js';
import { KEYS, storage } from './storage.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} hooks
 * @param {() => void} hooks.onLocate      l'utilisateur accepte d'utiliser sa position
 * @param {() => void} hooks.onSkipLocate  il préfère choisir le départ lui-même
 * @param {() => void} hooks.onDone        fin de la mise en route
 */
export function initOnboarding(hooks) {
  const root = $('onboarding');
  let step = 1;

  const status = (text, kind = '') => {
    $('onboarding-status').textContent = text;
    $('onboarding-status').className = `key-status ${kind}`;
  };

  function show(nextStep, { message = '' } = {}) {
    step = nextStep;
    root.hidden = false;
    document.body.classList.add('onboarding-open');
    for (const section of root.querySelectorAll('[data-step]')) section.hidden = Number(section.dataset.step) !== step;
    for (const dot of root.querySelectorAll('[data-dot]')) dot.classList.toggle('on', Number(dot.dataset.dot) === step);
    $('onboarding-step-label').textContent = `Étape ${step} sur 2`;
    $('onboarding-message').hidden = !message;
    $('onboarding-message').textContent = message;
    if (step === 2) {
      $('onboarding-key').value = storage.get(KEYS.apiKey, '');
      status('');
    }
    root.querySelector(`[data-step="${step}"] h1`).focus?.({ preventScroll: true });
  }

  function finish() {
    storage.set(KEYS.welcomeDismissed, true);
    root.hidden = true;
    document.body.classList.remove('onboarding-open');
    hooks.onDone?.();
  }

  const afterLocation = () => (storage.get(KEYS.apiKey, '') ? finish() : show(2));

  $('onboarding-locate').addEventListener('click', () => {
    hooks.onLocate();
    afterLocation();
  });
  $('onboarding-skip-locate').addEventListener('click', () => {
    hooks.onSkipLocate();
    afterLocation();
  });

  $('onboarding-test').addEventListener('click', async (event) => {
    const apiKey = $('onboarding-key').value.trim();
    if (!apiKey) return status('Collez d\'abord votre clé.', 'error');
    const button = event.currentTarget;
    button.disabled = true;
    status('Test en cours…');
    const result = await testApiKey(apiKey);
    button.disabled = false;
    status(result.message, result.kind);
    if (result.ok) {
      storage.set(KEYS.apiKey, apiKey);
      setTimeout(finish, 600);
    }
  });
  $('onboarding-later').addEventListener('click', finish);

  return {
    /** Première visite : la mise en route n'a pas encore été faite. */
    get needed() {
      return !storage.get(KEYS.welcomeDismissed, false);
    },
    start: () => show(1),
    /** Demande la clé (par exemple au premier « Générer » sans clé). */
    askKey: (message) => show(2, { message }),
  };
}
