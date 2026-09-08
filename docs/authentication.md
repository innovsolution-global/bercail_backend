# Authentification

Une seule route de connexion pour les quatre rôles : `POST /api/v1/auth/login`.
Ce qui change d'un rôle à l'autre, ce n'est pas la façon de se connecter,
c'est ce que le compte a le droit de faire ensuite.

## Cycle de vie des comptes

| Rôle          | Création                              | Premier accès                                   |
| ------------- | ------------------------------------- | ----------------------------------------------- |
| `CUSTOMER`    | `POST /auth/register` (public)        | Immédiat, compte `ACTIVE`                       |
| `DRIVER`      | `POST /drivers` (ADMIN/SUPER_ADMIN)   | Mot de passe temporaire **ou** lien d'activation |
| `ADMIN`       | `POST /administrators` (SUPER_ADMIN)  | Lien d'activation obligatoire, compte `PENDING` |
| `SUPER_ADMIN` | **Seed / provisionnement**            | Aucune route ne le crée                          |

### L'inscription publique ne crée que des clients

Le rôle n'est pas un champ de `RegisterDto`. Même envoyé, il est rejeté par le
`ValidationPipe` (`forbidNonWhitelisted`) avant d'atteindre le service :

```http
POST /api/v1/auth/register
{ "firstName": "…", "role": "SUPER_ADMIN" }

422 { "code": "VALIDATION_ERROR" }
```

### Livreur : deux modes de remise des identifiants

`POST /drivers` accepte `credentialMode` :

- **`temporary_password`** (défaut) — le backend génère un mot de passe,
  le renvoie **une seule fois** au gestionnaire, crée le compte `ACTIVE` avec
  `mustChangePassword: true`. Le livreur se connecte, mais son jeton n'ouvre
  que `/auth/me`, `/auth/change-password` et `/auth/logout` tant qu'il n'a pas
  choisi son mot de passe.
- **`activation_link`** — le compte est `PENDING`, un jeton d'activation est
  renvoyé. Le livreur choisit lui-même son mot de passe via `/auth/activate`.

### Administrateur : activation obligatoire

Le compte naît `PENDING` avec un mot de passe aléatoire jamais communiqué :
il est inutilisable tant que l'activation n'a pas eu lieu.

```
SUPER_ADMIN                Backend                    Nouvel ADMIN
     │                        │                             │
     ├─ POST /administrators ►│                             │
     │                        ├─ compte PENDING             │
     │◄─ jeton d'activation ──┤                             │
     ├─ transmet le lien ─────────────────────────────────► │
     │                        │◄─ POST /auth/activate ──────┤
     │                        ├─ statut ACTIVE + session    │
```

### Super administrateur

Aucune route ne crée de `SUPER_ADMIN`, et `AdminsService` refuse toute
opération le visant (`CANNOT_MODIFY_SUPER_ADMIN`). Il est provisionné par le
seed à partir de `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`, à changer
immédiatement. En production, la validation d'environnement refuse de démarrer
si le mot de passe d'amorçage est resté à sa valeur d'exemple.

## Jetons

| Jeton   | Durée   | Contenu                          | Stockage serveur       |
| ------- | ------- | -------------------------------- | ---------------------- |
| Access  | 15 min  | `sub`, `email`, `role`, `sid`    | Aucun                  |
| Refresh | 30 jours| `sub`, `jti`, `family`           | **Condensat SHA-256**  |

### Pourquoi stocker le refresh token

Un JWT seul ne se révoque pas. En conservant son condensat en base, on peut :

- fermer une session à distance (`DELETE /auth/sessions/:id`) ;
- fermer toutes les sessions à la suspension d'un compte ;
- détecter un **rejeu**.

### Rotation et détection de rejeu

Chaque appel à `/auth/refresh` révoque le jeton présenté et en émet un
nouveau, dans la même « famille ». Si un jeton **déjà consommé** se
représente, c'est qu'une copie circule :

```
Jeton volé rejoué
     │
     ├─ toute la famille est révoquée
     ├─ une alerte de sécurité est créée (visible au SUPER_ADMIN)
     └─ 401 REFRESH_TOKEN_REUSED
```

L'utilisateur légitime doit se reconnecter — c'est le prix, assumé, d'une
détection fiable.

### Le rôle est relu à chaque requête

`JwtStrategy.validate` recharge le compte depuis la base : rôle, statut et
permissions effectives. Conséquence directe : suspendre un compte ou retirer
une permission prend effet **immédiatement**, sans attendre l'expiration du
jeton.

## Protections

| Mécanisme                    | Détail                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| Anti-énumération             | Même message et même durée que le compte existe ou non                |
| Verrouillage progressif      | 5 échecs → blocage 15 min, compteur **en base**                       |
| Limitation de débit          | login 10/5 min · register 5/5 min · forgot-password 3/15 min          |
| Politique de mot de passe    | 8 caractères minimum, majuscule, minuscule, chiffre                   |
| Changement de mot de passe   | Ferme toutes les autres sessions                                      |
| Réinitialisation             | Jeton à usage unique, 30 min, condensat en base                       |

En dehors de la production, `/auth/forgot-password` renvoie le jeton dans sa
réponse pour rendre le parcours testable sans service d'e-mail. En production,
ce champ n'existe pas.

## Endpoints

| Méthode | Route                     | Accès       | Description                              |
| ------- | ------------------------- | ----------- | ---------------------------------------- |
| POST    | `/auth/register`          | Public      | Inscription — CUSTOMER uniquement        |
| POST    | `/auth/login`             | Public      | Connexion (e-mail ou téléphone)          |
| POST    | `/auth/refresh`           | Public      | Rotation du refresh token                |
| POST    | `/auth/logout`            | Authentifié | Fermeture de session                     |
| POST    | `/auth/forgot-password`   | Public      | Demande de réinitialisation              |
| POST    | `/auth/reset-password`    | Public      | Réinitialisation par jeton               |
| POST    | `/auth/activate`          | Public      | Activation d'un compte créé par le back-office |
| POST    | `/auth/change-password`   | Authentifié | Changement de mot de passe               |
| GET     | `/auth/me`                | Authentifié | Profil, adapté au rôle                   |
| PATCH   | `/auth/me`                | Authentifié | Modifier son propre profil (4 rôles)     |
| GET     | `/auth/sessions`          | Authentifié | Sessions actives                         |
| DELETE  | `/auth/sessions/:id`      | Authentifié | Fermer une session à distance            |
| POST    | `/auth/devices`           | Authentifié | Enregistrer un appareil (push)           |
| DELETE  | `/auth/devices/:token`    | Authentifié | Retirer un appareil                      |

### Réponse de connexion

```jsonc
{
  "success": true,
  "data": {
    "accessToken": "eyJ…",
    "refreshToken": "eyJ…",
    "expiresIn": 900,
    "user": {
      "id": "…", "firstName": "Fatoumata", "lastName": "Sylla",
      "fullName": "Fatoumata Sylla",
      "email": "admin@lebercail.gn", "phone": "+224620000002",
      "role": "ADMIN",              // MAJUSCULES
      "status": "active",           // minuscules
      "permissions": ["ORDERS_READ", "…"],
      "mustChangePassword": false
      // + "driver" pour un DRIVER, "customer" pour un CUSTOMER
    }
  }
}
```

## Modifier son propre profil

`PATCH /auth/me` est ouverte aux **quatre rôles** : un gestionnaire corrige
son nom ou son numéro sans dépendre d'un SUPER_ADMIN, un livreur met à jour
son avatar depuis son application.

```jsonc
PATCH /api/v1/auth/me
{ "firstName": "Fatoumata", "lastName": "Sylla", "phone": "+224620000002",
  "avatarUrl": "http://…/uploads/avatars/….jpg" }
```

Ce que la route **ne permet pas**, et qui est refusé en `422` :

| Champ         | Pourquoi                                              |
| ------------- | ----------------------------------------------------- |
| `email`       | C'est l'identifiant de connexion                       |
| `role`        | Un compte ne s'auto-promeut pas                        |
| `status`      | La suspension relève de l'administration               |
| `permissions` | Elles sont attribuées par le SUPER_ADMIN               |

Un numéro déjà pris renvoie `409 CONFLICT`. Chaque modification est
journalisée (`PROFILE_UPDATE`), avec la valeur avant/après.

L'avatar se téléverse d'abord via `POST /storage/avatar`, qui renvoie l'URL
à passer dans `avatarUrl`.

> L'application mobile dispose aussi de `PATCH /me`, réservée au CUSTOMER :
> même écriture, mais la réponse contient le profil client complet
> (fidélité, adresses).

## Côté client

**React** — l'intercepteur Axios rejoue une requête après un refresh
silencieux ; une seule requête de refresh est émise même si dix appels
échouent simultanément.

**Flutter** — stocker les deux jetons dans le stockage sécurisé, rafraîchir
sur 401, et transmettre le jeton FCM via `POST /auth/devices` après connexion.
