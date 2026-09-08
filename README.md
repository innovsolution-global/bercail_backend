# LE BERCAIL — Backend

API unique de la plateforme **Le Bercail** (restaurant, Conakry).

Un seul backend sert **quatre rôles** depuis deux applications :

```
        FLUTTER                          REACT
   CUSTOMER   DRIVER              ADMIN   SUPER_ADMIN
       │         │                  │          │
       └─────────┴────────┬─────────┴──────────┘
                          ▼
                 LE BERCAIL API  (NestJS)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   PostgreSQL           Redis            Stockage
      (Prisma)     (cache, débit,      (local / S3)
                    WebSocket)
```

Le backend est **indépendant des frontends** : il n'existe ni « API Flutter »,
ni « API React ». Une seule logique métier, quatre périmètres d'autorisation.

---

## Sommaire

- [Démarrage rapide](#démarrage-rapide)
- [Identifiants de démonstration](#identifiants-de-démonstration)
- [Architecture](#architecture)
- [Conventions d'API](#conventions-dapi)
- [Sécurité](#sécurité)
- [Scripts](#scripts)
- [Tests](#tests)
- [Brancher les frontends](#brancher-les-frontends)
- [Documentation détaillée](#documentation-détaillée)

---

## Démarrage rapide

### Prérequis

- Node.js ≥ 20 (testé sur 22 et 24)
- PostgreSQL 14+ et Redis 7+ — ou Docker

### 1. Dépendances et configuration

```bash
cd backend
npm install
cp .env.example .env       # adaptez DATABASE_URL et les secrets
```

### 2. Base de données

Avec Docker (recommandé) :

```bash
docker compose up -d postgres redis
```

Avec un PostgreSQL déjà installé, créez un rôle dédié plutôt que d'utiliser
le superutilisateur dans la configuration de l'application :

```sql
CREATE ROLE bercail LOGIN PASSWORD 'un_mot_de_passe';
CREATE DATABASE bercail OWNER bercail ENCODING 'UTF8';
```

puis renseignez `DATABASE_URL` en conséquence.

### 3. Schéma et données de démonstration

```bash
npx prisma migrate dev --name init   # crée les tables
npm run seed                         # restaurant, carte, comptes, commandes
```

### 4. Démarrage

```bash
npm run dev          # ou npm run start:dev
```

| Ressource      | URL                                |
| -------------- | ---------------------------------- |
| API            | http://localhost:3000/api/v1       |
| Documentation  | http://localhost:3000/docs         |
| WebSocket      | ws://localhost:3000/realtime       |
| Santé          | http://localhost:3000/health       |

> Redis est facultatif en développement : sans lui, l'API démarre en mode
> dégradé (pas de cache, limitation de débit locale) et le signale dans les
> logs. La base PostgreSQL, elle, est indispensable.

---

## Identifiants de démonstration

Créés par `npm run seed`. **À ne jamais utiliser en production.**

| Rôle          | E-mail                            | Mot de passe     | Application |
| ------------- | --------------------------------- | ---------------- | ----------- |
| SUPER_ADMIN   | `superadmin@lebercail.gn`         | `SuperAdmin@2024`| React       |
| ADMIN         | `admin@lebercail.gn`              | `Admin@2024`     | React       |
| ADMIN (carte) | `admin.carte@lebercail.gn`        | `Admin@2024`     | React       |
| DRIVER        | `ibrahima.camara@lebercail.gn`    | `Livreur@2024`   | Flutter     |
| CUSTOMER      | `mariama.diallo@example.gn`       | `Client@2024`    | Flutter     |

Le second administrateur a volontairement des **droits restreints** (carte,
lecture des commandes, rapports) : il sert à vérifier le RBAC fin.

Autres éléments du jeu de démonstration :

- code de remise des livraisons en cours : **1234**
- codes promotionnels : `BIENVENUE10`, `LIVRAISON0`, `GRILL25`

---

## Architecture

```
src/
├── auth/          Authentification, jetons, sessions, mots de passe
├── rbac/          Permissions effectives et catalogue
├── users/         Sérialisation des comptes
├── customers/     Clients (back-office) et profil client
├── drivers/       Livreurs (back-office) et espace livreur
├── admins/        Administrateurs — SUPER_ADMIN uniquement
├── menu/          Catégories, plats, options
├── favorites/     Favoris client
├── addresses/     Carnet d'adresses
├── carts/         Panier
├── orders/        Commandes, machine à états, moteur de prix
├── payments/      Paiements et remboursements
├── deliveries/    Livraisons, attribution, GPS, code de remise
├── promotions/    Codes promotionnels
├── notifications/ Notifications applicatives et push
├── realtime/      WebSocket (Socket.IO + adaptateur Redis)
├── reports/       Tableaux de bord et rapports
├── search/        Recherche globale
├── settings/      Restaurant et paramètres système
├── audit/         Journal des actions sensibles
├── storage/       Fichiers (local / S3)
├── health/        Sondes
├── common/        Guards, décorateurs, filtres, DTO, utilitaires
├── config/        Configuration et validation d'environnement
└── database/      Client Prisma
```

### Principes structurants

**Une seule logique métier.** Il n'existe pas de `AdminOrderService` ni de
`CustomerOrderService` : `OrdersService` sert les quatre rôles. Ce qui change
d'un rôle à l'autre, c'est le **filtre appliqué** et les **transitions
autorisées** — pas le calcul.

**Le serveur est la source de vérité.** Les montants sont recalculés à chaque
commande à partir de la base. Un `total` envoyé par un client n'est pas
seulement ignoré : le `ValidationPipe` le **refuse** (`forbidNonWhitelisted`).

**Quatre barrières d'autorisation**, montées globalement :

1. authentification (JWT, rechargé depuis la base à chaque requête) ;
2. changement de mot de passe imposé le cas échéant ;
3. rôle ;
4. permission.

La cinquième — l'**appartenance** — est vérifiée dans les services, au plus
près de la donnée : un client ne lit que ses commandes, un livreur que ses
courses.

Une route sans décorateur est **fermée**. Il faut un `@Public()` explicite
pour l'ouvrir.

---

## Conventions d'API

### Enveloppes

```jsonc
// Ressource
{ "success": true, "data": { } }

// Liste paginée
{ "success": true, "data": [ ], "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 } }

// Erreur
{
  "success": false,
  "statusCode": 403,
  "code": "FORBIDDEN",
  "message": "Vous n'avez pas les permissions nécessaires.",
  "errors": { "email": "email doit être une adresse e-mail valide." },
  "error": { "code": "FORBIDDEN", "message": "…" },
  "requestId": "…"
}
```

### Règles transverses

| Sujet          | Règle                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Montants       | **entiers** en GNF. Jamais de flottant.                               |
| Dates          | UTC en base, **ISO 8601** sur le réseau.                              |
| Énumérations   | `role` et permissions en `MAJUSCULES` ; tout le reste en `minuscules`. |
| Pagination     | imposée sur toutes les listes, `limit` plafonné à 100.                |
| Versionnage    | toutes les routes sous `/api/v1`.                                     |
| Corrélation    | en-tête `X-Request-Id` en entrée comme en sortie.                     |
| Idempotence    | en-tête `Idempotency-Key` sur la création de commande et le paiement. |

### Suppression logique

Les commandes, paiements, journaux et historiques ne sont **jamais** supprimés
physiquement. Les entités métier (plats, catégories, adresses, promotions,
comptes) utilisent un `deletedAt`.

---

## Sécurité

- **JWT** : access token court (15 min) + refresh token long, **tournant à
  chaque usage**. Le refresh est signé *et* stocké en condensat : il peut donc
  être révoqué immédiatement. Un jeton rejoué révoque toute la famille et lève
  une alerte de sécurité.
- **Mots de passe** : bcrypt (coût 12), politique de robustesse appliquée
  y compris aux mots de passe générés par le backend.
- **Anti-énumération** : `/auth/login` et `/auth/forgot-password` répondent
  la même chose que le compte existe ou non, en un temps comparable.
- **Verrouillage** : compte bloqué temporairement après 5 échecs, compteur
  stocké en base (un redémarrage ne l'efface pas).
- **Limitation de débit** : globale, plus des quotas serrés sur la connexion,
  l'inscription, la réinitialisation, le paiement et le code de livraison.
  Compteurs dans Redis (partagés entre instances).
- **Code de remise (OTP)** : jamais stocké en clair, expirable, à usage
  unique, nombre de tentatives plafonné.
- **Audit** : toute action sensible est journalisée avec auteur, IP,
  user-agent et différentiel avant/après. Le journal est en écriture seule.
- **Helmet, CORS, compression**, validation stricte des entrées.
- **Jamais journalisés** : mot de passe, jeton, code OTP, secret de paiement.
  Les numéros mobile money ne sont stockés que **tronqués**.

---

## Scripts

| Commande                  | Effet                                              |
| ------------------------- | -------------------------------------------------- |
| `npm run dev`             | Démarrage avec rechargement à chaud (alias)        |
| `npm run start:dev`       | Idem, nom NestJS d'origine                          |
| `npm run build`           | Compilation vers `dist/`                            |
| `npm run start:prod`      | Exécution de la version compilée                    |
| `npm run lint`            | ESLint                                              |
| `npm run typecheck`       | Vérification des types sans émission                |
| `npm test`                | Tests unitaires                                     |
| `npm run test:e2e`        | Tests de bout en bout (base requise)                |
| `npm run prisma:migrate`  | Migration de développement                          |
| `npm run prisma:deploy`   | Migrations en production                            |
| `npm run seed`            | Jeu de données de démonstration                     |
| `npm run db:setup`        | Migrations + seed                                   |

---

## Tests

```bash
npm test          # unitaires — aucune dépendance externe
npm run test:e2e  # bout en bout — PostgreSQL requis, base semée
```

Les tests unitaires couvrent ce qui doit être juste **par construction** :
machine à états des commandes et des livraisons, moteur de prix (options,
promotions, plafonds), matrice des rôles et permissions, utilitaires
monétaires et géographiques.

Les tests e2e rejouent les scénarios du cahier des charges :

- `auth.e2e-spec.ts` — inscription (clients uniquement), connexion, rotation
  des jetons, rejeu détecté, comptes suspendus.
- `rbac.e2e-spec.ts` — la matrice d'autorisation, ligne par ligne, et
  l'isolation des données entre deux clients ou deux livreurs.
- `order-flow.e2e-spec.ts` — le parcours complet : carte → panier → commande
  → préparation → attribution → GPS → code de remise → livrée, avec
  l'idempotence et les règles d'annulation.

> Les tests e2e écrivent dans la base pointée par `DATABASE_URL`. Utilisez une
> base dédiée, et exécutez `npm run seed` avant : ils s'appuient sur la carte
> et le restaurant.

### Recette d'une instance en fonctionnement

```bash
npm run dev                  # dans un terminal
python scripts/recette.py    # dans un autre
```

78 vérifications contre l'API réelle : les quatre rôles, la matrice
d'autorisation, le calcul des prix, l'idempotence, l'isolation des données,
le parcours complet jusqu'au code de remise, les tableaux de bord et l'audit.
Utile après un déploiement, ou pour valider un environnement.

La limitation de débit est neutralisée dans le socle e2e
(`test/helpers/app.helper.ts`) : une suite qui enchaîne volontairement les
connexions se bloquerait elle-même. Elle est vérifiée séparément.

---

## Brancher les frontends

### React (back-office)

`frontend_admin/.env` :

```
VITE_API_URL=http://localhost:3000/api/v1
VITE_WS_URL=http://localhost:3000
```

> La valeur par défaut du projet React est `http://localhost:3000/api` :
> ajoutez `/v1`, ou changez `API_PREFIX` côté backend.

Les chemins déjà utilisés par le back-office sont servis tels quels
(`/administrators`, `/audit-logs`, `/menu/items`, `/dashboard`…), en plus des
chemins du contrat (`/super-admin/admins`, `/menu-items`, `/admin/dashboard`…).
Un seul contrôleur répond aux deux : aucune divergence possible.

### Flutter (client et livreur)

```dart
const apiBaseUrl = 'http://10.0.2.2:3000/api/v1'; // émulateur Android
const wsUrl = 'http://10.0.2.2:3000/realtime';
```

Le jeton s'envoie en `Authorization: Bearer <accessToken>` ; sur le socket,
dans `auth: { token: accessToken }`.

### Événements temps réel

| Événement                  | Destinataires                          |
| -------------------------- | -------------------------------------- |
| `order.created`            | back-office, client concerné            |
| `order.status.updated`     | back-office, client, livreur assigné    |
| `delivery.assigned`        | livreur concerné, back-office, client   |
| `delivery.status.updated`  | back-office, client, livreur            |
| `driver.location.updated`  | back-office, suivi de la commande       |
| `payment.updated`          | back-office, client                     |
| `notification.created`     | destinataire uniquement                 |

Un client ne peut rejoindre le salon d'une commande qu'après vérification
serveur (`order:subscribe`).

---

## Documentation détaillée

| Document                                              | Contenu                                      |
| ----------------------------------------------------- | -------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)           | Découpage, flux, décisions de conception     |
| [docs/authentication.md](docs/authentication.md)       | Cycle de vie des comptes et des jetons       |
| [docs/authorization.md](docs/authorization.md)         | RBAC, permissions, matrice complète          |
| [docs/customer-api.md](docs/customer-api.md)           | Endpoints de l'application client            |
| [docs/driver-api.md](docs/driver-api.md)               | Endpoints de l'application livreur           |
| [docs/admin-api.md](docs/admin-api.md)                 | Endpoints du back-office                     |
| [docs/super-admin-api.md](docs/super-admin-api.md)     | Supervision, audit, système                  |
| [docs/orders.md](docs/orders.md)                       | Cycle de vie et calcul des prix              |
| [docs/payments.md](docs/payments.md)                   | Encaissement, remboursement, intégrations    |
| [docs/deliveries.md](docs/deliveries.md)               | Attribution, GPS, code de remise             |
| [docs/gestion.md](docs/gestion.md)                     | Caisse, stock, dépenses, paie, rapports      |
| [docs/synchronisation.md](docs/synchronisation.md)     | Serveur local ↔ en ligne, reprise après coupure |
| [docs/notifications.md](docs/notifications.md)         | Notifications et temps réel                  |
| [docs/deployment.md](docs/deployment.md)               | Docker, CI/CD, production                    |

---

## Intégration continue

Le workflow `.github/workflows/ci.yml` enchaîne lint, types, tests unitaires,
tests e2e (avec PostgreSQL et Redis) et construction de l'image Docker.

> Il est écrit pour un dépôt Git dont la racine contient `backend/`. Si votre
> dépôt est initialisé à la racine du projet, déplacez le dossier
> `backend/.github` vers la racine.
