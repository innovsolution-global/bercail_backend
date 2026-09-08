# Architecture

## Le problème posé

Quatre utilisateurs très différents — un client, un livreur, un gestionnaire,
un super administrateur — travaillent sur les **mêmes données** (une commande,
une livraison, un paiement) avec des droits opposés. La tentation classique
est d'écrire quatre API. C'est exactement ce qu'il ne faut pas faire : quatre
implémentations divergent, et la divergence sur un calcul de prix ou une
transition de statut devient un bug silencieux qui coûte de l'argent.

Le choix retenu : **une seule logique métier, quatre périmètres
d'autorisation**.

## Vue d'ensemble

```
   Flutter                                    React
┌───────────┬───────────┐             ┌───────────┬─────────────┐
│ CUSTOMER  │  DRIVER   │             │  ADMIN    │ SUPER_ADMIN │
└─────┬─────┴─────┬─────┘             └─────┬─────┴──────┬──────┘
      │           │                         │            │
      └───────────┴──────────┬──────────────┴────────────┘
                             │  HTTPS /api/v1  +  WebSocket
                             ▼
              ┌──────────────────────────────┐
              │        LE BERCAIL API        │
              │                              │
              │  Guards  →  Contrôleurs      │
              │             Services métier  │
              │             Mappers          │
              └───────┬──────────┬───────────┘
                      │          │
          ┌───────────┘          └────────────┐
          ▼                                   ▼
   PostgreSQL (Prisma)              Redis (cache, débit, bus WS)
```

## Découpage

Chaque module métier suit la même forme :

```
module/
├── dto/                 contrat d'entrée (validé, strict)
├── module.service.ts    logique métier — unique pour les 4 rôles
├── module.controller.ts routes, rôles, permissions, documentation
├── module.mapper.ts     sérialisation (jamais de secret en sortie)
└── module.module.ts     assemblage
```

Les modules **globaux** — base, Redis, audit, notifications, temps réel,
réglages, RBAC — sont disponibles partout sans import explicite, parce que
presque tous les modules métier en dépendent.

## Les cinq barrières d'autorisation

| # | Barrière              | Où                                    | Rôle                                              |
|---|-----------------------|---------------------------------------|---------------------------------------------------|
| 1 | Limitation de débit   | `ThrottlerBehindProxyGuard` (global)  | Freiner les attaques automatisées                 |
| 2 | Authentification      | `JwtAuthGuard` (global)               | Identifier, en rechargeant le compte depuis la base |
| 3 | Mot de passe temporaire | `PasswordChangeGuard` (global)      | Bloquer un compte qui doit encore changer son mot de passe |
| 4 | Rôle                  | `RolesGuard` (global)                 | Séparer les quatre mondes                         |
| 5 | Permission            | `PermissionsGuard` (global)           | Affiner à l'intérieur du back-office              |
| 6 | Appartenance          | Services métier                       | « Cette commande est-elle la sienne ? »           |

L'appartenance ne peut pas être un guard générique : elle dépend de la
ressource. Elle est donc vérifiée dans le service, au plus près de la donnée,
et les signatures des méthodes la rendent difficile à oublier —
`AddressesService.list(userId)` n'accepte tout simplement pas de lister les
adresses de quelqu'un d'autre.

## Le flux d'une commande

```
Client                Backend                         Back-office      Livreur
  │                      │                                  │             │
  ├─ POST /orders ──────►│                                  │             │
  │                      ├─ recalcule TOUS les montants     │             │
  │                      ├─ vérifie ouverture, minimum      │             │
  │                      ├─ transaction : commande +        │             │
  │                      │   articles + paiement + histo    │             │
  │                      ├─ WebSocket order.created ───────►│ (temps réel)│
  │◄─ 201 + détail ──────┤                                  │             │
  │                      │◄─ PATCH /orders/:id/status ──────┤             │
  │◄─ notification ──────┤   (confirmed → preparing → ready)│             │
  │                      │◄─ POST /orders/:id/assign ───────┤             │
  │◄─ code de remise ────┤   génère l'OTP, prévient le livreur ──────────►│
  │                      │                                  │             │
  │                      │◄─ POST /driver/deliveries/:id/pickup ──────────┤
  │◄─ « en route » ──────┤   la commande passe out_for_delivery           │
  │                      │◄─ POST /driver/location (GPS) ─────────────────┤
  │◄─ position ──────────┤   diffusée au salon de la commande             │
  │                      │◄─ POST …/complete { code } ────────────────────┤
  │◄─ « livrée » ────────┤   OTP vérifié → livraison + commande livrées   │
```

Point important : le livreur ne pilote pas la commande, il pilote **sa
livraison**. C'est `DeliveriesService` qui répercute sur la commande, via
`OrdersService.applySystemTransition` — laquelle repasse par la machine à
états. Une transition impossible reste impossible, même déclenchée par le
système.

## Décisions de conception

### Les prix sont recalculés, jamais reçus

`PricingService` est la seule autorité sur les montants. Le DTO de création de
commande ne contient ni `subtotal`, ni `total` : avec
`forbidNonWhitelisted: true`, un client qui en enverrait un reçoit un 422.

Le devis (`POST /orders/quote`) et la commande utilisent le **même** moteur :
le prix affiché avant paiement est celui qui sera facturé. Et le calcul est
refait **dans la transaction** de création, parce qu'entre l'affichage du
panier et la validation, un plat a pu passer en rupture.

### Les données de commande sont figées

Une ligne de commande copie le nom, l'image et le prix pratiqués au moment de
l'achat. L'adresse est copiée dans `addressSnapshot`. Conséquence : changer un
prix ou déménager ne réécrit pas l'histoire. C'est une dénormalisation
volontaire, et c'est ce qui rend l'historique fiable.

### Les compteurs sont maintenus, pas recalculés

`ordersCount`, `totalSpent`, `completedDeliveries` sont mis à jour dans les
transactions métier. Afficher un tableau de bord ne doit pas agréger des
millions de lignes. Les statistiques de période, elles, sont bien calculées
en base (`groupBy`, `date_trunc`) — mais jamais en mémoire applicative.

### Redis est un confort, pas une dépendance vitale

Cache, compteurs de débit, bus WebSocket : tout est utile, rien n'est vital.
Si Redis tombe, `RedisService` bascule en mode dégradé et l'API continue de
servir. Un restaurant ne doit pas cesser de vendre parce qu'un cache est
indisponible.

### Le temps réel ne remplace jamais la base

Un événement WebSocket est émis **après** la transaction, et son échec est
attrapé. La vérité est en base ; le socket ne fait que l'annoncer plus vite.

### Deux chemins, un seul contrôleur

Le back-office React existait avant ce backend et appelait déjà
`/administrators`, `/menu/items`, `/dashboard`. Le contrat d'API, lui, décrit
`/super-admin/admins`, `/menu-items`, `/admin/dashboard`. Plutôt que de
choisir — et de casser l'un des deux —, les contrôleurs déclarent les deux
chemins :

```ts
@Controller(['administrators', 'super-admin/admins'])
```

Une seule implémentation, donc aucun risque de divergence.

## Concurrence

| Situation                              | Protection                                                        |
|----------------------------------------|-------------------------------------------------------------------|
| Double soumission de commande          | `Idempotency-Key` + contrainte d'unicité                          |
| Deux gestionnaires attribuent en même temps | Transaction + relecture de l'état du livreur dans la transaction |
| Plat en rupture pendant le paiement    | Prix et disponibilité revérifiés dans la transaction              |
| Double paiement                        | Statut vérifié + `Idempotency-Key`                                |
| Conflit de sérialisation PostgreSQL    | `PrismaService.transaction` rejoue automatiquement (P2034)         |
| Rejeu d'un code de livraison           | OTP à usage unique, marqué consommé                               |

## Points d'extension prévus

- **Stockage S3** : implémenter `StorageService.putObjectS3`, aucun appelant à
  modifier.
- **Push FCM** : implémenter `PushService.deliver`, aucun appelant à modifier.
- **Paiement réel** : `PaymentsService.confirm` contient déjà la logique
  métier ; il reste à l'appeler depuis un webhook signé de l'opérateur.
- **Observabilité** : les requêtes portent un `requestId` de bout en bout ;
  brancher Sentry ou Prometheus ne demande qu'un intercepteur supplémentaire.
- **Multi-restaurant** : `Restaurant` est déjà une table, pas une constante.
