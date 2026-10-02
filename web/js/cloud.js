// Accès au compte en ligne (Supabase) : connexion, réglages, favoris, partages et sorties.
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';
import { randomId } from './sync.js';

/* global supabase */

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && globalThis.supabase?.createClient);

let client = null;

function db() {
  if (!cloudEnabled) throw new Error('Les comptes ne sont pas activés sur cette installation.');
  client ??= supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

/** Adresse de l'app, sans paramètres : destination des e-mails de confirmation et de réinitialisation. */
const appUrl = () => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;

const MESSAGES = [
  [/invalid login credentials/i, 'E-mail ou mot de passe incorrect.'],
  [/user already registered|already been registered/i, 'Un compte existe déjà avec cet e-mail. Connectez-vous plutôt.'],
  [/email not confirmed/i, 'Confirmez d\'abord votre adresse : cliquez sur le lien reçu par e-mail.'],
  [/password should be at least|password.*(short|length)/i, 'Le mot de passe doit contenir au moins 8 caractères.'],
  [/weak password|password is known to be weak/i, 'Ce mot de passe est trop facile à deviner. Choisissez-en un autre.'],
  [/rate limit|too many requests|security purposes/i, 'Trop de tentatives. Réessayez dans quelques minutes.'],
  [/unable to validate email|invalid email|email address .* invalid/i, 'Adresse e-mail invalide.'],
  [/same password|different from the old/i, 'Le nouveau mot de passe doit être différent de l\'ancien.'],
  [/failed to fetch|network/i, 'Connexion impossible. Vérifiez votre accès à Internet.'],
];

/** Erreur lisible en français. */
function friendly(error) {
  const message = error?.message ?? String(error);
  const match = MESSAGES.find(([pattern]) => pattern.test(message));
  return new Error(match ? match[1] : message);
}

async function run(promise) {
  let result;
  try {
    result = await promise;
  } catch (error) {
    throw friendly(error);
  }
  if (result.error) throw friendly(result.error);
  return result.data;
}

// MARK: - Connexion

export const auth = {
  onChange(callback) {
    db().auth.onAuthStateChange((event, session) => callback(event, session?.user ?? null));
  },
  async currentUser() {
    const data = await run(db().auth.getSession());
    return data.session?.user ?? null;
  },
  /** @returns {Promise<{ needsConfirmation: boolean }>} */
  async signUp(email, password) {
    const data = await run(db().auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } }));
    return { needsConfirmation: !data.session };
  },
  signIn: (email, password) => run(db().auth.signInWithPassword({ email, password })),
  signOut: () => run(db().auth.signOut()),
  sendPasswordReset: (email) => run(db().auth.resetPasswordForEmail(email, { redirectTo: appUrl() })),
  updatePassword: (password) => run(db().auth.updateUser({ password })),
  async deleteAccount() {
    await run(db().rpc('delete_my_account'));
    await db().auth.signOut({ scope: 'local' });
  },
};

// MARK: - Réglages

export async function fetchSettings(userId) {
  return run(db().from('user_settings').select('*').eq('user_id', userId).maybeSingle());
}

export async function saveSettings(userId, settings) {
  await run(db().from('user_settings').upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() }));
}

// MARK: - Favoris

const favoriteFromRow = (row) => ({ id: row.id, name: row.name, activity: row.activity, savedAt: row.saved_at, route: row.route });
const favoriteToRow = (f) => ({ id: f.id, name: f.name.slice(0, 120), activity: f.activity, saved_at: f.savedAt, route: f.route });

export async function fetchFavorites() {
  const rows = await run(db().from('favorites').select('id, name, activity, saved_at, route').order('saved_at', { ascending: false }));
  return rows.map(favoriteFromRow);
}

export async function upsertFavorites(favorites) {
  if (favorites.length) await run(db().from('favorites').upsert(favorites.map(favoriteToRow)));
}

export async function deleteFavorites(ids) {
  if (ids.length) await run(db().from('favorites').delete().in('id', ids));
}

// MARK: - Partage

/** Publie un parcours et renvoie son lien. */
export async function shareRoute({ name, activity, route }) {
  const id = randomId(12);
  await run(db().from('shared_routes').insert({ id, name: name.slice(0, 120), activity, route }));
  return `${appUrl()}?parcours=${id}`;
}

export async function fetchSharedRoute(id) {
  const rows = await run(db().rpc('get_shared_route', { route_id: id }));
  return rows?.[0] ?? null;
}

export async function fetchMyShares() {
  return run(db().from('shared_routes').select('id, name, activity, created_at').order('created_at', { ascending: false }));
}

export async function deleteShare(id) {
  await run(db().from('shared_routes').delete().eq('id', id));
}

export const shareUrl = (id) => `${appUrl()}?parcours=${id}`;

// MARK: - Sorties

export async function addOuting(outing) {
  await run(db().from('outings').insert(outing));
}

export async function fetchOutings() {
  return run(
    db()
      .from('outings')
      .select('id, name, activity, done_on, distance_m, ascent_m, duration_s, route')
      .order('done_on', { ascending: false })
      .order('created_at', { ascending: false }),
  );
}

export async function deleteOuting(id) {
  await run(db().from('outings').delete().eq('id', id));
}
