-- Plan Itinéraire : schéma Supabase (comptes, synchronisation, partage, historique).
-- À exécuter une fois dans le tableau de bord Supabase : SQL Editor ▸ New query ▸ coller ▸ Run.
-- Le script peut être relancé sans risque (il ne recrée que ce qui manque).

-- ---------------------------------------------------------------------------
-- Réglages de l'utilisateur (critères, clé OpenRouteService, thème, fond de carte)
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  criteria jsonb,
  ors_api_key text,
  theme text,
  base_layer text,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Réglages : lecture par leur propriétaire" on public.user_settings;
create policy "Réglages : lecture par leur propriétaire" on public.user_settings
  for select using (auth.uid() = user_id);
drop policy if exists "Réglages : écriture par leur propriétaire" on public.user_settings;
create policy "Réglages : écriture par leur propriétaire" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Favoris
-- ---------------------------------------------------------------------------
create table if not exists public.favorites (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  activity text not null,
  saved_at timestamptz not null default now(),
  route jsonb not null
);

create index if not exists favorites_user_id_idx on public.favorites (user_id);
alter table public.favorites enable row level security;

drop policy if exists "Favoris : accès par leur propriétaire" on public.favorites;
create policy "Favoris : accès par leur propriétaire" on public.favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Parcours partagés : lisibles par toute personne qui a le lien (identifiant aléatoire),
-- mais impossibles à lister : la lecture passe uniquement par la fonction get_shared_route.
-- ---------------------------------------------------------------------------
create table if not exists public.shared_routes (
  id text primary key check (id ~ '^[A-Za-z0-9]{10,32}$'),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  activity text not null,
  route jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists shared_routes_user_id_idx on public.shared_routes (user_id);
alter table public.shared_routes enable row level security;

drop policy if exists "Partages : gestion par leur auteur" on public.shared_routes;
create policy "Partages : gestion par leur auteur" on public.shared_routes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.get_shared_route(route_id text)
returns table (id text, name text, activity text, route jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.activity, s.route, s.created_at
  from public.shared_routes s
  where s.id = route_id;
$$;

revoke all on function public.get_shared_route(text) from public;
grant execute on function public.get_shared_route(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Historique des sorties réalisées
-- ---------------------------------------------------------------------------
create table if not exists public.outings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  activity text not null,
  done_on date not null default current_date,
  distance_m integer not null check (distance_m >= 0),
  ascent_m integer check (ascent_m >= 0),
  duration_s integer check (duration_s >= 0),
  route jsonb,
  created_at timestamptz not null default now()
);

create index if not exists outings_user_id_done_on_idx on public.outings (user_id, done_on desc);
alter table public.outings enable row level security;

drop policy if exists "Sorties : accès par leur propriétaire" on public.outings;
create policy "Sorties : accès par leur propriétaire" on public.outings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Suppression de son propre compte (et, en cascade, de toutes ses données)
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
