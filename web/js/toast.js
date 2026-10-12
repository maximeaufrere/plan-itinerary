// Bulle d'erreur juste au-dessus du bouton « Générer ».
import { $ } from './dom.js';

let timer = null;

export function hideToast() {
  clearTimeout(timer);
  $('toast').hidden = true;
}

export function showToast(message) {
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(timer);
  timer = setTimeout(hideToast, 10_000);
}

$('toast-close').addEventListener('click', hideToast);
