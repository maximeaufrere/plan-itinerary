# Plan Itinéraire

Génère des itinéraires de **course à pied** ou de **vélo** à partir de critères : distance, type de parcours
(boucle / aller-retour), profil de dénivelé, D+ maximal.

App web multiplateforme (iPhone, Android, ordinateur), basée sur OpenStreetMap et OpenRouteService, installable sur
l'écran d'accueil. Aucun compte développeur ni Mac nécessaire. Le code est dans `web/`.

HTML/CSS/JavaScript sans étape de compilation ; la carte utilise [Leaflet](https://leafletjs.com) (copié dans
`web/vendor/`), les fonds de carte OpenStreetMap et l'API [OpenRouteService](https://openrouteservice.org).

## Fonctionnalités

- Départ (et arrivée en A → B) par **adresse avec suggestions**, position GPS ou point touché sur la carte
  (géocodage OpenRouteService, même clé ; secours automatique par [Photon](https://photon.komoot.io), sans clé,
  si OpenRouteService est injoignable ou si aucune clé n'est configurée)
- Activités : course (piéton), trail (randonnée), vélo de route, balade à vélo, VTT — chacune avec son profil de calcul ORS
- Types de parcours :
  - **Boucle** : notre propre algorithme (`web/js/planner.js`) dessine 24 polygones de 3 à 5 points de passage
    autour du départ, estime leur relief avec les dalles d'altitude
    [Terrarium](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data, sans clé), puis fait tracer par ORS
    les meilleures formes dans des directions variées, **plusieurs par requête** (enchaînées puis découpées grâce
    aux `way_points` de la réponse, ≤ 90 km et 50 points par requête) ; échelle corrigée en une requête groupée si
    l'écart dépasse 10 %, formes de rechange si une forme est impossible, et boucles `round_trip` d'ORS en dernier
    recours. « Générer à nouveau » avec les mêmes critères réutilise les parcours non affichés, le trajet direct
    (A → B) et l'échelle observée
  - **Aller-retour** : point de demi-tour choisi parmi 16 directions selon le relief estimé
  - **A → B avec détour** : si le trajet direct est trop court, passage par un point placé sur une ellipse
    dont A et B sont les foyers (toutes ses positions donnent la même distance à vol d'oiseau), position choisie
    selon le relief estimé
- Interface en 3 onglets : **Parcours**, **Mes parcours**, **Réglages**
- Écran principal réduit à l'essentiel (activité en pictogrammes, type, départ, distance) ; **Plus de critères** :
  profil de dénivelé + limite de D+ (pas de 50 m), revêtement (bitume / chemins), éviter les grands axes,
  nombre de propositions, résumés en pastilles
- Classement des propositions selon ces critères, avec une **pénalité pour les rues empruntées deux fois**
  (sauf en aller-retour) ; chaque proposition reçoit une **étiquette** (« La plus plate », « La plus nature »,
  « Au plus près », direction…) (`web/js/labels.js`)
- Pendant le calcul : étapes, formes étudiées en pointillés sur la carte, bouton Annuler, nombre de requêtes
- Sur la carte : **flèches de sens** et **repères kilométriques** ; profil altimétrique avec **curseur relié à la
  carte** ; statistiques compactes (D+/D−, point haut, repassages), revêtement, grands axes
- Actions rapides sous les propositions (« Vers ma montre » = GPX, enregistrer, détail) ; « Générer » devient
  « Autres parcours » tant que les critères n'ont pas changé
- **Mes parcours** : favoris avec miniature du tracé et nombre de sorties, **historique des sorties** (gardé sur
  l'appareil sans compte), statistiques par période et résumé du mois
- **Réglages** : compte, **allure par activité** (min/km à pied, km/h à vélo ; à pied, la durée utilise le
  kilomètre-effort, +1 km par 100 m de D+), clé OpenRouteService avec test et **compteur des requêtes du jour**,
  thème clair / sombre / auto, fond de carte, export / import des favoris, réinitialisation
- **Mise en route** en 2 étapes à la première visite (position, puis clé) ; tutoriel intégré (`web/aide.html`)
- **Comptes** (facultatifs) : synchronisation, partage de parcours par lien, historique en ligne — voir plus bas
- Installable sur l'écran d'accueil (Safari ▸ Partager ▸ « Sur l'écran d'accueil ») et utilisable hors ligne
  (favoris, historique ; service worker `web/sw.js`)

## Comptes utilisateurs (facultatif)

Avec un compte (e-mail + mot de passe), l'utilisateur retrouve ses **favoris et réglages sur tous ses appareils**,
peut **partager un parcours par lien** et tient un **historique de ses sorties** avec statistiques.
Sans configuration, l'app fonctionne sans comptes (Réglages ▸ Compte ▸ message d'explication).

Les comptes reposent sur [Supabase](https://supabase.com) (offre gratuite : authentification + base Postgres),
appelé directement depuis le navigateur : aucun serveur à héberger.

### Mise en service (une fois, ~10 minutes)

1. Créez un compte sur [supabase.com](https://supabase.com), puis **New project** (région Europe conseillée).
2. **SQL Editor ▸ New query** : collez le contenu de [`supabase/schema.sql`](supabase/schema.sql), puis **Run**.
   Il crée les tables (réglages, favoris, partages, sorties), les règles d'accès (chacun ne voit que ses
   données) et les fonctions de lecture d'un partage et de suppression de compte.
3. **Authentication ▸ URL Configuration** :
   - *Site URL* : `https://maximeaufrere.github.io/plan-itinerary/`
   - *Redirect URLs* : ajoutez la même adresse (et `http://localhost:8080/` pour les tests en local).
4. **Authentication ▸ Sign In / Providers ▸ Email** : laissez « Confirm email » activé ; réglez la longueur
   minimale du mot de passe à 8 (comme l'app).
5. **Project Settings ▸ API** : copiez la *Project URL* et la clé *anon public* dans
   [`web/js/config.js`](web/js/config.js), puis poussez : GitHub Pages republie l'app.

La clé « anon » est publique par conception : la sécurité repose sur les règles d'accès (Row Level Security)
du schéma. Ne mettez **jamais** la clé « service_role » dans l'app.

> E-mails : l'expéditeur intégré de Supabase est limité à quelques e-mails par heure, ce qui suffit pour un
> usage personnel. Pour plus d'utilisateurs, configurez un SMTP (Authentication ▸ Emails ▸ SMTP Settings).

### Fonctionnement

- **Synchronisation** : à la connexion, les favoris locaux et ceux du compte sont fusionnés (un favori supprimé
  sur un autre appareil n'est pas recréé) ; pour les réglages, la version la plus récente l'emporte. Ensuite,
  chaque modification est envoyée au compte (`web/js/account.js`, règles testées dans `web/js/sync.js`).
- **Partage** : un lien `…/?parcours=<identifiant aléatoire>` ; le parcours se lit via la fonction
  `get_shared_route`, sans compte, mais la liste des partages n'est pas consultable.
- **Suppression du compte** : efface le compte et toutes ses données en ligne (fonction `delete_my_account`).

## Clé OpenRouteService

L'app demande une clé API gratuite au premier calcul (bouton ⚙️) : créez un compte sur
[openrouteservice.org](https://openrouteservice.org/dev/#/signup) et copiez la clé de votre tableau de bord.
La clé est enregistrée **uniquement dans le navigateur** de l'appareil (jamais dans le dépôt). Offre gratuite :
environ 2 000 itinéraires par jour et 40 par minute ; une génération en consomme en général 1 à 3
(plusieurs parcours par requête ; +1 pour le trajet direct en mode A → B). L'app reste d'elle-même sous 35 requêtes
par minute.

## Lancer en local

```bash
cd web
python3 -m http.server 8080   # ou : npm start
# puis http://localhost:8080
```

La géolocalisation du navigateur exige HTTPS (ou `localhost`) : pour tester le GPS sur un téléphone, il faut
passer par la version hébergée.

## Tests

```bash
cd web && npm test   # tests unitaires : Node 20+, aucune dépendance à installer

# Tests dans un vrai navigateur (mobile et ordinateur, réseau simulé)
cd web && npm install && npx playwright install chromium && npm run test:e2e
```

Les deux séries tournent avant chaque publication (`.github/workflows/pages.yml`) : si un test échoue,
le site n'est pas mis à jour et le rapport est joint au run GitHub Actions.

## Hébergement

Site statique : il suffit de publier le dossier `web/`.

- **Netlify** : « Add new site ▸ Import from Git », choisir ce dépôt ; `netlify.toml` configure déjà le dossier.
- **Cloudflare Pages** : connecter le dépôt, commande de build vide, dossier de sortie `web`.
- **GitHub Pages** (utilisé actuellement) : `.github/workflows/pages.yml` publie `web/` à chaque modification.
  Adresse : https://maximeaufrere.github.io/plan-itinerary/
