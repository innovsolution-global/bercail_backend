# Paiements

## Moyens acceptés

| Méthode              | Encaissement                              |
| -------------------- | ----------------------------------------- |
| `cash_on_delivery`   | À la remise du repas, par le livreur       |
| `orange_money`       | Mobile money, confirmation asynchrone      |
| `mtn_money`          | Mobile money, confirmation asynchrone      |
| `mobile_money`       | Générique                                  |
| `card`               | Désactivé par défaut                       |

Un moyen désactivé dans les paramètres système est refusé **à la création de
commande** (`PAYMENT_METHOD_DISABLED`), pas plus tard.

## Cycle de vie

```
PENDING ──► PROCESSING ──► PAID ──► REFUNDED
   │             │
   └─────────────┴──────► FAILED
```

Un paiement est créé **en même temps que la commande**, dans la même
transaction : il n'existe pas de commande sans paiement associé.

### Paiement à la livraison

Rien à déclencher. L'encaissement a lieu à la validation du code de remise :
la commande passe `DELIVERED` et le paiement `PAID` dans la même transaction.

### Mobile money

```
Client                     Backend                        Opérateur
  │                           │                               │
  ├─ POST …/initiate ────────►│                               │
  │   { phone }               ├─ montant relu SUR LA COMMANDE │
  │                           ├─ numéro tronqué : 622****45   │
  │                           ├─ statut PROCESSING            │
  │                           ├─ demande de débit ───────────►│
  │◄─ instructions ───────────┤                               │
  │                           │◄─ confirmation (webhook) ─────┤
  │                           ├─ statut PAID                  │
  │◄─ notification + WS ──────┤                               │
```

> Le montant vient **toujours** de la commande. `InitiatePaymentDto` ne
> contient aucun champ de montant.

En environnement de démonstration (`PAYMENT_SANDBOX=true`), l'opérateur est
simulé : `POST /payments/:id/confirm` joue son rôle et permet de dérouler le
parcours complet sans contrat marchand. En production, cette logique est
appelée depuis un webhook signé — `PaymentsService.confirm` est déjà écrit
pour cela.

## Remboursement

Opération sensible : permission `PAYMENTS_REFUND`, motif obligatoire, audit
systématique.

Règles :

- seul un paiement `PAID` est remboursable ;
- une seule fois (`PAYMENT_NOT_REFUNDABLE` au second essai) ;
- le `totalSpent` du client est corrigé — un montant remboursé n'est plus une
  dépense ;
- la commande passe en `REFUNDED`, le client est notifié.

## Données sensibles

| Donnée                      | Traitement                                  |
| --------------------------- | ------------------------------------------- |
| Numéro mobile money         | Stocké **tronqué** (`622****45`)             |
| Référence opérateur         | Conservée pour le rapprochement              |
| Données bancaires complètes | **Jamais** stockées                          |
| Secrets d'API               | Uniquement dans l'environnement              |

Aucun secret de paiement n'apparaît dans les journaux.

## Idempotence

`POST /payments/order/:orderId/initiate` accepte `Idempotency-Key` :
un double appui sur « Payer » ne déclenche qu'un seul débit.

## Endpoints

| Méthode | Route                                  | Accès                              |
| ------- | -------------------------------------- | ---------------------------------- |
| GET     | `/payments`                            | `PAYMENTS_READ`                    |
| GET     | `/payments/export`                     | `PAYMENTS_EXPORT`                  |
| GET     | `/payments/:id`                        | Client propriétaire ou back-office |
| GET     | `/payments/order/:orderId`             | Client propriétaire ou back-office |
| POST    | `/payments/order/:orderId/initiate`    | CUSTOMER (idempotent)              |
| POST    | `/payments/:id/confirm`                | Client ou back-office (bac à sable)|
| POST    | `/payments/:id/fail`                   | Back-office                        |
| POST    | `/payments/:id/refund`                 | `PAYMENTS_REFUND` — audité         |

Filtres : `status`, `method`, `from`, `to`, `search` (transaction, référence
de commande, nom du client).

## Réponse

```jsonc
{
  "id": "…",
  "transactionRef": "TRX-260903-9F3KQ2",
  "orderReference": "BRC-260903-K7M2",
  "customerName": "Mariama Diallo",
  "method": "orange_money",
  "status": "paid",
  "amount": 160000,          // entier, GNF
  "fee": 1600,
  "maskedAccount": "622****01",
  "paidAt": "2026-09-03T14:32:10.000Z",
  "history": [
    { "label": "Paiement initialisé", "status": "pending",    "at": "…" },
    { "label": "Paiement confirmé",   "status": "paid",       "at": "…" }
  ]
}
```

## Brancher un opérateur réel

1. Renseigner `ORANGE_MONEY_*` / `MTN_MONEY_*` et passer
   `PAYMENT_SANDBOX=false`.
2. Dans `PaymentsService.doInitiate`, remplacer la simulation par l'appel
   d'API de l'opérateur et stocker sa référence dans `providerRef`.
3. Exposer un contrôleur de webhook qui **vérifie la signature** puis appelle
   `confirm` ou `markFailed`. Toute la logique métier (transaction,
   notification, audit, temps réel) est déjà en place.
