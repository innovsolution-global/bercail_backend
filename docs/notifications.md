# Notifications et temps réel

Trois canaux pour un même événement :

| Canal          | Rôle                                             |
| -------------- | ------------------------------------------------ |
| **Base**       | Historique et badge « non lu »                   |
| **WebSocket**  | Mise à jour instantanée, application ouverte      |
| **Push (FCM)** | Application fermée                                |

Les services métier n'en connaissent qu'un seul point d'entrée :
`NotificationsService.notify()`. Une notification perdue ne fait jamais
échouer l'opération métier — c'est un choix explicite : une commande validée
reste validée même si le message ne part pas.

## Types

| Type                     | Destinataire | Déclencheur                          |
| ------------------------ | ------------ | ------------------------------------ |
| `order_created`          | Client, back-office | Commande passée                 |
| `order_confirmed`        | Client       | Confirmation par le restaurant       |
| `order_preparing`        | Client       | Mise en préparation                  |
| `order_ready`            | Client       | Commande prête                       |
| `driver_assigned`        | Client       | Attribution — **contient le code de remise** |
| `new_delivery`           | Livreur      | Nouvelle course                      |
| `order_out_for_delivery` | Client       | Commande partie                      |
| `delivery_started`       | Client       | Livreur en route                     |
| `delivery_arrived`       | Client       | Livreur arrivé                       |
| `order_delivered`        | Client       | Livraison confirmée                  |
| `order_cancelled`        | Client       | Annulation                           |
| `payment_received`       | Client       | Paiement confirmé ou remboursement   |
| `payment_failed`         | Client       | Paiement refusé                      |
| `promotion`              | Client       | Campagne                             |
| `security`               | Tous         | Suspension, changement de permissions |
| `admin_alert`            | Back-office  | Course refusée, livraison en échec   |
| `system`, `info`         | Tous         | Divers                               |

## Endpoints

Identiques pour les quatre rôles — chacun ne voit que les siennes.

| Méthode | Route                          | Description            |
| ------- | ------------------------------ | ---------------------- |
| GET     | `/notifications`               | Liste paginée          |
| GET     | `/notifications?unreadOnly=true`| Non lues seulement    |
| GET     | `/notifications/unread-count`  | Badge (appel léger)    |
| PATCH   | `/notifications/:id/read`      | Marquer comme lue      |
| PATCH   | `/notifications/read-all`      | Tout marquer comme lu  |
| DELETE  | `/notifications/:id`           | Supprimer              |

## WebSocket

**Adresse** : `ws://localhost:3000/realtime` (Socket.IO)

### Connexion

```ts
// React
const socket = io(`${env.wsUrl}/realtime`, {
  auth: { token: accessToken },
  transports: ['websocket'],
});
```

```dart
// Flutter
final socket = io('http://10.0.2.2:3000/realtime', <String, dynamic>{
  'transports': ['websocket'],
  'auth': {'token': accessToken},
});
```

Le jeton est vérifié à la connexion. Un compte inactif ou un jeton invalide
reçoit `unauthorized` puis est déconnecté.

### Salons

Le client ne choisit **jamais** son salon : il en demande un, le serveur
vérifie qu'il y a droit.

| Salon                | Qui le rejoint                              |
| -------------------- | ------------------------------------------- |
| `user:<id>`          | Automatique — ses notifications             |
| `role:<ROLE>`        | Automatique                                 |
| `back-office`        | Automatique pour `ADMIN` et `SUPER_ADMIN`   |
| `driver:<profileId>` | Automatique pour un `DRIVER`                |
| `order:<orderId>`    | Sur demande, **après vérification serveur** |

```ts
socket.emit('order:subscribe', { orderId }, (response) => {
  // { success: true } ou { success: false, message: 'Accès refusé.' }
});
socket.emit('order:unsubscribe', { orderId });
```

Sont autorisés dans le salon d'une commande : son client, le livreur assigné,
et le back-office. Personne d'autre.

### Événements

| Événement                  | Destinataires                          | Contenu                      |
| -------------------------- | -------------------------------------- | ---------------------------- |
| `connected`                | Émetteur                               | `{ userId, role }`           |
| `order.created`            | back-office, client                     | Résumé de commande           |
| `order.updated`            | back-office, client                     | Résumé de commande           |
| `order.status.updated`     | back-office, client, livreur assigné    | Résumé + `status`            |
| `delivery.assigned`        | livreur, back-office, client            | Course                       |
| `delivery.status.updated`  | back-office, client, livreur            | Course + `status`            |
| `driver.location.updated`  | salon de la commande, back-office       | Position                     |
| `driver.status.updated`    | back-office                             | En ligne / disponible        |
| `payment.updated`          | back-office, client                     | Paiement                     |
| `notification.created`     | destinataire uniquement                 | Notification                 |
| `system.alert`             | SUPER_ADMIN                             | Alerte de sécurité           |

### Sonde applicative

```ts
socket.emit('ping', (response) => console.log(response)); // { event: 'pong', at: '…' }
```

Utile sur réseau mobile pour distinguer « socket fermé » de « socket ouvert
mais silencieux ».

## Montée en charge

Avec plusieurs instances de l'API, un événement émis par l'instance A doit
atteindre un client connecté à l'instance B. C'est le rôle de
`@socket.io/redis-adapter`, branché au démarrage.

Sans Redis, le temps réel fonctionne en mode **instance unique** — suffisant
en développement, et signalé dans les logs.

## Notifications push

`PushService` est une abstraction volontairement minimale : « envoyer ce
message à cet utilisateur ». Le pilote par défaut (`noop`) journalise, ce qui
permet de développer et tester tout le parcours sans compte Firebase.

Pour brancher FCM :

1. `PUSH_DRIVER=fcm` et renseigner `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`,
   `FCM_PRIVATE_KEY` ;
2. implémenter `PushService.deliver` (envoi par lot vers l'API FCM v1) ;
3. supprimer de `device_tokens` les jetons rejetés (`UNREGISTERED`), sinon la
   table se remplit d'appareils morts.

Aucun appelant n'a à changer.

### Enregistrer un appareil

```http
POST /api/v1/auth/devices
{ "token": "<jeton FCM>", "platform": "android" }
```

Le jeton peut aussi être transmis à la connexion, dans `deviceToken`.
`DELETE /auth/devices/:token` le retire — à faire à la déconnexion.
