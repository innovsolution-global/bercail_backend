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

## Chap Chap Pay

L'encaissement mobile money passe par **Chap Chap Pay**, opérateur guinéen
qui présente lui-même au client le choix entre Orange Money, MTN et carte.
Voir <https://chapchappay.com/guide/>.

### Le circuit

```
 1. Le client valide sa commande
        │
        ▼
 2. POST /payments/order/:id/initiate
        │   le serveur ouvre une opération chez Chap Chap
        ▼
 3. Réponse : { paymentUrl }   →   le client paie sur la page de l'opérateur
        │
        ▼
 4. Chap Chap rappelle POST /v1/webhooks/chapchap   ←── fait foi
        │
        ▼
 5. Le paiement passe en PAID ou FAILED, la commande suit
```

> **C'est le rappel, et lui seul, qui décide qu'une commande est payée.** La
> redirection du client ne prouve rien : il peut fermer son navigateur avant
> d'être redirigé, et le paiement aura pourtant abouti.

### La signature

Les deux sens sont signés en **HMAC-SHA256**, en hexadécimal, dans l'en-tête
`CCP-HMAC-Signature`.

La vérification porte sur le **corps brut reçu**, jamais sur l'objet
reconstruit : `JSON.parse` puis `JSON.stringify` réordonne les clés et
change les espaces, ce qui invaliderait une signature pourtant authentique.
C'est pourquoi le serveur démarre avec `rawBody: true`.

La route du rappel est publique — Chap Chap n'a pas de compte chez nous — et
la signature est donc sa **seule** barrière. Sans elle, n'importe qui
pourrait déclarer ses commandes réglées.

### Ce qui protège l'argent

- **Rejouer un rappel ne fait rien.** Un opérateur réessaie tant qu'il n'a
  pas d'accusé. Un paiement déjà encaissé ne l'est pas une seconde fois.
- **Le montant n'est jamais lu du rappel.** On n'y lit qu'un statut : ce que
  doit la commande a été calculé chez nous, un rappel ne peut pas le changer.
- **Un encaissement ne se défait pas par un rappel tardif.** Seul un
  remboursement annule un paiement abouti.
- **Un rappel inconnu est ignoré sans erreur.** Répondre en échec ferait
  réessayer l'opérateur indéfiniment pour une transaction qui ne nous
  concerne pas.

### Configuration

Toutes les clés sont dans `.env` — passer en production ne demande que de
les remplacer, sans toucher au code.

| Variable | Rôle |
| -------- | ---- |
| `CHAPCHAP_API_BASE_URL` | Racine de l'API |
| `CHAPCHAP_API_KEY` | Identifie le marchand |
| `CHAPCHAP_HMAC_SECRET` | Signe les requêtes sortantes |
| `CHAPCHAP_ECOMMERCE_PATH` | Chemin de création d'une opération |
| `CHAPCHAP_WEBHOOK_SECRET` | Vérifie les rappels ; vide, le précédent fait office |
| `CHAPCHAP_WEBHOOK_SIGNATURE_HEADER` | En-tête portant la signature |
| `CHAPCHAP_PUBLIC_BASE_URL` | Adresse **publique** du serveur (tunnel en développement) |
| `CHAPCHAP_PUBLIC_NOTIFY_PATH` | Chemin que Chap Chap rappellera |
| `CHAPCHAP_FRONTEND_BASE_URL` | Site qui accueille le client après paiement |
| `CHAPCHAP_RETURN_PATH` | Page d'atterrissage après un paiement abouti |
| `CHAPCHAP_CANCEL_PATH` | Page d'atterrissage après un abandon ou un refus |
| `CHAPCHAP_WEBHOOK_ALLOW_UNSIGNED` | Dépannage local **uniquement** |
| `CHAPCHAP_REQUEST_BODY_STYLE` | `snake` ou `camel` |

L'intégration **s'active d'elle-même** dès que `CHAPCHAP_API_KEY` et
`CHAPCHAP_HMAC_SECRET` sont renseignés : pas de drapeau à oublier. Sans
clés, le serveur retombe sur la référence simulée, ce qui laisse le bac à
sable et les tests fonctionner sans réseau.

Trois points d'attention :

- `CHAPCHAP_PUBLIC_NOTIFY_PATH` doit correspondre au chemin déclaré dans
  `ChapChapWebhookController`, et ce chemin est **exclu du préfixe
  `api/v1`** — sans quoi l'opérateur appellerait `/api/v1/v1/webhooks/…` et
  parlerait dans le vide.
- `CHAPCHAP_PUBLIC_BASE_URL` porte l'adresse **publique** du serveur, et
  non `API_URL`. Les deux diffèrent en développement : `API_URL` vaut
  `localhost`, que les serveurs de Chap Chap ne peuvent pas joindre. Bâtir
  le rappel dessus le rendrait muet, et le paiement resterait
  indéfiniment « en cours » sans que rien n'en dise la cause. Sans tunnel,
  il reste `CHAPCHAP_WEBHOOK_ALLOW_UNSIGNED` et un rappel simulé à la main.
- Les pages d'atterrissage ne décident de rien. Le client peut fermer son
  navigateur avant d'y arriver, ou les rejouer après un échec : seul le
  rappel signé marque une commande payée. Laisser
  `CHAPCHAP_FRONTEND_BASE_URL` vide n'empêche pas d'encaisser — l'opérateur
  garde alors le client sur sa propre page de confirmation.

### Tunnel de développement

`CHAPCHAP_PUBLIC_BASE_URL` et `CHAPCHAP_FRONTEND_BASE_URL` pointent
aujourd'hui sur deux tunnels *localtunnel*. Deux réserves :

1. Un tunnel ne répond `503` que tant qu'aucun processus n'est derrière :
   lancer le serveur **avant** de tester le rappel.
2. localtunnel intercale une page d'avertissement pour les requêtes
   venant d'un navigateur. Le rappel de Chap Chap n'en souffre pas — c'est
   un appel serveur à serveur — mais **le client, lui, la verra** en
   arrivant sur la page de retour, et devra cliquer pour passer. Acceptable
   pour une recette, pas pour la production.
