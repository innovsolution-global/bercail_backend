# Livraisons

## Machine à états

```
 ASSIGNED ──► ACCEPTED ──┬──► ARRIVED_AT_RESTAURANT ──► PICKED_UP ──┬──► IN_TRANSIT ──┐
                         │                                          │                  │
                         └──────────────────────────────────────────┘                  ▼
                                                                          ARRIVED_AT_CUSTOMER
                                                                                       │
                                                                            code OTP ──► DELIVERED
 (n'importe quelle étape active) ─────────────────────────────────────────────────────► FAILED
```

Deux raccourcis sont tolérés parce qu'ils correspondent au terrain : un
livreur déjà sur place enchaîne *accepter → récupérer*, et un trajet court se
résume à *récupérer → arrivé*.

### Répercussion sur la commande

| Étape de livraison | Commande                |
| ------------------ | ----------------------- |
| `PICKED_UP`        | → `OUT_FOR_DELIVERY`    |
| `DELIVERED`        | → `DELIVERED`           |

Le livreur ne touche jamais directement au statut de la commande.

## Attribution

`POST /api/v1/orders/:orderId/assign` — permission `ORDERS_ASSIGN_DRIVER`.

Dans une seule transaction :

1. le livreur est revérifié (actif, en ligne, non suspendu) — entre
   l'affichage de la liste et le clic, il a pu se déconnecter ;
2. la course est créée ou réattribuée ;
3. le livreur passe indisponible, l'ancien est libéré s'il n'a plus rien ;
4. la commande passe `ASSIGNED` si elle était `READY` (une pré-attribution
   pendant la préparation ne change pas son statut) ;
5. le **code de remise** est généré ;
6. la distance et l'heure d'arrivée estimée sont calculées.

Hors transaction : notification au livreur, notification du code au client,
diffusion temps réel, audit.

### Choix du livreur

`GET /drivers/assignable?orderId=…` renvoie les livreurs éligibles, triés par :

1. **charge** (moins de courses actives d'abord) ;
2. **proximité** de l'adresse de livraison (haversine) ;
3. **note**.

Le service propose, le gestionnaire décide. `DriverAssignmentService.suggest`
existe pour une attribution automatique si vous la souhaitez plus tard.

### Refus d'une course

Possible **tant que la course n'a pas été acceptée**. La commande retourne
dans la file (`READY`), le livreur est libéré, le back-office est notifié, et
le refus est audité. Passé l'acceptation, il faut déclarer un échec — ce qui
n'est pas la même chose et ne se traite pas pareil.

## Code de remise (OTP)

C'est la preuve que le repas a bien été remis à la bonne personne.

```
Attribution ──► code à 4 chiffres généré
                 │
                 ├─ condensat SHA-256 en base   (jamais en clair)
                 └─ envoyé au client par notification
                              │
                    Le client le donne au livreur
                              │
            POST /driver/deliveries/:id/complete { code }
                              │
                   ┌──────────┴──────────┐
                 valide                invalide
                   │                      │
        livraison + commande        tentative comptée
             DELIVERED              (5 maximum)
```

Protections :

| Risque              | Protection                                                     |
| ------------------- | -------------------------------------------------------------- |
| Vol du code en base | Stocké en condensat SHA-256                                     |
| Force brute         | 5 tentatives en base + compteur Redis (double barrière)          |
| Rejeu               | Marqué consommé (`verifiedAt`) — un second usage échoue          |
| Code périmé         | Expiration configurable (60 min par défaut)                      |
| Fuite par le temps  | Comparaison sur condensats                                       |

Le code est vérifié **avant** toute écriture : une tentative ratée ne modifie
pas l'état de la course.

Si le client n'a pas reçu la notification, le client lui-même ou le
back-office peut en régénérer un.

## Géolocalisation

`POST /api/v1/driver/location` — appelé régulièrement pendant une course.

```jsonc
{ "latitude": 9.512, "longitude": -13.708, "accuracy": 8, "heading": 145, "speed": 9,
  "deliveryId": "…" }   // facultatif : sinon rattaché à la course en cours
```

Deux écritures :

- **historique** (`driver_locations`) — pour rejouer un trajet ou arbitrer un
  litige ;
- **dernière position** sur le profil du livreur — lecture immédiate, sans
  agrégat.

Le serveur horodate lui-même : un téléphone à l'heure fausse ne doit pas
fausser le suivi.

### Qui voit la position

| Demandeur                     | Accès                                        |
| ----------------------------- | -------------------------------------------- |
| Client propriétaire           | ✅ tant que la course est en cours            |
| Client propriétaire, livrée   | ❌ — la position ne le regarde plus           |
| Autre client                  | ❌                                            |
| Livreur assigné               | ✅                                            |
| Back-office (`DELIVERIES_TRACK`) | ✅ y compris la trace complète             |

La diffusion temps réel n'atteint que le **salon de la commande** et le
back-office : un client sans course active ne reçoit rien.

### Rétention

Les positions sont purgées au bout de **30 jours** (tâche planifiée).
Conserver indéfiniment les déplacements d'une personne n'a aucune
justification métier une fois la course archivée.

## Endpoints

### Espace livreur

Aucune route ne prend d'identifiant de livreur : le livreur ne peut agir que
sur lui-même.

| Méthode | Route                                          | Description                    |
| ------- | ---------------------------------------------- | ------------------------------ |
| GET     | `/driver/dashboard`                            | Journée, gains, disponibilité  |
| GET     | `/driver/stats`                                | Statistiques                   |
| PATCH   | `/driver/availability`                         | En ligne / hors ligne          |
| GET     | `/driver/deliveries?scope=active\|history`     | Ses courses                    |
| GET     | `/driver/deliveries/:id`                       | Détail d'une course            |
| POST    | `/driver/deliveries/:id/accept`                | Accepter                       |
| POST    | `/driver/deliveries/:id/decline`               | Refuser (avant acceptation)    |
| POST    | `/driver/deliveries/:id/arrived-restaurant`    | Arrivé au restaurant           |
| POST    | `/driver/deliveries/:id/pickup`                | Commande récupérée             |
| POST    | `/driver/deliveries/:id/start`                 | En route                       |
| POST    | `/driver/deliveries/:id/arrived`               | Arrivé chez le client          |
| POST    | `/driver/deliveries/:id/complete`              | Remise confirmée par code      |
| POST    | `/driver/deliveries/:id/fail`                  | Échec de livraison             |
| POST    | `/driver/location`                             | Transmettre sa position        |

Un livreur ne peut pas se déclarer disponible tant qu'il a une course active :
la disponibilité est **déduite** du travail en cours, pas déclarée.

### Back-office

| Méthode | Route                        | Permission           |
| ------- | ---------------------------- | -------------------- |
| GET     | `/deliveries`                | `DELIVERIES_READ`    |
| GET     | `/deliveries/active`         | `DELIVERIES_TRACK`   |
| GET     | `/deliveries/:id`            | `DELIVERIES_READ`    |
| GET     | `/deliveries/:id/trail`      | `DELIVERIES_TRACK`   |
| PATCH   | `/deliveries/:id/status`     | `DELIVERIES_UPDATE`  |
| POST    | `/deliveries/:id/fail`       | `DELIVERIES_UPDATE`  |

## Ce que voit le livreur

Volontairement restreint à ce dont il a besoin :

```jsonc
{
  "orderReference": "BRC-260903-K7M2",
  "status": "picked_up",
  "customer": { "firstName": "Mariama", "phone": "+224620112201" },
  "address": { "street": "…", "district": "Kaloum", "latitude": 9.51, "longitude": -13.71,
               "instructions": "Portail bleu, sonner deux fois." },
  "items": [{ "name": "Poulet braisé entier", "quantity": 1 }],
  "amountToCollect": 160000,   // 0 si la commande est déjà payée
  "distanceKm": 3.2
}
```

Pas d'e-mail, pas d'historique, pas de montant détaillé des autres commandes.
Le montant à encaisser n'apparaît que pour un paiement à la livraison.

## Événements temps réel

| Événement                  | Destinataires                        |
| -------------------------- | ------------------------------------ |
| `delivery.assigned`        | livreur concerné, back-office, client |
| `delivery.status.updated`  | back-office, client, livreur          |
| `driver.location.updated`  | salon de la commande, back-office     |
| `driver.status.updated`    | back-office                           |
