// Comptes utilisateurs : connexion, synchronisation, partage de parcours et historique des sorties.
import * as cloud from './cloud.js';
import { ACTIVITIES } from './criteria.js';
import { fromFavorite, toFavorite } from './favorites.js';
import { formatDistance, formatDuration, formatElevation } from './format.js';
import { icons } from './icons.js';
import { KEYS, storage } from './storage.js';
import { diffFavorites, filterOutings, mergeFavoriteLists, newerSettings, outingStats } from './sync.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const SETTINGS_KEYS = [KEYS.criteria, KEYS.apiKey, KEYS.theme, KEYS.baseLayer];
const MIN_PASSWORD_LENGTH = 8;
const today = () => new Date().toISOString().slice(0, 10);
const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (iso) => dateFormat.format(new Date(`${String(iso).slice(0, 10)}T12:00:00`));

/**
 * @param {object} hooks
 * @param {() => object[]} hooks.getFavorites
 * @param {(favorites: object[]) => void} hooks.setFavorites  remplace les favoris affichés (sans renvoyer au compte)
 * @param {(row: object) => void} hooks.applySettings  applique des réglages venus du compte
 * @param {(route: object, activity: string) => void} hooks.openRoute
 * @param {(message: string, isError?: boolean) => void} hooks.setStatus
 */
export function initAccount(hooks) {
  const dialog = $('account');
  let user = null;
  let lastFavorites = hooks.getFavorites();
  let pushTimer = null;
  let period = '30';
  let outings = [];

  // MARK: Affichage du panneau

  const show = (section) => {
    for (const id of ['account-disabled', 'account-signed-out', 'account-recovery', 'account-signed-in']) {
      $(id).hidden = id !== section;
    }
  };

  const message = (text = '') => {
    $('account-message').hidden = !text;
    $('account-message').textContent = text;
  };

  const status = (id, text, kind = '') => {
    $(id).textContent = text;
    $(id).className = `key-status ${kind}`;
  };

  function render() {
    if (!cloud.cloudEnabled) return show('account-disabled');
    if (!user) return show('account-signed-out');
    show('account-signed-in');
    $('account-email').textContent = user.email;
    $('account-avatar').textContent = (user.email ?? '?').slice(0, 1).toUpperCase();
    refreshOutings();
    refreshShares();
  }

  function open(text) {
    message(text);
    render();
    if (!dialog.open) dialog.showModal();
    if (!user && cloud.cloudEnabled) $('auth-email').focus();
  }

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
  $('open-account').addEventListener('click', () => open());

  // MARK: Connexion et création de compte

  const mode = () => document.querySelector('input[name="auth-mode"]:checked').value;

  function syncAuthMode() {
    const signUp = mode() === 'signup';
    $('auth-confirm-field').hidden = !signUp;
    $('auth-password').autocomplete = signUp ? 'new-password' : 'current-password';
    $('auth-submit-label').textContent = signUp ? 'Créer mon compte' : 'Se connecter';
    $('forgot-password').hidden = signUp;
    status('auth-status', '');
  }
  $('auth-mode').addEventListener('change', syncAuthMode);

  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const signUp = mode() === 'signup';
    if (signUp && password.length < MIN_PASSWORD_LENGTH) {
      return status('auth-status', `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`, 'error');
    }
    if (signUp && password !== $('auth-confirm').value) {
      return status('auth-status', 'Les deux mots de passe ne correspondent pas.', 'error');
    }
    const button = $('auth-submit');
    button.disabled = true;
    status('auth-status', signUp ? 'Création du compte…' : 'Connexion…');
    try {
      if (signUp) {
        const { needsConfirmation } = await cloud.auth.signUp(email, password);
        if (needsConfirmation) {
          status('auth-status', `Compte créé ! Un e-mail de confirmation a été envoyé à ${email} : cliquez sur le lien qu'il contient pour activer le compte.`, 'ok');
        }
      } else {
        await cloud.auth.signIn(email, password);
      }
      $('auth-password').value = '';
      $('auth-confirm').value = '';
    } catch (error) {
      status('auth-status', error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('forgot-password').addEventListener('click', async () => {
    const email = $('auth-email').value.trim();
    if (!email) return status('auth-status', 'Saisissez d\'abord votre e-mail, puis touchez « Mot de passe oublié ? ».', 'error');
    try {
      await cloud.auth.sendPasswordReset(email);
      status('auth-status', `Si un compte existe pour ${email}, un lien pour choisir un nouveau mot de passe vient d'être envoyé.`, 'ok');
    } catch (error) {
      status('auth-status', error.message, 'error');
    }
  });

  // Retour depuis l'e-mail de réinitialisation : choix du nouveau mot de passe.
  $('recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('recovery-password').value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      return status('recovery-status', `Au moins ${MIN_PASSWORD_LENGTH} caractères.`, 'error');
    }
    if (password !== $('recovery-confirm').value) return status('recovery-status', 'Les deux mots de passe ne correspondent pas.', 'error');
    try {
      await cloud.auth.updatePassword(password);
      $('recovery-form').reset();
      render();
      message('Mot de passe modifié. Vous êtes connecté.');
    } catch (error) {
      status('recovery-status', error.message, 'error');
    }
  });

  // MARK: Compte connecté

  $('change-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('new-password').value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      return status('password-status', `Au moins ${MIN_PASSWORD_LENGTH} caractères.`, 'error');
    }
    try {
      await cloud.auth.updatePassword(password);
      $('new-password').value = '';
      status('password-status', 'Mot de passe modifié.', 'ok');
    } catch (error) {
      status('password-status', error.message, 'error');
    }
  });

  $('sign-out').addEventListener('click', async () => {
    try {
      await cloud.auth.signOut();
    } catch (error) {
      status('account-status', error.message, 'error');
    }
  });

  $('delete-account').addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Supprimer définitivement votre compte ainsi que vos favoris, sorties et parcours partagés en ligne ? Cette action est irréversible.',
    );
    if (!confirmed) return;
    try {
      await cloud.auth.deleteAccount();
      storage.clearAll();
      window.location.reload();
    } catch (error) {
      status('account-status', error.message, 'error');
    }
  });

  // MARK: Synchronisation

  const syncStatus = (text, kind = '') => status('sync-status', text, kind);

  const localSettings = () => ({
    criteria: storage.get(KEYS.criteria, null),
    ors_api_key: storage.get(KEYS.apiKey, '') || null,
    theme: storage.get(KEYS.theme, null),
    base_layer: storage.get(KEYS.baseLayer, null),
  });

  async function pushSettings() {
    if (!user) return;
    try {
      await cloud.saveSettings(user.id, localSettings());
      syncStatus(`Synchronisé à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    } catch (error) {
      syncStatus(`Synchronisation impossible : ${error.message}`, 'error');
    }
  }

  async function fullSync() {
    syncStatus('Synchronisation…');
    try {
      const remoteSettings = await cloud.fetchSettings(user.id);
      const decision = newerSettings(storage.get(KEYS.settingsUpdatedAt, null), remoteSettings);
      if (decision === 'remote') {
        hooks.applySettings(remoteSettings);
        storage.set(KEYS.settingsUpdatedAt, remoteSettings.updated_at, { silent: true });
      } else if (decision === 'local') {
        await cloud.saveSettings(user.id, localSettings());
      }

      const { favorites, toUpload } = mergeFavoriteLists(
        hooks.getFavorites(),
        await cloud.fetchFavorites(),
        storage.get(KEYS.syncedFavoriteIds, []),
      );
      await cloud.upsertFavorites(toUpload);
      lastFavorites = favorites;
      hooks.setFavorites(favorites);
      storage.set(KEYS.syncedFavoriteIds, favorites.map((f) => f.id), { silent: true });
      syncStatus(`Synchronisé à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    } catch (error) {
      syncStatus(`Synchronisation impossible : ${error.message}`, 'error');
    }
  }

  storage.onChange(async (key, value) => {
    if (SETTINGS_KEYS.includes(key)) {
      storage.set(KEYS.settingsUpdatedAt, new Date().toISOString(), { silent: true });
      if (user) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(pushSettings, 1500);
      }
    }
    if (key === KEYS.favorites) {
      const { added, removed } = diffFavorites(lastFavorites, value);
      lastFavorites = value;
      if (!user || (!added.length && !removed.length)) return;
      try {
        await cloud.upsertFavorites(added);
        await cloud.deleteFavorites(removed);
        storage.set(KEYS.syncedFavoriteIds, value.map((f) => f.id), { silent: true });
        syncStatus(`Synchronisé à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
      } catch (error) {
        hooks.setStatus(`Favori non synchronisé : ${error.message}`, true);
      }
    }
  });

  // MARK: Sorties

  async function refreshOutings() {
    try {
      outings = await cloud.fetchOutings();
      renderOutings();
    } catch (error) {
      $('outings-list').innerHTML = `<li class="list-empty">${escapeHtml(error.message)}</li>`;
    }
  }

  function renderOutings() {
    const shown = filterOutings(outings, period);
    const stats = outingStats(shown);
    $('outing-stats').innerHTML = [
      ['Sorties', String(stats.count)],
      ['Distance', formatDistance(stats.distance)],
      ['D+', formatElevation(stats.ascent)],
      ['Temps', stats.duration ? formatDuration(stats.duration) : '–'],
    ]
      .map(([label, value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`)
      .join('');
    $('outings-list').innerHTML = shown.length
      ? shown
          .map(
            (o) => `
        <li>
          <button type="button" class="item-main" data-open-outing="${o.id}" ${o.route ? '' : 'disabled'}>
            <strong>${escapeHtml(o.name)}</strong>
            <small>${formatDate(o.done_on)} · ${ACTIVITIES[o.activity]?.label ?? ''} · ${formatDistance(o.distance_m)} · ↗ ${formatElevation(o.ascent_m)}${o.duration_s ? ` · ${formatDuration(o.duration_s)}` : ''}</small>
          </button>
          <button type="button" class="item-action" data-delete-outing="${o.id}" aria-label="Supprimer la sortie ${escapeHtml(o.name)}">${icons.trash}</button>
        </li>`,
          )
          .join('')
      : '<li class="list-empty">Aucune sortie sur cette période. Utilisez « Réalisé » sous un itinéraire.</li>';
  }

  $('outing-period').addEventListener('change', (event) => {
    period = event.target.value;
    renderOutings();
  });

  $('outings-list').addEventListener('click', async (event) => {
    const openId = event.target.closest('[data-open-outing]')?.dataset.openOuting;
    const deleteId = event.target.closest('[data-delete-outing]')?.dataset.deleteOuting;
    if (openId) {
      const outing = outings.find((o) => o.id === openId);
      if (!outing?.route) return;
      dialog.close();
      hooks.openRoute({ ...fromFavorite({ id: `outing-${outing.id}`, route: outing.route }), name: outing.name }, outing.activity);
    } else if (deleteId) {
      const outing = outings.find((o) => o.id === deleteId);
      if (!outing || !window.confirm(`Supprimer la sortie « ${outing.name} » ?`)) return;
      try {
        await cloud.deleteOuting(deleteId);
        outings = outings.filter((o) => o.id !== deleteId);
        renderOutings();
      } catch (error) {
        status('account-status', error.message, 'error');
      }
    }
  });

  // Fenêtre « J'ai fait ce parcours »
  const outingDialog = $('outing-dialog');
  let pendingOuting = null;

  function logOuting(route, { activity, name, duration }) {
    if (!requireUser('Connectez-vous pour enregistrer vos sorties et suivre vos statistiques.')) return;
    pendingOuting = { route, activity };
    $('outing-name').value = name;
    $('outing-date').value = today();
    $('outing-date').max = today();
    const minutes = Math.round(duration / 60);
    $('outing-hours').value = Math.floor(minutes / 60);
    $('outing-minutes').value = minutes % 60;
    status('outing-status', '');
    outingDialog.showModal();
  }

  $('outing-cancel').addEventListener('click', () => outingDialog.close());
  $('outing-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { route, activity } = pendingOuting;
    const duration = (Number($('outing-hours').value) || 0) * 3600 + (Number($('outing-minutes').value) || 0) * 60;
    try {
      await cloud.addOuting({
        name: $('outing-name').value.trim().slice(0, 120) || 'Sortie',
        activity,
        done_on: $('outing-date').value || today(),
        distance_m: Math.round(route.distance),
        ascent_m: route.ascent == null ? null : Math.round(route.ascent),
        duration_s: duration || null,
        route: toFavorite(route, { name: 'sortie', activity }).route,
      });
      outingDialog.close();
      hooks.setStatus('Sortie ajoutée à votre historique (Mon compte ▸ Mes sorties).');
    } catch (error) {
      status('outing-status', error.message, 'error');
    }
  });

  // MARK: Partages

  async function refreshShares() {
    try {
      const shares = await cloud.fetchMyShares();
      $('shares-list').innerHTML = shares.length
        ? shares
            .map(
              (s) => `
          <li>
            <button type="button" class="item-main" data-copy-share="${s.id}">
              <strong>${escapeHtml(s.name)}</strong>
              <small>${formatDate(s.created_at)} · ${ACTIVITIES[s.activity]?.label ?? ''} · Toucher pour copier le lien</small>
            </button>
            <button type="button" class="item-action" data-delete-share="${s.id}" aria-label="Arrêter de partager ${escapeHtml(s.name)}">${icons.trash}</button>
          </li>`,
            )
            .join('')
        : '<li class="list-empty">Aucun parcours partagé. Utilisez « Partager » sous un itinéraire.</li>';
    } catch (error) {
      $('shares-list').innerHTML = `<li class="list-empty">${escapeHtml(error.message)}</li>`;
    }
  }

  $('shares-list').addEventListener('click', async (event) => {
    const copyId = event.target.closest('[data-copy-share]')?.dataset.copyShare;
    const deleteId = event.target.closest('[data-delete-share]')?.dataset.deleteShare;
    if (copyId) {
      await copyLink(cloud.shareUrl(copyId));
      status('account-status', 'Lien copié.', 'ok');
    } else if (deleteId) {
      if (!window.confirm('Arrêter de partager ce parcours ? Le lien ne fonctionnera plus.')) return;
      try {
        await cloud.deleteShare(deleteId);
        refreshShares();
      } catch (error) {
        status('account-status', error.message, 'error');
      }
    }
  });

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      window.prompt('Copiez ce lien :', url);
      return false;
    }
  }

  async function shareRoute(route, { activity, name }) {
    if (!requireUser('Connectez-vous pour partager vos parcours par lien.')) return;
    const title = window.prompt('Nom du parcours partagé', name);
    if (title === null) return;
    try {
      hooks.setStatus('Création du lien de partage…');
      const url = await cloud.shareRoute({
        name: title.trim() || name,
        activity,
        route: toFavorite(route, { name: title, activity }).route,
      });
      if (navigator.share) {
        try {
          await navigator.share({ title: title || name, text: `Parcours ${ACTIVITIES[activity]?.label.toLowerCase() ?? ''} : ${title || name}`, url });
          hooks.setStatus('');
          return;
        } catch (error) {
          if (error.name === 'AbortError') return hooks.setStatus('');
        }
      }
      await copyLink(url);
      hooks.setStatus(`Lien copié : ${url}`);
    } catch (error) {
      hooks.setStatus(`Partage impossible : ${error.message}`, true);
    }
  }

  /** Ouvre un parcours partagé reçu par lien (?parcours=…). */
  async function openSharedLink() {
    const id = new URLSearchParams(location.search).get('parcours');
    if (!id) return;
    history.replaceState(null, '', location.pathname);
    if (!cloud.cloudEnabled) return hooks.setStatus('Ce lien de partage ne peut pas être ouvert : les comptes ne sont pas activés.', true);
    try {
      hooks.setStatus('Ouverture du parcours partagé…');
      const shared = await cloud.fetchSharedRoute(id);
      if (!shared) return hooks.setStatus('Ce parcours partagé n\'existe plus.', true);
      hooks.openRoute({ ...fromFavorite({ id: `shared-${shared.id}`, route: shared.route }), name: shared.name }, shared.activity);
      hooks.setStatus(`Parcours partagé : « ${shared.name} ». Enregistrez-le dans vos favoris pour le garder.`);
    } catch (error) {
      hooks.setStatus(`Impossible d'ouvrir le parcours partagé : ${error.message}`, true);
    }
  }

  // MARK: Démarrage

  function requireUser(text) {
    if (user) return true;
    open(text);
    return false;
  }

  if (cloud.cloudEnabled) {
    cloud.auth.onChange((event, sessionUser) => {
      if (event === 'PASSWORD_RECOVERY') {
        user = sessionUser;
        message('Choisissez votre nouveau mot de passe.');
        show('account-recovery');
        if (!dialog.open) dialog.showModal();
        return;
      }
      const wasSignedIn = Boolean(user);
      user = sessionUser;
      $('open-account').classList.toggle('signed-in', Boolean(user));
      if (user && (!wasSignedIn || event === 'SIGNED_IN')) {
        fullSync();
        if (dialog.open && event === 'SIGNED_IN') message('Vous êtes connecté. Vos favoris et réglages sont synchronisés.');
      }
      if (!user && wasSignedIn) message('Vous êtes déconnecté. Vos données restent sur cet appareil.');
      if (dialog.open) render();
    });
  }
  syncAuthMode();
  openSharedLink();

  /** Onglet « Sorties » : historique si connecté, sinon invitation à se connecter. */
  function openOutings() {
    if (cloud.cloudEnabled && !user) return open('Connectez-vous pour retrouver l\'historique de vos sorties et vos statistiques.');
    open();
    if (user) $('outings-title').scrollIntoView({ block: 'start' });
  }

  return {
    open,
    openOutings,
    shareRoute,
    logOuting,
    get signedIn() {
      return Boolean(user);
    },
  };
}
