# API back-office (React) — ADMIN

Base : `http://localhost:3000/api/v1` — rôle `ADMIN` ou `SUPER_ADMIN`.

Chaque route exige une **permission** en plus du rôle : un `ADMIN` dont le
`SUPER_ADMIN` a restreint les droits reçoit `403` sur ce qui dépasse son
périmètre. Voir [authorization.md](authorization.md).

> Les chemins historiques du back-office (`/menu/items`, `/administrators`,
> `/dashboard`…) et ceux du contrat (`/menu-items`, `/super-admin/admins`,
> `/admin/dashboard`…) pointent vers le **même contrôleur**.

## Tableau de bord

`GET /dashboard?period=daily|weekly|monthly|yearly&from=&to=` —
permission `REPORTS_READ`.

**Un seul appel** renvoie tout l'écran :

```jsonc
{
  "range": { "from": "…", "to": "…", "period": "daily" },
  "stats": {
    "revenue":         { "value": 12450000, "changePercent": 18 },
    "orders":          { "value": 87,       "changePercent": 12 },
    "pendingOrders":   { "value": 3,        "changePercent": 0 },
    "ongoingDeliveries": { "value": 5,      "changePercent": 0 },
    "activeCustomers": { "value": 41,       "changePercent": 9 },
    "averageBasket":   { "value": 143103,   "changePercent": 5 }
  },
  "live": { "pending": 3, "confirmed": 2, "preparing": 3, "ready": 2,
            "assigned": 2, "outForDelivery": 3 },
  "series": [ { "label": "3 sept.", "date": "…", "revenue": 890000, "orders": 6, "deliveries": 5 } ],
  "recentOrders": [ /* 10 dernières, format OrderSummary */ ],
  "topProducts": [ { "menuItemId": "…", "name": "Poulet braisé entier",
                     "ordersCount": 43, "revenue": 6235000 } ],
  "drivers": { "activeDrivers": 3, "availableDrivers": 2, "ongoingDeliveries": 5 },
  "statusBreakdown": [ { "status": "delivered", "count": 28 } ]
}
```

Toutes ces valeurs viennent d'agrégations **en base** (`groupBy`,
`date_trunc`) : aucune liste complète n'est chargée en mémoire.

## Commandes

| Méthode | Route                        | Permission              |
| ------- | ---------------------------- | ----------------------- |
| GET     | `/orders`                    | `ORDERS_READ`           |
| GET     | `/orders/:id`                | `ORDERS_READ`           |
| PATCH   | `/orders/:id/status`         | `ORDERS_UPDATE_STATUS`  |
| POST    | `/orders/:id/cancel`         | `ORDERS_CANCEL`         |
| POST    | `/orders/:orderId/assign`    | `ORDERS_ASSIGN_DRIVER`  |
| GET     | `/orders/export`             | `ORDERS_EXPORT`         |

Filtres : `status`, `paymentStatus`, `type`, `driverId`, `customerId`,
`from`, `to`, `search`, `sortBy`, `sortOrder`, `page`, `limit`.

Le flux nominal en cuisine :

```
PATCH /orders/:id/status { "status": "confirmed" }
PATCH /orders/:id/status { "status": "preparing" }
PATCH /orders/:id/status { "status": "ready" }
GET   /drivers/assignable?orderId=…
POST  /orders/:id/assign { "driverId": "…" }
```

## Carte

| Méthode | Route                            | Permission            |
| ------- | -------------------------------- | --------------------- |
| GET     | `/menu/items`                    | Publique              |
| POST    | `/menu/items`                    | `MENU_CREATE`         |
| PATCH   | `/menu/items/:id`                | `MENU_UPDATE`         |
| PATCH   | `/menu/items/:id/availability`   | `MENU_AVAILABILITY`   |
| DELETE  | `/menu/items/:id`                | `MENU_DELETE`         |
| GET     | `/menu/categories`               | Publique              |
| POST    | `/menu/categories`               | `CATEGORIES_MANAGE`   |
| PATCH   | `/menu/categories/:id`           | `CATEGORIES_MANAGE`   |
| DELETE  | `/menu/categories/:id`           | `CATEGORIES_MANAGE`   |

Un compte du back-office voit **toute** la carte, plats en rupture compris ;
un client ne voit que ce qui est disponible. C'est la même route.

Les groupes d'options s'envoient avec le plat, et remplacent l'existant :

```jsonc
{
  "name": "Poulet braisé entier",
  "price": 145000,
  "optionGroups": [
    { "name": "Accompagnement", "isRequired": true, "minSelect": 1, "maxSelect": 1,
      "options": [ { "name": "Riz gras", "extraPrice": 0 },
                   { "name": "Alloco",   "extraPrice": 5000 } ] }
  ]
}
```

> Un changement de prix est journalisé avec sa valeur avant/après.

## Clients

| Méthode | Route                    | Permission            |
| ------- | ------------------------ | --------------------- |
| GET     | `/customers`             | `CUSTOMERS_READ`      |
| GET     | `/customers/:id`         | `CUSTOMERS_READ`      |
| GET     | `/customers/:id/orders`  | `CUSTOMERS_READ` + `ORDERS_READ` |
| GET     | `/customers/:id/summary` | `CUSTOMERS_READ`      |
| PATCH   | `/customers/:id`         | `CUSTOMERS_UPDATE`    |
| PATCH   | `/customers/:id/status`  | `CUSTOMERS_SUSPEND`   |
| GET     | `/customers/export`      | `CUSTOMERS_EXPORT`    |

Une suspension ferme immédiatement toutes les sessions du client. Ses
commandes en cours ne sont pas annulées : le repas déjà en préparation doit
être livré.

## Livreurs

| Méthode | Route                             | Permission          |
| ------- | --------------------------------- | ------------------- |
| GET     | `/drivers`                        | `DRIVERS_READ`      |
| GET     | `/drivers/assignable`             | `DRIVERS_READ`      |
| GET     | `/drivers/zones`                  | `DRIVERS_READ`      |
| GET     | `/drivers/:id`                    | `DRIVERS_READ`      |
| POST    | `/drivers`                        | `DRIVERS_CREATE`    |
| PATCH   | `/drivers/:id`                    | `DRIVERS_UPDATE`    |
| PATCH   | `/drivers/:id/status`             | `DRIVERS_SUSPEND`   |
| POST    | `/drivers/:id/resend-activation`  | `DRIVERS_CREATE`    |
| DELETE  | `/drivers/:id`                    | `DRIVERS_DELETE` (SUPER_ADMIN par défaut) |

### Créer un livreur

```jsonc
// POST /drivers
{
  "firstName": "Ibrahima", "lastName": "Camara",
  "email": "ibrahima.camara@lebercail.gn", "phone": "+224620330001",
  "vehicleType": "moto", "plateNumber": "RC-2451-A", "zone": "Kaloum",
  "credentialMode": "temporary_password",  // ou "activation_link"
  "password": "Bercail@2026"               // facultatif : engendré si absent
}
```

La réponse contient les identifiants **une seule fois** :

```jsonc
{
  "id": "…", "driverCode": "LIV-006", "status": "active",
  "credentials": {
    "mode": "temporary_password",
    "temporaryPassword": "Kf3mPq7xW2!",
    "note": "Communiquez ce mot de passe au livreur. Il devra le changer à sa première connexion."
  }
}
```

Ils ne sont plus jamais consultables : en cas de perte, il faut renvoyer un
lien d'activation.

Les identifiants partent **par e-mail** au nouveau compte. L'envoi est fait
dans la transaction de création : s'il échoue (relais injoignable, adresse
refusée, `MAIL_PASSWORD` absent), la réponse est `422` et **aucun compte
n'est créé** — un compte dont personne n'a reçu le mot de passe n'aurait
aucune utilité. Voir `MAIL_*` dans `.env.example`.

`POST /administrators` accepte les mêmes champs `credentialMode` et
`password`, et renvoie le même bloc `credentials`. En mode
`temporary_password` le compte est créé **actif** avec `mustChangePassword`
à `true` : tant qu'il n'a pas changé son mot de passe, son jeton n'ouvre que
`/auth/me`, `/auth/change-password` et `/auth/logout` — toute autre route
répond `403 PASSWORD_CHANGE_REQUIRED`. Le mot de passe fourni passe par les
mêmes règles de robustesse que celui qu'un compte se donne lui-même
(minuscule, majuscule, chiffre, 8 caractères).

Un livreur ayant des courses en cours ne peut être ni suspendu ni supprimé :
ses courses doivent d'abord être réattribuées.

## Livraisons

| Méthode | Route                     | Permission          |
| ------- | ------------------------- | ------------------- |
| GET     | `/deliveries`             | `DELIVERIES_READ`   |
| GET     | `/deliveries/active`      | `DELIVERIES_TRACK`  |
| GET     | `/deliveries/:id`         | `DELIVERIES_READ`   |
| GET     | `/deliveries/:id/trail`   | `DELIVERIES_TRACK`  |
| PATCH   | `/deliveries/:id/status`  | `DELIVERIES_UPDATE` |
| POST    | `/deliveries/:id/fail`    | `DELIVERIES_UPDATE` |

`/deliveries/active` est l'écran de supervision : toutes les courses en cours
avec la dernière position connue de chaque livreur.

## Paiements

| Méthode | Route                    | Permission          |
| ------- | ------------------------ | ------------------- |
| GET     | `/payments`              | `PAYMENTS_READ`     |
| GET     | `/payments/:id`          | `PAYMENTS_READ`     |
| POST    | `/payments/:id/refund`   | `PAYMENTS_REFUND`   |
| GET     | `/payments/export`       | `PAYMENTS_EXPORT`   |

## Promotions

| Méthode | Route                     | Permission           |
| ------- | ------------------------- | -------------------- |
| GET     | `/promotions`             | `PROMOTIONS_READ`    |
| GET     | `/promotions/:id`         | `PROMOTIONS_READ`    |
| POST    | `/promotions`             | `PROMOTIONS_CREATE`  |
| PATCH   | `/promotions/:id`         | `PROMOTIONS_UPDATE`  |
| PATCH   | `/promotions/:id/active`  | `PROMOTIONS_UPDATE`  |
| DELETE  | `/promotions/:id`         | `PROMOTIONS_DELETE`  |

## Rapports

| Méthode | Route                  | Permission        |
| ------- | ---------------------- | ----------------- |
| GET     | `/reports`             | `REPORTS_READ`    |
| GET     | `/reports/sales`       | `REPORTS_READ`    |
| GET     | `/reports/payments`    | `REPORTS_READ`    |
| GET     | `/reports/deliveries`  | `REPORTS_READ`    |
| GET     | `/reports/export`      | `REPORTS_EXPORT`  |

## Paramètres

| Méthode | Route                   | Permission          |
| ------- | ----------------------- | ------------------- |
| GET     | `/settings/restaurant`  | `SETTINGS_READ`     |
| PATCH   | `/settings/restaurant`  | `SETTINGS_UPDATE`   |

Horaires, frais de livraison, seuil de gratuité, minimum de commande, zones
desservies, ouverture manuelle. Toute modification est auditée.

## Fichiers

| Méthode | Route                  | Usage                        |
| ------- | ---------------------- | ---------------------------- |
| POST    | `/storage/menu`        | Photo de plat                |
| POST    | `/storage/restaurant`  | Logo, image de couverture    |
| POST    | `/storage/promotion`   | Visuel de promotion          |
| POST    | `/storage/avatar`      | Photo de profil              |

`multipart/form-data`, champ `file`. JPEG, PNG, WebP, GIF, 5 Mo maximum.
Le serveur renomme le fichier et renvoie son URL.

## Profil du gestionnaire

| Méthode | Route        | Description                                        |
| ------- | ------------ | -------------------------------------------------- |
| GET     | `/auth/me`   | Son profil, avec ses permissions effectives         |
| PATCH   | `/auth/me`   | Modifier son nom, son numéro, son avatar            |
| POST    | `/auth/change-password` | Changer son mot de passe                 |
| GET     | `/auth/sessions`        | Ses sessions actives                      |
| DELETE  | `/auth/sessions/:id`    | Fermer une session à distance             |

Aucune permission requise : chacun gère son propre compte. L'e-mail, le rôle
et les permissions ne se modifient pas par cette route — elles relèvent du
SUPER_ADMIN.

## Gestion d'exploitation

Caisse (vente au comptoir), stock et approvisionnements, dépenses et recettes,
personnel et paie, rapport d'activité mensuel : voir [gestion.md](gestion.md).

| Méthode | Route                             | Permission        |
| ------- | --------------------------------- | ----------------- |
| POST    | `/pos/orders`                     | `POS_SELL`        |
| GET     | `/stock/items`                    | `STOCK_READ`      |
| POST    | `/stock/movements`                | `STOCK_MANAGE`    |
| POST    | `/purchases`                      | `PURCHASES_MANAGE`|
| GET     | `/expenses`                       | `FINANCE_READ`    |
| POST    | `/expenses`                       | `EXPENSES_MANAGE` |
| GET     | `/employees/payroll?period=`      | `EMPLOYEES_READ`  |
| POST    | `/employees/payroll/generate`     | `PAYROLL_MANAGE`  |
| GET     | `/finance/ledger`                 | `FINANCE_READ`    |
| GET     | `/finance/monthly-report?period=` | `FINANCE_READ`    |

## Recherche et notifications

| Méthode | Route                          | Description                                  |
| ------- | ------------------------------ | -------------------------------------------- |
| GET     | `/search?q=…`                  | Commandes, clients, livreurs, plats          |
| GET     | `/search/counts`               | Compteurs de la barre supérieure             |
| GET     | `/notifications`               | Ses notifications                            |
| GET     | `/notifications/unread-count`  | Badge                                        |

La recherche respecte les permissions : un `ADMIN` sans `CUSTOMERS_READ` ne
voit pas de clients dans les résultats.

## Temps réel

```ts
const socket = io(`${env.wsUrl}/realtime`, { auth: { token: accessToken } });

socket.on('order.created', (order) => { /* nouvelle commande à l'écran */ });
socket.on('order.status.updated', (order) => { /* … */ });
socket.on('delivery.status.updated', (delivery) => { /* … */ });
socket.on('driver.location.updated', (position) => { /* carte de supervision */ });
```

Les comptes du back-office rejoignent automatiquement le salon
d'exploitation : les nouvelles commandes arrivent sans rafraîchissement.
