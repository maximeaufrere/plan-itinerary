// Champ d'adresse avec suggestions (combobox accessible) : départ et arrivée.
import { autocomplete } from './geocode.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const PIN = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const ARROW = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3L3 10.5l7.5 3 3 7.5z"/></svg>';

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

/**
 * @param {object} options
 * @param {'start' | 'end'} options.kind
 * @param {() => string} options.getApiKey
 * @param {() => [number, number] | null} options.getFocus  point autour duquel privilégier les résultats
 * @param {(item: { label: string, point: [number, number] }) => void} options.onSelect
 * @param {() => void} [options.onClear]
 * @param {Array<{ label: string, action: () => void }>} [options.shortcuts]  options affichées avant la saisie
 */
export function initAddressField({ kind, getApiKey, getFocus, onSelect, onClear, shortcuts = [] }) {
  const input = $(`${kind}-address`);
  const list = $(`${kind}-suggestions`);
  const clear = document.querySelector(`[data-clear="${kind}"]`);
  let items = [];
  let active = -1;
  let timer = null;
  let controller = null;
  /** Vrai quand le texte du champ a été tapé par l'utilisateur (et non affiché par l'app). */
  let typed = false;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function render() {
    list.innerHTML = items
      .map((item, i) => {
        const classes = ['suggestion', item.action ? 'shortcut' : '', item.disabled ? 'disabled' : ''].join(' ');
        return `<li id="${kind}-option-${i}" role="option" class="${classes}" data-index="${i}" aria-selected="${i === active}" ${item.disabled ? 'aria-disabled="true"' : ''}>
          ${item.disabled ? '' : item.action ? ARROW : PIN}<span>${escapeHtml(item.label)}</span></li>`;
      })
      .join('');
    list.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${kind}-option-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  async function search() {
    const text = input.value.trim();
    controller?.abort();
    if (!typed || text.length < MIN_CHARS) {
      items = shortcuts;
      active = -1;
      render();
      return;
    }
    const apiKey = getApiKey();
    if (!apiKey) {
      items = [{ label: 'Ajoutez votre clé OpenRouteService dans les réglages pour chercher une adresse.', disabled: true }];
      render();
      return;
    }
    controller = new AbortController();
    try {
      const results = await autocomplete({ apiKey, text, focus: getFocus(), signal: controller.signal });
      items = results.length ? results : [{ label: 'Aucune adresse trouvée. Essayez avec la ville.', disabled: true }];
    } catch (error) {
      if (error.name === 'AbortError') return;
      items = [{ label: error.message, disabled: true }];
    }
    active = -1;
    render();
  }

  function choose(index) {
    const item = items[index];
    if (!item || item.disabled) return;
    close();
    if (item.action) {
      input.blur();
      item.action();
      return;
    }
    input.value = item.label;
    typed = false;
    clear.hidden = false;
    input.blur();
    onSelect(item);
  }

  function move(step) {
    const selectable = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!selectable.length) return;
    const position = selectable.indexOf(active);
    active = selectable[(position + step + selectable.length) % selectable.length];
    render();
  }

  input.addEventListener('input', () => {
    typed = true;
    clear.hidden = !input.value;
    clearTimeout(timer);
    controller?.abort();
    // Les anciennes suggestions disparaissent tout de suite pour ne pas être choisies par erreur.
    items = input.value.trim().length >= MIN_CHARS ? [{ label: 'Recherche…', disabled: true }] : shortcuts;
    active = -1;
    render();
    timer = setTimeout(search, DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => {
    input.select();
    search();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      // Entrée choisit la suggestion en surbrillance (ou la première), sans lancer la génération.
      event.preventDefault();
      choose(active >= 0 ? active : items.findIndex((item) => !item.disabled && !item.action));
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  // Garder le focus dans le champ pendant le toucher d'une suggestion.
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (option) choose(Number(option.dataset.index));
  });
  clear.addEventListener('click', () => {
    input.value = '';
    typed = false;
    clear.hidden = true;
    onClear?.();
    input.focus();
  });

  return {
    /** Affiche l'adresse d'un point choisi autrement (carte, localisation), sauf pendant la saisie. */
    setLabel(label) {
      if (document.activeElement === input) return;
      input.value = label ?? '';
      typed = false;
      clear.hidden = !input.value;
    },
  };
}
