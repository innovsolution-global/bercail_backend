# API livreur (Flutter)

Base : `http://localhost:3000/api/v1` — rôle `DRIVER`.

## Un livreur ne s'inscrit pas

Son compte est créé par un `ADMIN` ou un `SUPER_ADMIN` (voir
[admin-api.md](admin-api.md)). À la première connexion, selon le mode choisi :

- **mot de passe temporaire** : le compte est actif, mais son jeton n'ouvre que
  `/auth/me`, `/auth/change-password` et `/auth/logout` tant que le mot de
  passe n'a pas été changé. Toute autre route répond
  `403 PASSWORD_CHANGE_REQUIRED` ;
- **lien d'activation** : le compte est `PENDING`, le livreur choisit son mot
  de passe via `POST /auth/activate`.

```
403 PASSWORD_CHANGE_REQUIRED
        │
        └──► POST /auth/change-password  { currentPassword, newPassword }
                     │
                     └──► accès complet (les autres sessions sont fermées)
```

## Journée type

```
connexion → en ligne → réception d'une course → accepter → restaurant →
récupérer → route (GPS) → arrivée → code du client → livrée
```

## Profil et disponibilité

| Méthode | Route                    | Description                                 |
| ------- | ------------------------ | ------------------------------------------- |
| GET     | `/auth/me`               | Profil, avec le bloc `driver`               |
| GET     | `/driver/dashboard`      | Courses du jour, gains du jour, statistiques |
| GET     | `/driver/stats`          | Statistiques détaillées                      |
| PATCH   | `/driver/availability`   | En ligne / hors ligne                        |

```jsonc
// PATCH /driver/availability
{ "isOnline": true, "isAvailable": true }
```

> Un livreur qui a une course en cours ne peut pas se déclarer disponible :
> la disponibilité est **déduite** du travail en cours. Et sans nouvelle
> depuis 30 minutes, le serveur le repasse hors ligne — sans quoi le
> back-office lui attribuerait des courses qu'il ne verrait jamais.

## Courses

| Méthode | Route                                        | Description                 |
| ------- | -------------------------------------------- | --------------------------- |
| GET     | `/driver/deliveries?scope=active`            | Courses en cours            |
| GET     | `/driver/deliveries?scope=history`           | Courses terminées           |
| GET     | `/driver/deliveries/:id`                     | Détail                      |
| POST    | `/driver/deliveries/:id/accept`              | Accepter                    |
| POST    | `/driver/deliveries/:id/decline`             | Refuser (avant acceptation) |
| POST    | `/driver/deliveries/:id/arrived-restaurant`  | Arrivé au restaurant        |
| POST    | `/driver/deliveries/:id/pickup`              | Commande récupérée          |
| POST    | `/driver/deliveries/:id/start`               | En route                    |
| POST    | `/driver/deliveries/:id/arrived`             | Arrivé chez le client       |
| POST    | `/driver/deliveries/:id/complete`            | Remise confirmée par code   |
| POST    | `/driver/deliveries/:id/fail`                | Échec de livraison          |

Aucune de ces routes ne prend d'identifiant de livreur : l'identité vient du
jeton. Une course qui ne lui est pas attribuée renvoie `403`.

### Ce que reçoit le livreur

```jsonc
{
  "id": "…",
  "orderReference": "BRC-260903-K7M2",
  "status": "picked_up",
  "customer": { "firstName": "Mariama", "phone": "+224620112201" },
  "address": {
    "street": "Rue KA 021", "district": "Kaloum",
    "latitude": 9.509, "longitude": -13.712,
    "instructions": "Portail bleu, sonner deux fois."
  },
  "items": [ { "name": "Poulet braisé entier", "quantity": 1 } ],
  "itemsCount": 1,
  "amountToCollect": 160000,     // 0 si la commande est déjà payée
  "paymentMethod": "cash_on_delivery",
  "distanceKm": 3.2,
  "estimatedArrivalAt": "2026-09-03T15:05:00.000Z"
}
```

Volontairement absent : l'e-mail du client, son historique, le détail des
prix. Le livreur reçoit ce dont il a besoin pour travailler, rien de plus.

## Confirmation de remise

```jsonc
// POST /driver/deliveries/:id/complete
{ "code": "4271", "latitude": 9.512, "longitude": -13.708 }
```

Le code est la **seule** preuve acceptée : sans lui, la course ne peut pas
être marquée livrée, même par le livreur assigné.

| Réponse                     | Signification                                      |
| --------------------------- | -------------------------------------------------- |
| `200`                       | Course et commande livrées                          |
| `400 OTP_INVALID`           | Code erroné — le nombre de tentatives restantes est indiqué |
| `400 OTP_EXPIRED`           | Code périmé — le client peut en régénérer un       |
| `429 OTP_TOO_MANY_ATTEMPTS` | Trop d'essais — contacter le restaurant            |
| `409`                       | Course déjà confirmée                               |

Si le livreur saisit le code sans avoir déclaré son arrivée, le serveur
l'enregistre pour lui plutôt que de refuser la remise.

## Géolocalisation

```jsonc
// POST /driver/location   — toutes les 10 à 30 secondes pendant une course
{ "latitude": 9.512, "longitude": -13.708, "accuracy": 8, "heading": 145, "speed": 9 }
```

`deliveryId` est facultatif : sans lui, la position est rattachée à la course
en cours. Le serveur horodate lui-même.

Conseils d'intégration :

- n'émettre **que** pendant une course active — c'est la batterie du livreur ;
- espacer à 30 s hors mouvement ;
- mettre en file et rejouer les points en cas de coupure réseau.

## Refus et échec

Deux gestes différents :

| Geste     | Quand                        | Effet                                                     |
| --------- | ---------------------------- | --------------------------------------------------------- |
| **Refus** | Avant acceptation            | La commande retourne dans la file, le back-office est notifié |
| **Échec** | Après acceptation            | Course close en `FAILED`, motif obligatoire, alerte back-office |

```jsonc
// POST /driver/deliveries/:id/decline
{ "reason": "Trop loin de ma zone" }

// POST /driver/deliveries/:id/fail
{ "reason": "Client injoignable après 3 appels" }
```

## Temps réel

```dart
final socket = io('http://10.0.2.2:3000/realtime', {
  'transports': ['websocket'],
  'auth': {'token': accessToken},
});

socket.on('delivery.assigned', (data) { /* nouvelle course */ });
socket.on('delivery.status.updated', (data) { /* … */ });
socket.on('notification.created', (data) { /* … */ });
```

Le livreur rejoint automatiquement son salon : il ne reçoit que **ses**
courses.

## Notifications

Mêmes routes que pour le client (`/notifications`). Types reçus :
`new_delivery`, `order_cancelled`, `security`.

## Recherche

`GET /search?q=BRC-2609` — limitée à **ses** courses.
