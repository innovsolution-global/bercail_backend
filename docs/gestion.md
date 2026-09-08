# Gestion d'exploitation — argent, stock, personnel, caisse

Base : `http://localhost:3000/api/v1` — rôle `ADMIN` ou `SUPER_ADMIN`.

Le back-office ne suit plus seulement les commandes : il tient la comptabilité
de l'établissement. Trois registres se répondent, et un quatrième les alimente.

```
   ACHAT ──────────► STOCK ──────────► CUISINE
     │                 │                  │
     │ (dépense)       │ (valorisation)   │ (sortie)
     ▼                 ▼                  ▼
  ╔═══════════════════════════════════════════╗
  ║              JOURNAL DE CAISSE            ║
  ║   ce qui sort  ◄──────────►  ce qui rentre║
  ╚═══════════════════════════════════════════╝
     ▲                                    ▲
     │                                    │
  CHARGES                          VENTES (app + comptoir)
  SALAIRES                         RECETTES DIVERSES
```

## La règle qui évite les doubles comptages

> **Toute sortie d'argent est une ligne de la table `expenses`. Sans exception.**

Un approvisionnement ne crée donc pas « un achat **et** une dépense » comptés
deux fois : il crée un `Purchase` (qui porte le détail des lignes et le
mouvement de stock) **et** l'`Expense` correspondante, liée par `purchaseId`.
Le rapport de période n'additionne que `expenses` — le montant ne peut pas
être compté deux fois, puisqu'il n'existe qu'à un seul endroit.

Même logique pour les salaires : une paie est une `Expense` de catégorie
`SALAIRE`, rattachée à un employé et à un mois (`period`, au format `AAAA-MM`).
Il n'y a pas de table « paie » séparée.

Côté recettes, la symétrie est volontairement imparfaite : les **ventes**
viennent des commandes (`orders` en statut `DELIVERED`), les **recettes
diverses** de la table `incomes`. Une vente est déjà une commande, la
dupliquer dans un registre financier serait la compter deux fois.

## Caisse — commandes prises sur place

| Méthode | Route         | Permission |
| ------- | ------------- | ---------- |
| POST    | `/pos/quote`  | `POS_SELL` |
| POST    | `/pos/orders` | `POS_SELL` |
| GET     | `/pos/today`  | `POS_SELL` |

Une vente au comptoir est une **commande comme les autres** : même table, même
liste, même chiffre d'affaires. Deux différences seulement :

- `channel = POS` et `customerId = null` — personne n'ouvre un compte client
  pour acheter un poulet braisé sur place ; on garde au mieux `walkInName`,
  `walkInPhone` et `tableNumber` ;
- ni le minimum de commande ni les horaires d'ouverture ne s'appliquent : si
  quelqu'un est devant la caisse, le restaurant est ouvert.

Ce qui ne change pas : **les prix**. La caisse envoie des identifiants de plats
et des quantités, le serveur relit la carte et recalcule. Seule la remise
(`discount`) est transmise — c'est une décision humaine — et le serveur la
plafonne au sous-total.

```jsonc
// POST /pos/orders
{
  "type": "dine_in",                    // ou "pickup"
  "items": [{ "menuItemId": "…", "quantity": 2 }],
  "paymentMethod": "cash_on_delivery",  // espèces au comptoir
  "customerName": "Mamadou",
  "tableNumber": "7",
  "discount": 5000,
  "amountReceived": 150000,             // pour calculer le rendu
  "servedImmediately": true             // sinon la commande part en cuisine
}
```

`servedImmediately` (défaut) crée la commande directement en `DELIVERED` :
elle est servie et encaissée dans le même geste. À `false`, elle naît en
`CONFIRMED` et suit le cycle normal de la cuisine.

Le filtre `?channel=online|pos` sur `GET /orders` sépare les deux origines.

## Stock

| Méthode | Route                  | Permission     |
| ------- | ---------------------- | -------------- |
| GET     | `/stock/summary`       | `STOCK_READ`   |
| GET     | `/stock/alerts`        | `STOCK_READ`   |
| GET     | `/stock/items`         | `STOCK_READ`   |
| GET     | `/stock/items/:id`     | `STOCK_READ`   |
| POST    | `/stock/items`         | `STOCK_MANAGE` |
| PATCH   | `/stock/items/:id`     | `STOCK_MANAGE` |
| DELETE  | `/stock/items/:id`     | `STOCK_MANAGE` |
| GET     | `/stock/movements`     | `STOCK_READ`   |
| POST    | `/stock/movements`     | `STOCK_MANAGE` |

> **Le stock ne s'écrit jamais directement : il est la somme de ses
> mouvements.** `PATCH /stock/items/:id` refuse d'ailleurs le champ
> `quantity`.

Trois sens de mouvement :

| Type         | Effet                                                    |
| ------------ | -------------------------------------------------------- |
| `IN`         | ajoute la quantité et **recalcule le coût moyen pondéré** |
| `OUT`        | retire la quantité, valorisée au coût moyen en vigueur    |
| `ADJUSTMENT` | aligne le stock sur la quantité **réellement comptée**     |

Le coût moyen pondéré est le chiffre qui valorise la réserve :

```
nouveau coût moyen = (quantité × coût moyen + entrée × prix d'achat)
                     ─────────────────────────────────────────────
                                quantité + entrée
```

Une sortie consomme au coût déjà connu : elle ne modifie pas la moyenne. Et
une sortie supérieure au stock disponible est **refusée** — la correction
passe par un inventaire, qui laisse une trace.

## Approvisionnements

| Méthode | Route                    | Permission          |
| ------- | ------------------------ | ------------------- |
| GET     | `/purchases`             | `STOCK_READ`        |
| GET     | `/purchases/:id`         | `STOCK_READ`        |
| POST    | `/purchases`             | `PURCHASES_MANAGE`  |
| PATCH   | `/purchases/:id/settle`  | `PURCHASES_MANAGE`  |
| PATCH   | `/purchases/:id/cancel`  | `PURCHASES_MANAGE`  |

Un achat écrit trois choses **dans la même transaction** : la facture, les
entrées en stock, la dépense. Il ne peut pas y avoir de poulet en réserve sans
la dépense qui l'a payé.

Comme pour une commande, les montants sont recalculés : chaque ligne vaut
`quantité × prix unitaire`, et le total est la somme des lignes.

`status: "pending"` enregistre un achat **à crédit** : la marchandise entre en
stock, l'argent n'est pas encore sorti. `PATCH /purchases/:id/settle` solde la
facture, côté achat et côté dépense.

L'annulation ressort du stock ce qu'il en reste — la marchandise a pu être
consommée entre-temps, on ne ressort donc que le disponible — et retire la
dépense du journal. Le document, lui, reste consultable : annuler n'est pas
effacer.

## Fiches techniques

| Méthode | Route                         | Permission    |
| ------- | ----------------------------- | ------------- |
| GET     | `/menu/items/:id/recipe`      | `MENU_READ`   |
| PUT     | `/menu/items/:id/recipe`      | `MENU_UPDATE` |

La fiche technique est le chaînon qui referme le circuit de la matière :
l'achat la fait entrer en réserve, la fiche dit ce qu'un plat en prélève, et
la mise en préparation d'une commande l'en sort. Sans elle, le stock ne
faisait que monter.

> À ne pas confondre avec `MenuItem.ingredients`, la liste que lit le client
> dans l'application (« Poulet, oignons, épices ») : du texte libre, sans
> quantité ni lien au stock.

L'enregistrement est **intégral** : la liste envoyée devient la fiche. Une
liste vide l'efface, et le plat cesse alors de mouvementer le stock.

```jsonc
// PUT /menu/items/:id/recipe
{
  "ingredients": [
    { "stockItemId": "…", "quantity": 1.2 },   // 1,2 kg de poulet par portion
    { "stockItemId": "…", "quantity": 0.15 }   // 0,15 kg d'oignons
  ]
}
```

La réponse porte le **coût de revient** — la somme des ingrédients valorisés
au coût moyen pondéré — et donc la marge réelle du plat, qui n'a rien à voir
avec son prix affiché.

### Quand la matière sort

À la **mise en préparation** (`status → PREPARING`). Ni à la prise de
commande, qui peut encore être annulée, ni à la livraison, où le plat est
cuit depuis longtemps. Une vente au comptoir servie immédiatement consomme
dès l'encaissement, puisqu'elle ne passera jamais par ce statut.

Trois choix structurent cette déduction :

- **Idempotence par `orders.stockConsumedAt`.** Une commande ne se déduit
  qu'une fois, quels que soient les aller-retours de statut. Le marqueur est
  posé *avant* les écritures : en cas d'échec au milieu, une déduction
  incomplète vaut mieux qu'une double déduction au passage suivant.

- **Le stock peut passer sous zéro.** Refuser la sortie parce que le
  compteur annonce zéro reviendrait à nier une vente qui a eu lieu. Un stock
  négatif est un signal fort — « on a vendu plus qu'on n'a déclaré acheter »
  — et il remonte tout seul dans `/stock/alerts`. La saisie manuelle, elle,
  reste refusée : c'est une faute de frappe bien plus souvent qu'un stock
  réellement négatif.

- **Jamais bloquante.** Un échec de déduction est journalisé, il n'annule pas
  la commande : la cuisine ne s'arrête pas pour une écriture comptable.

Un ingrédient présent dans deux plats de la même commande donne **une seule**
ligne de journal : une par article et par commande, pas une par plat.

Une annulation après le début de la préparation ne rend rien au stock — les
ingrédients sont cuits.

## Dépenses et recettes

| Méthode | Route                   | Permission        |
| ------- | ----------------------- | ----------------- |
| GET     | `/expenses`             | `FINANCE_READ`    |
| GET     | `/expenses/due`         | `FINANCE_READ`    |
| GET     | `/expenses/:id`         | `FINANCE_READ`    |
| POST    | `/expenses`             | `EXPENSES_MANAGE` |
| PATCH   | `/expenses/:id`         | `EXPENSES_MANAGE` |
| PATCH   | `/expenses/:id/settle`  | `EXPENSES_MANAGE` |
| DELETE  | `/expenses/:id`         | `EXPENSES_MANAGE` |
| GET     | `/incomes`              | `FINANCE_READ`    |
| POST    | `/incomes`              | `INCOMES_MANAGE`  |
| PATCH   | `/incomes/:id`          | `INCOMES_MANAGE`  |
| DELETE  | `/incomes/:id`          | `INCOMES_MANAGE`  |

Catégories de dépense : `INGREDIENTS`, `BOISSONS`, `EMBALLAGE`, `ELECTRICITE`,
`EAU`, `LOYER`, `SALAIRE`, `CARBURANT`, `TRANSPORT`, `MAINTENANCE`,
`EQUIPEMENT`, `MARKETING`, `TAXES`, `COMMUNICATION`, `AUTRE`.

Deux dates cohabitent, et elles ne disent pas la même chose :
`incurredAt` est le moment où la charge est **engagée** (la facture d'août est
d'août), `paidAt` celui où elle est **réglée**. Le rapport d'un mois compte
donc ce qui a été engagé ce mois-là, même si le règlement suit.

`GET /expenses` renvoie ses totaux dans `meta` — `totalAmount`, `paidAmount`,
`pendingAmount` — calculés sur le **filtre appliqué**, pas sur la page
affichée.

Une dépense née d'un achat (`purchaseId` renseigné) ne se modifie ni ne se
supprime ici : elle appartient à son approvisionnement, qui porte le stock.

## Personnel et paie

| Méthode | Route                        | Permission        |
| ------- | ---------------------------- | ----------------- |
| GET     | `/employees`                 | `EMPLOYEES_READ`  |
| GET     | `/employees/positions`       | `EMPLOYEES_READ`  |
| GET     | `/employees/payroll?period=` | `EMPLOYEES_READ`  |
| GET     | `/employees/:id`             | `EMPLOYEES_READ`  |
| POST    | `/employees`                 | `EMPLOYEES_MANAGE`|
| PATCH   | `/employees/:id`             | `EMPLOYEES_MANAGE`|
| DELETE  | `/employees/:id`             | `EMPLOYEES_MANAGE`|
| POST    | `/employees/payroll/generate`| `PAYROLL_MANAGE`  |

Un employé n'est pas forcément un compte du système : le cuisinier n'a pas
d'accès au back-office. Le champ `userId` fait le lien quand il y en a un.

`POST /employees/payroll/generate` crée une dépense de salaire par employé
actif pour le mois demandé. **Rejouer l'opération ne crée pas de doublon** :
un employé qui a déjà sa ligne pour la période est ignoré — ce qui permet de
relancer la génération après une embauche en cours de mois.

Le salaire est daté du **dernier jour du mois payé** : un salaire d'août reste
dans le rapport d'août, même généré en septembre.

## Rapports

| Méthode | Route                            | Permission       |
| ------- | -------------------------------- | ---------------- |
| GET     | `/finance/summary`               | `FINANCE_READ`   |
| GET     | `/finance/overview`              | `FINANCE_READ`   |
| GET     | `/finance/ledger`                | `FINANCE_READ`   |
| GET     | `/finance/monthly-report?period=`| `FINANCE_READ`   |
| GET     | `/finance/monthly-report/export` | `FINANCE_EXPORT` |
| GET     | `/finance/ledger/export`         | `FINANCE_EXPORT` |

### Journal de caisse

`GET /finance/ledger` fusionne trois tables sur une même ligne de temps —
ventes, recettes, dépenses — au moyen d'une **union SQL paginée**. Un registre
qui vit dans trois tables se lit donc sans en charger aucune en mémoire.

```jsonc
{
  "data": [
    { "direction": "in",  "kind": "sale",     "reference": "BRC-…", "amount": 145000 },
    { "direction": "out", "kind": "purchase", "reference": "ACH-…", "amount": 1800000 },
    { "direction": "out", "kind": "salary",   "reference": "SAL-…", "amount": 3500000 }
  ],
  "meta": { "page": 1, "total": 132, "inflow": 18400000, "outflow": 11250000, "net": 7150000 }
}
```

### Rapport d'activité mensuel

`GET /finance/monthly-report?period=2026-09` renvoie le document que le
propriétaire regarde en fin de mois :

- recettes détaillées (ventes en ligne, ventes au comptoir, recettes diverses) ;
- dépenses par catégorie, avec la part de chacune ;
- résultat net et marge ;
- **comparaison avec le mois précédent** (variation en pourcentage) ;
- masse salariale, meilleures ventes, principaux fournisseurs ;
- série jour par jour.

L'export CSV se lit de haut en bas comme un compte de résultat.

## Permissions ajoutées

| Module    | Permissions                                                          |
| --------- | -------------------------------------------------------------------- |
| `orders`  | `POS_SELL`                                                           |
| `stock`   | `STOCK_READ`, `STOCK_MANAGE`, `PURCHASES_MANAGE`, `SUPPLIERS_MANAGE` |
| `finance` | `FINANCE_READ`, `FINANCE_EXPORT`, `EXPENSES_MANAGE`, `INCOMES_MANAGE`|
| `hr`      | `EMPLOYEES_READ`, `EMPLOYEES_MANAGE`, `PAYROLL_MANAGE`               |

Par défaut, un `ADMIN` reçoit tout sauf `EMPLOYEES_MANAGE` et
`PAYROLL_MANAGE` : la gestion du personnel et des salaires reste au
`SUPER_ADMIN`, qui peut la déléguer au cas par cas.
