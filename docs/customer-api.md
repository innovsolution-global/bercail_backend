# API client (Flutter)

Base : `http://localhost:3000/api/v1` — jeton en `Authorization: Bearer <accessToken>`.

## Parcours type

```
inscription → carte → panier → adresse → devis → commande → paiement → suivi → historique
```

## Compte

| Méthode | Route                    | Description                            |
| ------- | ------------------------ | -------------------------------------- |
| POST    | `/auth/register`         | Inscription (crée un CUSTOMER)         |
| POST    | `/auth/login`            | E-mail **ou** téléphone                |
| POST    | `/auth/refresh`          | Rotation du jeton                      |
| POST    | `/auth/logout`           | Déconnexion                            |
| GET     | `/auth/me`               | Profil du porteur du jeton             |
| POST    | `/auth/forgot-password`  | Mot de passe oublié                    |
| POST    | `/auth/reset-password`   | Réinitialisation                       |
| POST    | `/auth/change-password`  | Changement                             |
| POST    | `/auth/devices`          | Enregistrer le jeton FCM               |
| PATCH   | `/auth/me`               | Modifier son profil (commun aux rôles) |
| GET     | `/me`                    | Profil complet (fidélité, adresses)    |
| PATCH   | `/me`                    | Idem, réponse enrichie pour le mobile  |

## Restaurant et carte

| Méthode | Route                          | Description                                        |
| ------- | ------------------------------ | -------------------------------------------------- |
| GET     | `/restaurant`                  | Fiche publique, `isOpenNow` calculé côté serveur    |
| GET     | `/categories`                  | Catégories actives                                  |
| GET     | `/menu-items`                  | Plats disponibles, paginés                          |
| GET     | `/menu-items/highlights`       | Incontournables + suggestions, **un seul appel**    |
| GET     | `/menu-items/:id`              | Détail avec groupes d'options                       |
| GET     | `/search?q=…`                  | Recherche dans la carte et ses commandes            |

Filtres de `/menu-items` : `categoryId` (identifiant **ou** slug),
`search`, `popular`, `suggestion`, `minPrice`, `maxPrice`, `sortBy`
(`price`, `name`, `popularity`), `page`, `limit`.

> `isOpenNow` est calculé par le serveur : l'application n'a pas à déduire
> l'ouverture à partir d'une grille horaire.

## Favoris

| Méthode | Route                        | Description                                  |
| ------- | ---------------------------- | -------------------------------------------- |
| GET     | `/favorites`                 | Plats favoris, avec leur fiche complète      |
| GET     | `/favorites/ids`             | Identifiants seuls — pour colorer les cœurs  |
| POST    | `/favorites/:menuItemId`     | Ajouter (idempotent)                         |
| DELETE  | `/favorites/:menuItemId`     | Retirer                                      |

## Adresses

| Méthode | Route                     | Description                                     |
| ------- | ------------------------- | ----------------------------------------------- |
| GET     | `/addresses`              | Ses adresses                                    |
| POST    | `/addresses`              | Ajouter (la première devient celle par défaut)  |
| GET     | `/addresses/:id`          | Détail                                          |
| PATCH   | `/addresses/:id`          | Modifier                                        |
| PATCH   | `/addresses/:id/default`  | Définir par défaut                              |
| DELETE  | `/addresses/:id`          | Supprimer (logique)                             |

## Panier

| Méthode | Route                    | Description                                  |
| ------- | ------------------------ | -------------------------------------------- |
| GET     | `/cart`                  | Panier complet, prix recalculés               |
| POST    | `/cart/items`            | Ajouter un plat                              |
| PATCH   | `/cart/items/:itemId`    | Modifier (`quantity: 0` retire la ligne)     |
| DELETE  | `/cart/items/:itemId`    | Retirer                                      |
| DELETE  | `/cart`                  | Vider                                        |

Toutes les réponses renvoient le **panier entier recalculé** : l'application
n'additionne jamais rien elle-même.

```jsonc
// GET /cart?orderType=delivery&promotionCode=BIENVENUE10
{
  "items": [ { "id": "…", "name": "Poulet braisé entier", "quantity": 2,
               "unitPrice": 145000, "lineTotal": 300000,
               "options": [ { "groupName": "Accompagnement", "name": "Alloco", "extraPrice": 5000 } ],
               "isAvailable": true } ],
  "itemsCount": 2,
  "subtotal": 300000, "deliveryFee": 0, "discount": 20000, "total": 280000,
  "promotion": { "code": "BIENVENUE10", "type": "percentage", "value": 10 },
  "minimumOrder": 50000, "meetsMinimum": true,
  "estimatedPreparationMinutes": 35,
  "unavailableItems": []          // plats passés en rupture : à signaler à l'écran
}
```

## Commandes

| Méthode | Route                    | Description                                |
| ------- | ------------------------ | ------------------------------------------ |
| POST    | `/orders/quote`          | Devis — mêmes montants que la commande     |
| POST    | `/orders`                | Créer (envoyer `Idempotency-Key`)          |
| GET     | `/orders?scope=active`   | Commandes en cours                         |
| GET     | `/orders?scope=past`     | Historique                                 |
| GET     | `/orders/:id`            | Détail                                     |
| GET     | `/orders/:id/tracking`   | Suivi + position du livreur                |
| POST    | `/orders/:id/cancel`     | Annuler (avant préparation, sous 10 min)   |

```jsonc
// POST /orders
{
  "type": "delivery",              // ou "pickup"
  "addressId": "…",                // obligatoire en livraison
  "paymentMethod": "orange_money",
  "promotionCode": "BIENVENUE10",  // facultatif
  "note": "Sans piment"            // facultatif
  // Sans "items", le panier du client est utilisé.
}
```

> N'envoyez **aucun** montant : `subtotal`, `total`… sont refusés (422).

## Paiement

| Méthode | Route                                  | Description                        |
| ------- | -------------------------------------- | ---------------------------------- |
| POST    | `/payments/order/:orderId/initiate`    | Déclencher un paiement mobile      |
| POST    | `/payments/:id/confirm`                | Confirmer (bac à sable)            |
| GET     | `/payments/order/:orderId`             | État du paiement                   |

En paiement à la livraison, il n'y a rien à déclencher.

## Suivi en temps réel

```dart
final socket = io('http://10.0.2.2:3000/realtime', {
  'transports': ['websocket'],
  'auth': {'token': accessToken},
});

socket.emit('order:subscribe', {'orderId': orderId});   // vérifié côté serveur

socket.on('order.status.updated', (data) { /* … */ });
socket.on('driver.location.updated', (data) { /* … */ });
socket.on('notification.created', (data) { /* … */ });
```

## Notifications

| Méthode | Route                          | Description                    |
| ------- | ------------------------------ | ------------------------------ |
| GET     | `/notifications`               | Liste paginée                  |
| GET     | `/notifications/unread-count`  | Badge                          |
| PATCH   | `/notifications/:id/read`      | Marquer comme lue              |
| PATCH   | `/notifications/read-all`      | Tout marquer comme lu          |
| DELETE  | `/notifications/:id`           | Supprimer                      |

Le **code de remise** arrive par ce canal, à l'attribution du livreur.

## Promotions

| Méthode | Route                      | Description                              |
| ------- | -------------------------- | ---------------------------------------- |
| GET     | `/promotions/active`       | Codes actuellement valables              |
| GET     | `/promotions/check/:code`  | Vérifier un code avant de commander      |

## Erreurs utiles

| Code                        | Signification                                    |
| --------------------------- | ------------------------------------------------ |
| `RESTAURANT_CLOSED`         | Hors horaires de service                         |
| `MINIMUM_ORDER_NOT_REACHED` | Panier sous le minimum                           |
| `MENU_ITEM_UNAVAILABLE`     | Un plat est passé en rupture                     |
| `OPTION_GROUP_REQUIRED`     | Un choix obligatoire manque                      |
| `ORDER_NOT_CANCELLABLE`     | Trop tard pour annuler                           |
| `PROMOTION_EXPIRED`         | Code périmé                                      |
| `ACCOUNT_SUSPENDED`         | Compte suspendu                                  |

Toutes les erreurs portent un `message` en français, directement affichable.
