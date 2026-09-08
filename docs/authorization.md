# Autorisation — RBAC

## Le modèle

```
      Utilisateur
           │
           ▼
        Rôle  ──────► socle de permissions
           │
           ▼
   Ajustements individuels  (accordées ∪ / retirées −)
           │
           ▼
   Permissions effectives
```

```
permissions(user) = socle(rôle) ∪ accordées(user) − retirées(user)
```

Deux règles absolues :

- le `SUPER_ADMIN` possède **toutes** les permissions, et on ne peut pas les
  lui retirer ;
- un `ADMIN` ne peut **jamais** recevoir une permission réservée au
  `SUPER_ADMIN`, même par écriture directe en base — le filtre est appliqué au
  calcul des permissions effectives, pas seulement à l'écriture.

`CUSTOMER` et `DRIVER` n'ont **aucune** permission. Leurs accès ne relèvent pas
d'un droit global mais de l'**appartenance** : « c'est ma commande », « c'est
ma course ».

## Les quatre rôles

| Rôle          | Application | Périmètre                                                     |
| ------------- | ----------- | ------------------------------------------------------------- |
| `CUSTOMER`    | Flutter     | Ses données : profil, adresses, panier, commandes, favoris     |
| `DRIVER`      | Flutter     | Ses courses, sa position, sa disponibilité                     |
| `ADMIN`       | React       | Exploitation du restaurant, selon ses permissions              |
| `SUPER_ADMIN` | React       | Tout, plus l'administration, l'audit et le système             |

## Catalogue des permissions

43 permissions, regroupées en 11 modules. Le catalogue est exposé par
`GET /api/v1/permissions` : le back-office ne l'invente pas, il le demande.

| Module        | Permissions                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `users`       | `USERS_READ` `USERS_CREATE` `USERS_UPDATE` `USERS_DELETE` `USERS_SUSPEND` `USERS_PERMISSIONS` |
| `customers`   | `CUSTOMERS_READ` `CUSTOMERS_UPDATE` `CUSTOMERS_SUSPEND` `CUSTOMERS_EXPORT`                |
| `drivers`     | `DRIVERS_READ` `DRIVERS_CREATE` `DRIVERS_UPDATE` `DRIVERS_SUSPEND` `DRIVERS_DELETE`       |
| `menu`        | `MENU_READ` `MENU_CREATE` `MENU_UPDATE` `MENU_DELETE` `MENU_AVAILABILITY` `CATEGORIES_MANAGE` |
| `orders`      | `ORDERS_READ` `ORDERS_UPDATE_STATUS` `ORDERS_ASSIGN_DRIVER` `ORDERS_CANCEL` `ORDERS_EXPORT` |
| `payments`    | `PAYMENTS_READ` `PAYMENTS_REFUND` `PAYMENTS_EXPORT`                                       |
| `deliveries`  | `DELIVERIES_READ` `DELIVERIES_UPDATE` `DELIVERIES_TRACK`                                  |
| `promotions`  | `PROMOTIONS_READ` `PROMOTIONS_CREATE` `PROMOTIONS_UPDATE` `PROMOTIONS_DELETE`             |
| `reports`     | `REPORTS_READ` `REPORTS_EXPORT`                                                           |
| `settings`    | `SETTINGS_READ` `SETTINGS_UPDATE` `SETTINGS_SYSTEM`                                       |
| `audit`       | `AUDIT_READ` `AUDIT_EXPORT`                                                               |

### Non délégables

`USERS_*` et `SETTINGS_SYSTEM` restent au `SUPER_ADMIN`. Toute tentative de
les accorder à un `ADMIN` échoue en `403 PERMISSION_NOT_DELEGABLE`.

### Sensibles

Les permissions marquées sensibles déclenchent un audit systématique :
création et modification d'administrateur, changement de permissions,
suspension, modification de prix, remboursement, annulation, attribution de
livreur, modification des paramètres.

## Socle par rôle

`ADMIN` reçoit par défaut 34 permissions : toute l'exploitation
(clients, livreurs sauf suppression, carte, commandes, paiements, livraisons,
promotions, rapports, paramètres du restaurant).

Il ne reçoit **pas** : `USERS_*`, `DRIVERS_DELETE`, `SETTINGS_SYSTEM`,
`AUDIT_READ`, `AUDIT_EXPORT`. Un `SUPER_ADMIN` peut lui accorder les trois
dernières au cas par cas.

## Matrice — qui peut quoi

| Action                          | CUSTOMER | DRIVER | ADMIN                 | SUPER_ADMIN |
| ------------------------------- | :------: | :----: | :-------------------: | :---------: |
| Consulter la carte              | ✅        | ✅      | ✅                     | ✅           |
| Voir les plats en rupture       | ❌        | ❌      | ✅                     | ✅           |
| Modifier la carte               | ❌        | ❌      | `MENU_*`               | ✅           |
| Créer une commande              | ✅        | ❌      | ❌                     | ❌           |
| Voir **ses** commandes          | ✅        | —      | —                     | —           |
| Voir **toutes** les commandes   | ❌        | ❌      | `ORDERS_READ`          | ✅           |
| Faire avancer une commande      | ❌        | ❌      | `ORDERS_UPDATE_STATUS` | ✅           |
| Annuler une commande            | ⚠️ limité | ❌      | `ORDERS_CANCEL`        | ✅           |
| Attribuer un livreur            | ❌        | ❌      | `ORDERS_ASSIGN_DRIVER` | ✅           |
| Voir **ses** courses            | ❌        | ✅      | —                     | —           |
| Confirmer une livraison (OTP)   | ❌        | ✅      | ❌                     | ❌           |
| Transmettre sa position         | ❌        | ✅      | ❌                     | ❌           |
| Suivre un livreur               | ⚠️ sa commande | —  | `DELIVERIES_TRACK`     | ✅           |
| Rembourser                      | ❌        | ❌      | `PAYMENTS_REFUND`      | ✅           |
| Gérer les clients               | ❌        | ❌      | `CUSTOMERS_*`          | ✅           |
| Créer un livreur                | ❌        | ❌      | `DRIVERS_CREATE`       | ✅           |
| Supprimer un livreur            | ❌        | ❌      | `DRIVERS_DELETE` (non accordé par défaut) | ✅ |
| Gérer les administrateurs       | ❌        | ❌      | ❌                     | `USERS_*`   |
| Modifier des permissions        | ❌        | ❌      | ❌                     | `USERS_PERMISSIONS` |
| Journal d'audit                 | ❌        | ❌      | ❌ (délégable)          | `AUDIT_READ` |
| Paramètres du restaurant        | ❌        | ❌      | `SETTINGS_UPDATE`      | ✅           |
| Paramètres système              | ❌        | ❌      | ❌                     | `SETTINGS_SYSTEM` |

⚠️ *Le client annule seul tant que la commande n'est pas en préparation et
dans la fenêtre configurée (10 min par défaut).*

## Isolation des données

| Règle                                                    | Où elle est appliquée                       |
| -------------------------------------------------------- | ------------------------------------------- |
| Un client ne lit que ses commandes                        | `OrdersService.assertCanRead`               |
| Un client ne gère que ses adresses                        | `AddressesService` — `userId` en signature  |
| Un livreur ne voit que ses courses                        | `DeliveriesService.findOneForDriver`        |
| Un livreur ne voit pas l'e-mail du client                 | `toDriverDeliveryDto`                       |
| Un client ne suit un livreur que pour sa commande active  | `DeliveriesService.locationForOrder`        |
| Le back-office ne reçoit jamais de condensat de mot de passe | `PUBLIC_USER_SELECT`                     |

Une ressource inaccessible renvoie le même message qu'une ressource
inexistante : on ne confirme pas l'existence d'une commande à quelqu'un qui
n'y a pas droit.

## Écrire une route protégée

```ts
@Patch(':id/status')
@Roles(Role.ADMIN, Role.SUPER_ADMIN)          // 1. rôle
@RequirePermissions('ORDERS_UPDATE_STATUS')    // 2. permission
@ApiEndpoint({                                 // 3. documentation
  summary: 'Faire avancer une commande',
  roles: [Role.ADMIN, Role.SUPER_ADMIN],
  permissions: ['ORDERS_UPDATE_STATUS'],
})
updateStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
  return this.orders.updateStatus(user, id, /* … */);  // 4. appartenance dans le service
}
```

Variantes : `@RequireAnyPermission(...)` (au moins une), `@Public()` (aucune
authentification), `@OptionalAuth()` (jeton lu s'il est présent — utilisé pour
la carte, que tout le monde consulte mais qu'un gestionnaire voit en entier).

## Tests

`src/common/guards/permissions.guard.spec.ts` couvre la matrice au niveau
unitaire ; `test/rbac.e2e-spec.ts` la rejoue contre l'API réelle, y compris
l'isolation entre deux clients et entre deux livreurs.
