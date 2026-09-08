# API supervision — SUPER_ADMIN

Le `SUPER_ADMIN` dispose de **tout** ce que peut faire un `ADMIN`
(voir [admin-api.md](admin-api.md)), plus l'administration des comptes, les
permissions, l'audit et les paramètres système.

Ces routes exigent le **rôle** `SUPER_ADMIN` en plus de la permission : même
un `ADMIN` à qui l'on aurait accordé `USERS_*` par erreur ne passerait pas.

## Tableau de bord de supervision

`GET /dashboard/super-admin` — alias `GET /super-admin/dashboard`.

Reprend tout le tableau de bord opérationnel et y ajoute :

```jsonc
{
  "adminsCount": 3,
  "activeAdmins": 3,
  "activeUsers24h": 47,
  "activePromotions": 3,
  "health": {
    "api": "up", "database": "up", "websocket": "up", "cache": "up",
    "uptimePercent": 100, "errorsLast24h": 2, "averageResponseMs": 12
  },
  "securityAlerts": [
    { "id": "…", "severity": "medium",
      "title": "Compte verrouillé après échecs répétés",
      "description": "…", "at": "…" }
  ],
  "recentAuditLogs": [ /* 10 dernières actions sensibles */ ]
}
```

## Administrateurs

`/administrators` — alias `/super-admin/admins`.

| Méthode | Route                                  | Permission            |
| ------- | -------------------------------------- | --------------------- |
| GET     | `/administrators`                      | `USERS_READ`          |
| POST    | `/administrators`                      | `USERS_CREATE`        |
| GET     | `/administrators/:id`                  | `USERS_READ`          |
| PATCH   | `/administrators/:id`                  | `USERS_UPDATE`        |
| PATCH   | `/administrators/:id/status`           | `USERS_SUSPEND`       |
| PATCH   | `/administrators/:id/permissions`      | `USERS_PERMISSIONS`   |
| POST    | `/administrators/:id/resend-activation`| `USERS_CREATE`        |
| DELETE  | `/administrators/:id`                  | `USERS_DELETE`        |

### Créer un administrateur

```jsonc
// POST /administrators
{
  "firstName": "Mohamed", "lastName": "Doumbouya",
  "email": "mohamed@lebercail.gn", "phone": "+224620000004",
  "permissions": ["MENU_READ", "MENU_UPDATE", "ORDERS_READ"]   // facultatif
}
```

Aucun mot de passe n'est transmis. Le compte naît `PENDING` et la réponse
contient un jeton d'activation, renvoyé **une seule fois** :

```jsonc
{
  "id": "…", "role": "ADMIN", "status": "pending",
  "permissions": ["MENU_READ", "MENU_UPDATE", "ORDERS_READ"],
  "activation": { "token": "…", "expiresInHours": 72 }
}
```

Sans `permissions`, le socle du rôle `ADMIN` s'applique.

### Garde-fous

| Tentative                              | Résultat                            |
| -------------------------------------- | ----------------------------------- |
| Modifier un `SUPER_ADMIN`              | `403 CANNOT_MODIFY_SUPER_ADMIN`     |
| Se modifier soi-même par cette route   | `403 CANNOT_MODIFY_SELF`            |
| Créer un `SUPER_ADMIN`                 | Impossible — la route ne le permet pas |
| Déléguer `USERS_*` ou `SETTINGS_SYSTEM`| `403 PERMISSION_NOT_DELEGABLE`      |

Une suspension ferme immédiatement toutes les sessions du compte visé. Une
suppression est **logique** : le journal d'audit conserve ses actions passées.

## Permissions

| Méthode | Route                              | Description                                  |
| ------- | ---------------------------------- | -------------------------------------------- |
| GET     | `/permissions`                     | Catalogue groupé par module, socles par rôle |
| PATCH   | `/administrators/:id/permissions`  | Redéfinir les permissions d'un `ADMIN`       |

```jsonc
// PATCH /administrators/:id/permissions
{ "permissions": ["ORDERS_READ", "ORDERS_UPDATE_STATUS", "MENU_READ", "MENU_UPDATE"] }
```

La liste envoyée **remplace intégralement** les droits du compte. Le serveur
en déduit ce qu'il faut accorder en plus du socle et ce qu'il faut retirer.

L'effet est **immédiat** : les permissions sont relues à chaque requête, sans
attendre la reconnexion. L'audit conserve le différentiel avant/après.

Le catalogue :

```jsonc
// GET /permissions
{
  "modules": [ { "key": "orders", "permissions": [ { "code": "ORDERS_READ",
                 "label": "Consulter les commandes", "sensitive": false,
                 "description": "…" } ] } ],
  "rolePresets": { "ADMIN": ["…"], "SUPER_ADMIN": ["…"], "CUSTOMER": [], "DRIVER": [] },
  "superAdminOnly": ["USERS_READ", "…", "SETTINGS_SYSTEM"]
}
```

## Journal d'audit

`/audit-logs` — alias `/super-admin/audit-logs`.

| Méthode | Route                    | Permission       |
| ------- | ------------------------ | ---------------- |
| GET     | `/audit-logs`            | `AUDIT_READ`     |
| GET     | `/audit-logs/actions`    | `AUDIT_READ`     |
| GET     | `/audit-logs/modules`    | `AUDIT_READ`     |
| GET     | `/audit-logs/export`     | `AUDIT_EXPORT`   |

Filtres : `actorId`, `role`, `action`, `module`, `result`, `from`, `to`,
`search`, `page`, `limit`.

```jsonc
{
  "id": "…", "at": "2026-09-03T14:32:10.000Z",
  "actorId": "…", "actorName": "Amadou Bah", "actorRole": "SUPER_ADMIN",
  "action": "PAYMENT_REFUND", "module": "payments",
  "entityType": "Payment", "entityId": "…",
  "ipAddress": "41.223.…", "userAgent": "Mozilla/5.0…",
  "result": "success",
  "changes": { "status": { "before": "PAID", "after": "REFUNDED" } }
}
```

Le journal est en **écriture seule** : aucune route ne le modifie ni ne le
supprime. Le nom et le rôle de l'auteur sont copiés au moment des faits, pour
rester lisibles même si le compte disparaît ensuite.

Actions systématiquement auditées : création et modification d'administrateur,
changement de permissions, suspension, modification de prix, remboursement,
annulation, attribution et réattribution de livreur, modification des
paramètres, connexions échouées, régénération d'un code de livraison.

## Paramètres système

| Méthode | Route              | Permission          |
| ------- | ------------------ | ------------------- |
| GET     | `/settings/system` | `SETTINGS_SYSTEM`   |
| PATCH   | `/settings/system` | `SETTINGS_SYSTEM`   |

```jsonc
{
  "maintenanceMode": false,
  "maintenanceMessage": "",
  "sessionTimeoutMinutes": 120,
  "passwordMinLength": 8,
  "requireTwoFactor": false,
  "maxLoginAttempts": 5,
  "auditRetentionDays": 365,
  "notifications": { "emailEnabled": true, "smsEnabled": false,
                     "pushEnabled": true, "newOrderSound": true },
  "integrations": { "orangeMoneyEnabled": true, "mtnMoneyEnabled": true,
                    "cardPaymentEnabled": false, "mapsProvider": "osm" }
}
```

Désactiver un moyen de paiement le refuse **dès la création de commande**.
`auditRetentionDays` pilote la purge quotidienne du journal.

Toute modification est intégralement auditée (instantané avant/après).

## Rapports avancés

Le `SUPER_ADMIN` accède à tous les rapports de l'`ADMIN`, sans restriction de
permission possible.

## Bonnes pratiques

1. **Changer immédiatement** le mot de passe d'amorçage du `SUPER_ADMIN`.
2. Créer un `ADMIN` par personne, jamais de compte partagé — l'audit ne vaut
   que si l'auteur est identifiable.
3. Attribuer le minimum de permissions nécessaire, puis élargir.
4. Consulter les alertes de sécurité du tableau de bord régulièrement : elles
   remontent les verrouillages de compte et les rejeux de jeton.
5. Suspendre plutôt que supprimer : la suppression est logique de toute façon,
   mais la suspension est réversible et plus lisible.
