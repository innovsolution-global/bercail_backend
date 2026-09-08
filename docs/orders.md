# Commandes

## Machine à états

```
  PENDING ──► CONFIRMED ──► PREPARING ──► READY ──┬──► ASSIGNED ──► OUT_FOR_DELIVERY ──► DELIVERED
     │            │             │           │     │        │                │
     └────────────┴─────────────┴───────────┴─────┴────────┴────────────────┴──► CANCELLED
                                            │
                                            └──► DELIVERED   (retrait sur place uniquement)
```

Règles appliquées par `assertTransition` :

- aucune étape ne se saute ;
- aucun retour en arrière ;
- `DELIVERED` et `CANCELLED` sont **terminaux** ;
- une commande en livraison ne peut pas passer de `READY` à `DELIVERED` sans
  livreur ;
- une commande à emporter ne peut pas être assignée à un livreur.

### Qui déclenche quoi

| Transition                        | Auteur                | Exigence                                     |
| --------------------------------- | --------------------- | -------------------------------------------- |
| → `CONFIRMED`, `PREPARING`, `READY` | Back-office         | `ORDERS_UPDATE_STATUS`                        |
| → `ASSIGNED`                      | Back-office           | `ORDERS_ASSIGN_DRIVER` (via `/orders/:id/assign`) |
| → `OUT_FOR_DELIVERY`              | **Système**           | Déclenché par la récupération du livreur      |
| → `DELIVERED`                     | **Système**           | Déclenché par la validation du code de remise |
| → `CANCELLED` (client)            | CUSTOMER              | Statut `PENDING`/`CONFIRMED` et < 10 min      |
| → `CANCELLED` (restaurant)        | Back-office           | `ORDERS_CANCEL` — audité                      |

Le livreur ne pilote jamais la commande directement : il fait avancer **sa
livraison**, et le service de livraison répercute.

## Calcul du prix — la règle centrale

> Ni Flutter ni React n'envoient de montant. Le serveur relit les prix en base
> et recalcule tout.

```
Pour chaque ligne :
    prix unitaire  =  promoPrice ?? price          (relu en base)
    suppléments    =  Σ extraPrice des options     (relus en base)
    total ligne    =  (prix unitaire + suppléments) × quantité

sous-total   =  Σ totaux de ligne
frais        =  0 si retrait
                0 si sous-total ≥ seuil de gratuité
                sinon frais du restaurant
remise       =  selon la promotion, plafonnée
total        =  max(0, sous-total + frais − remise)
```

Le `CreateOrderDto` ne comporte **aucun** champ de montant. Avec
`forbidNonWhitelisted: true`, en envoyer un renvoie `422`.

Le devis (`POST /orders/quote`) et la création utilisent le même moteur : le
prix affiché avant validation est celui qui sera facturé. Le calcul est refait
**dans la transaction** de création — entre l'affichage du panier et la
validation, un plat a pu passer en rupture ou changer de prix.

### Validations à la création

| Contrôle                          | Erreur                                   |
| --------------------------------- | ---------------------------------------- |
| Restaurant ouvert                 | `RESTAURANT_CLOSED`                      |
| Mode de commande activé           | `DELIVERY_DISABLED` / `PICKUP_DISABLED`  |
| Panier non vide                   | `CART_EMPTY`                             |
| Plats disponibles                 | `MENU_ITEM_UNAVAILABLE`                  |
| Options valides et disponibles    | `MENU_OPTION_INVALID`                    |
| Groupes obligatoires renseignés   | `OPTION_GROUP_REQUIRED`                  |
| Minimum de commande atteint       | `MINIMUM_ORDER_NOT_REACHED`              |
| Adresse fournie et **au client**  | `ADDRESS_REQUIRED`                       |
| Moyen de paiement activé          | `PAYMENT_METHOD_DISABLED`                |

## Ce que la commande fige

Une ligne de commande copie le **nom**, l'**image** et le **prix** pratiqués
au moment de l'achat ; l'adresse est copiée dans `addressSnapshot`. Modifier
un prix ou déménager ne réécrit donc pas l'historique.

## Idempotence

```http
POST /api/v1/orders
Idempotency-Key: 8f2c1e4a-…
```

- même clé + même corps → la première réponse est **rejouée** ;
- même clé + corps différent → `409 IDEMPOTENCY_CONFLICT` ;
- clé en cours de traitement → `409 IDEMPOTENCY_IN_PROGRESS` ;
- échec de l'opération → la clé est libérée, le client peut réessayer.

Indispensable sur un réseau mobile : sans cela, une requête partie deux fois
débite deux fois et fait préparer deux repas.

## Effets d'une livraison confirmée

Dans la même transaction :

- `deliveredAt` renseigné ;
- paiement à la livraison → statut `PAID` + événement ;
- `totalSpent` du client incrémenté ;
- fidélité : 1 point par tranche de 10 000 GNF ;
- statistiques du livreur mises à jour (courses, distance, durée).

## Effets d'une annulation

- livraison en cours close en `FAILED`, livreur libéré ;
- coupon consommé **rendu** (`usageCount` décrémenté, `CouponUsage` supprimé) ;
- paiement en attente marqué `FAILED` ;
- compteurs client corrigés ;
- audit avec motif obligatoire.

## Endpoints

### Client

| Méthode | Route                    | Description                              |
| ------- | ------------------------ | ---------------------------------------- |
| POST    | `/orders/quote`          | Devis — mêmes montants que la commande   |
| POST    | `/orders`                | Créer (idempotent)                       |
| GET     | `/orders?scope=active`   | Ses commandes en cours                   |
| GET     | `/orders?scope=past`     | Son historique                           |
| GET     | `/orders/:id`            | Détail (appartenance vérifiée)           |
| GET     | `/orders/:id/tracking`   | Suivi, avec position du livreur          |
| POST    | `/orders/:id/cancel`     | Annuler, sous conditions                 |

### Panier

| Méthode | Route                    | Description                                    |
| ------- | ------------------------ | ---------------------------------------------- |
| GET     | `/cart`                  | Panier, prix recalculés à chaque appel         |
| POST    | `/cart/items`            | Ajouter (les lignes identiques fusionnent)     |
| PATCH   | `/cart/items/:itemId`    | Modifier (`quantity: 0` retire la ligne)       |
| DELETE  | `/cart/items/:itemId`    | Retirer une ligne                              |
| DELETE  | `/cart`                  | Vider                                          |

Le panier ne stocke aucun montant : uniquement des plats, des options et des
quantités. Si le restaurant change un prix, le panier suit.

### Back-office

| Méthode | Route                        | Permission              |
| ------- | ---------------------------- | ----------------------- |
| GET     | `/orders`                    | `ORDERS_READ`           |
| GET     | `/orders/export`             | `ORDERS_EXPORT`         |
| GET     | `/orders/:id`                | `ORDERS_READ`           |
| PATCH   | `/orders/:id/status`         | `ORDERS_UPDATE_STATUS`  |
| POST    | `/orders/:id/cancel`         | `ORDERS_CANCEL`         |
| POST    | `/orders/:orderId/assign`    | `ORDERS_ASSIGN_DRIVER`  |
| GET     | `/orders/:orderId/assignable-drivers` | `ORDERS_ASSIGN_DRIVER` |

Filtres : `status`, `paymentStatus`, `type`, `driverId`, `customerId`,
`from`, `to`, `search` (référence, nom ou téléphone du client), `sortBy`,
`sortOrder`, `page`, `limit`.

## Événements temps réel

| Événement               | Destinataires                          |
| ----------------------- | -------------------------------------- |
| `order.created`         | back-office, client                    |
| `order.status.updated`  | back-office, client, livreur assigné    |
| `order.updated`         | back-office, client                    |
