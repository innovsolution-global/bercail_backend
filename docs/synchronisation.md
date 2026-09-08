# Synchronisation local ↔ en ligne

Le restaurant tourne sur un serveur posé **sur place**. La caisse et le
back-office s'y connectent par le réseau local : ils continuent de
fonctionner quand Internet tombe, ce qui arrive. Un second serveur, **en
ligne**, sert l'application mobile et l'accès à distance du propriétaire.

```
        RESTAURANT                                    EN LIGNE
   ┌───────────────────┐                        ┌───────────────────┐
   │  Caisse           │                        │  App client       │
   │  Back-office      │                        │  App livreur      │
   │        │          │                        │        │          │
   │   ┌────▼────┐     │   ①  pousse ses écrits │   ┌────▼────┐     │
   │   │ Serveur │─────┼───────────────────────►│   │ Serveur │     │
   │   │  LOCAL  │◄────┼────────────────────────┤   │  CLOUD  │     │
   │   └────┬────┘     │   ②  tire les leurs    │   └────┬────┘     │
   │   ┌────▼────┐     │                        │   ┌────▼────┐     │
   │   │  Base   │     │                        │   │  Base   │     │
   │   └─────────┘     │                        │   └─────────┘     │
   └───────────────────┘                        └───────────────────┘
```

**C'est toujours le serveur du restaurant qui engage l'échange.** Il est
derrière la box de l'établissement, sans adresse joignable depuis
l'extérieur : le serveur en ligne ne peut pas l'appeler. Le nœud local
pousse ce qu'il a écrit, puis tire ce qui a été écrit en ligne.

Une coupure n'est pas une panne : le journal s'accumule, et le premier
cycle qui repasse rattrape tout ce qui s'est vendu entre-temps.

## Les trois règles qui rendent la fusion sûre

### 1. Chaque donnée a un propriétaire

C'est la règle qui fait presque tout le travail : **là où il n'y a qu'un
seul écrivain, il n'y a rien à arbitrer.**

| Propriétaire | Données |
| ------------ | ------- |
| `LOCAL` | Carte, fiches techniques, stock, achats, fournisseurs, dépenses, recettes, paie, promotions, paramètres, permissions |
| `CLOUD` | Adresses des clients, profils client et livreur, livraisons et leurs événements |
| `SHARED` | Commandes, lignes, paiements, historiques, comptes utilisateurs |

Le partage est rare et assumé : une commande naît au comptoir **ou** dans
l'application ; un compte est créé par un client en ligne **ou** par un
gérant sur place.

Si un serveur reçoit une écriture portant sur une entité dont **il est**
propriétaire, il la refuse : le pair n'avait pas à l'écrire.

### 2. On ne réplique jamais un compteur

`stockItem.quantity`, `menuItem.ordersCount`, `promotion.usageCount` sont
des **états dérivés**. Les répliquer en « dernière écriture gagne »
perdrait des mouvements entiers.

Ce sont les **documents et les événements** qui voyagent — les mouvements
de stock, pas le stock. Le compteur se reconstitue de lui-même, puisqu'il
n'a qu'un écrivain.

Le statut d'une commande suit la même logique : il n'est pas répliqué mais
**recalculé depuis son historique**, qui est écrit en ajout seul. C'est ce
qui permet à la cuisine de faire avancer une commande passée en ligne sans
qu'un lot arrivé dans le désordre puisse la faire reculer.

### 3. Rejouer un lot ne change rien

Chaque écriture porte l'identifiant que l'émetteur lui a donné, et le
récepteur retient ce qu'il a appliqué (`sync_applied`). Un lot renvoyé
parce que la réponse s'est perdue n'écrit rien de plus.

> **Une vente ne peut pas être comptée deux fois parce que le réseau a
> hoqueté.** C'est la propriété la plus importante du dispositif.

## Le journal des écritures

Il n'est **pas** alimenté par le code applicatif mais par des déclencheurs
PostgreSQL. C'est la seule façon de garantir qu'aucune écriture n'y
échappe : ni une requête SQL directe, ni un script de maintenance, ni un
chemin de code qu'on aurait oublié.

Deux gardes vivent dans le déclencheur :

- **Anti-écho.** Une écriture appliquée par la synchronisation ne repart
  pas vers le pair. La transaction pose `SET LOCAL app.sync_apply = 'on'`,
  et le déclencheur se tait. Sans cela, les deux serveurs se renverraient
  les mêmes lignes sans fin.

- **Écritures inutiles.** Une mise à jour qui laisse la ligne identique
  n'est pas journalisée. Sans ce filtre, la synchronisation du catalogue de
  permissions au démarrage enverrait 55 écritures pour rien à chaque
  redémarrage.

Sont exclus du journal : les jetons et secrets, les positions GPS des
livreurs (gros volume, sans valeur différée), les paniers et favoris, le
journal d'audit et les notifications — chaque serveur garde les siens.

## Les conflits

Sur une entité partagée, une écriture qui contredirait une version plus
récente **n'est pas appliquée** : elle est déposée dans `sync_conflicts`
avec les deux versions et le motif.

> Sur de l'argent, un écrasement silencieux est pire qu'une alerte.

Le back-office affiche le nombre de conflits non résolus dans l'indicateur
de synchronisation.

## Routes

| Méthode | Route          | Authentification    |
| ------- | -------------- | ------------------- |
| POST    | `/sync/push`   | Secret partagé      |
| GET     | `/sync/pull`   | Secret partagé      |
| GET     | `/sync/status` | `SETTINGS_READ`     |
| POST    | `/sync/run`    | `SETTINGS_UPDATE`   |

Les deux premières ne parlent qu'au nœud pair : elles s'authentifient par
un **secret partagé**, comparé à durée constante, jamais par un jeton
d'utilisateur — la synchronisation n'agit au nom de personne.

## Installation

### Serveur du restaurant

```bash
SYNC_ENABLED=true
SYNC_NODE=LOCAL
SYNC_PEER_URL=https://api.lebercail.gn
SYNC_SECRET=<openssl rand -base64 48>
ORDER_REFERENCE_PREFIX=BRC
```

### Serveur en ligne

```bash
SYNC_ENABLED=true
SYNC_NODE=CLOUD
SYNC_SECRET=<le même secret>
ORDER_REFERENCE_PREFIX=BRO
```

Et, dans la base du serveur en ligne :

```sql
ALTER DATABASE <base> SET app.sync_node = 'CLOUD';
```

L'identité est portée par la base, pas par la session : un pool rouvre des
connexions en permanence, et un réglage de session finirait par manquer sur
l'une d'elles.

**Les deux préfixes de référence doivent différer.** Deux commandes créées
hors ligne de part et d'autre ne doivent pas pouvoir porter le même numéro —
la colonne est unique, une collision bloquerait la synchronisation.

## Vérifier

```bash
# Un second jeu de tables joue le nœud en ligne.
CREATE SCHEMA IF NOT EXISTS cloud;
DATABASE_URL="...?schema=cloud" npx prisma migrate deploy

npm run sync:verify
```

Le script écrit puis nettoie derrière lui. Il contrôle le circuit complet :
journalisation, ordre des dépendances, absence d'écho, idempotence du
rejeu, et refus d'une écriture mal adressée.

## Ce que la synchronisation ne résout pas

- **Les quotas de promotion.** Un code limité à cent usages peut être
  dépassé pendant une coupure : les deux serveurs comptent séparément. Pour
  un restaurant, l'écart est marginal ; il faut le savoir.

- **Les paiements par opérateur.** Ils exigent le réseau par nature. Hors
  ligne, seules les espèces sont encaissables au comptoir.

- **Le temps réel entre les deux nœuds.** Une commande passée en ligne
  n'apparaît en cuisine qu'au cycle suivant, vingt secondes plus tard.
