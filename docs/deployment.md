# Déploiement

## Environnement

Toute la configuration passe par des variables d'environnement — voir
[`.env.example`](../.env.example) pour la liste complète et commentée.

### Obligatoires en production

| Variable             | Contrainte                                              |
| -------------------- | ------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL 14+                                          |
| `JWT_ACCESS_SECRET`  | ≥ 32 caractères, différent du refresh                   |
| `JWT_REFRESH_SECRET` | ≥ 32 caractères                                         |
| `REDIS_URL`          | Redis 7+                                                |
| `CORS_ORIGINS`       | Origines exactes, jamais `*`                            |

L'application **refuse de démarrer** si un secret manque, est trop court, ou
est resté à sa valeur d'exemple. Mieux vaut un crash au boot qu'une API signée
avec `dev-access-secret-change-me`.

```bash
# Générer un secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### À vérifier avant la mise en ligne

- [ ] `NODE_ENV=production`
- [ ] `SWAGGER_ENABLED=false`
- [ ] Mot de passe du `SUPER_ADMIN` changé
- [ ] `PAYMENT_SANDBOX=false` et identifiants opérateurs renseignés
- [ ] `STORAGE_DRIVER=s3` si le service tourne sur plusieurs instances
- [ ] `CORS_ORIGINS` limité aux domaines réels
- [ ] Sauvegardes PostgreSQL programmées et **restauration testée**

## Docker

```bash
# Environnement complet
docker compose up -d

# Schéma et données
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run seed        # démonstration uniquement
```

Ou seulement les dépendances, pour développer en local :

```bash
docker compose up -d postgres redis
npm run start:dev
```

L'image est construite en trois étages : dépendances, build, exécution. Elle
ne contient ni sources TypeScript, ni dépendances de développement, et tourne
sous l'utilisateur non privilégié `node`. Une `HEALTHCHECK` interroge
`/health/ready`.

## Migrations

```bash
# Développement — crée et applique une migration
npx prisma migrate dev --name description_du_changement

# Production — applique les migrations existantes, sans rien générer
npx prisma migrate deploy
```

> N'utilisez jamais `prisma db push` en production : il modifie le schéma sans
> laisser de trace de migration.

Séquence de déploiement recommandée :

1. sauvegarder la base ;
2. `prisma migrate deploy` ;
3. démarrer la nouvelle version ;
4. vérifier `/health`.

Pour un déploiement sans coupure, gardez les migrations **compatibles avec la
version précédente** (ajouter une colonne, puis la rendre obligatoire au
déploiement suivant).

## Reverse proxy

L'API lit `X-Forwarded-For` (`trust proxy` est activé) : sans cela, la
limitation de débit et le journal d'audit verraient l'IP du proxy.

```nginx
server {
    listen 443 ssl http2;
    server_name api.lebercail.gn;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /realtime/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 6M;   # cohérent avec STORAGE_MAX_FILE_SIZE
}
```

## Montée en charge

L'API est **sans état** : elle peut être répliquée.

| Composant       | Condition                                                     |
| --------------- | ------------------------------------------------------------- |
| API             | Réplicable telle quelle                                       |
| WebSocket       | Redis obligatoire (adaptateur de salons entre instances)       |
| Limitation débit| Redis obligatoire — sinon chaque instance a son propre quota   |
| Cache           | Redis partagé                                                 |
| Fichiers        | `STORAGE_DRIVER=s3` — le disque local n'est pas partagé        |
| Tâches planifiées | Attention : elles s'exécutent sur **chaque** instance. Les tâches actuelles sont idempotentes ; si vous en ajoutez, prévoyez un verrou (`RedisService.acquireLock`). |

## Sondes

| Route           | Usage                                              |
| --------------- | -------------------------------------------------- |
| `/health`       | État complet (base, cache, latence)                 |
| `/health/live`  | Vivacité — répond dès le démarrage du processus     |
| `/health/ready` | Disponibilité — vérifie que la base répond          |

Ces routes ne portent pas le préfixe `/api/v1`.

```yaml
# Kubernetes
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
  initialDelaySeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  initialDelaySeconds: 15
```

## Intégration continue

`.github/workflows/ci.yml` enchaîne :

1. installation et génération du client Prisma ;
2. lint et vérification des types ;
3. tests unitaires avec couverture ;
4. tests e2e contre PostgreSQL et Redis réels ;
5. construction de l'image Docker.

> Le workflow suppose un dépôt dont la racine contient `backend/`. Si votre
> dépôt Git est initialisé à la racine du projet, déplacez `backend/.github`
> vers la racine.

## Entretien automatique

Trois tâches planifiées, toutes idempotentes :

| Fréquence   | Tâche                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Horaire     | Purge des jetons expirés et des clés d'idempotence                      |
| 10 minutes  | Remise hors ligne des livreurs sans nouvelle depuis 30 min              |
| 3 h du matin| Rétention du journal d'audit + purge des positions GPS (30 jours)       |

## Sauvegarde et restauration

```bash
# Sauvegarde
docker compose exec postgres pg_dump -U bercail bercail | gzip > backup-$(date +%F).sql.gz

# Restauration
gunzip -c backup-2026-09-03.sql.gz | docker compose exec -T postgres psql -U bercail bercail
```

Pensez aussi au volume `uploads` si vous utilisez le stockage local — mais en
production, préférez S3.

## Observabilité

- Chaque requête porte un `X-Request-Id`, présent dans les logs **et** dans
  les réponses d'erreur : un incident se suit de bout en bout.
- Les logs contiennent : méthode, route, statut, durée, utilisateur, rôle.
- Ils ne contiennent **jamais** : mot de passe, jeton, code OTP, secret de
  paiement.
- `SENTRY_DSN` et `METRICS_ENABLED` sont prévus dans la configuration ; le
  branchement se fait par un intercepteur supplémentaire, sans toucher au
  métier.

## Incidents courants

| Symptôme                          | Cause probable                        | Action                                        |
| --------------------------------- | ------------------------------------- | --------------------------------------------- |
| Démarrage refusé                  | Secret manquant ou trop court         | Lire le message : il nomme la variable        |
| « Le restaurant n'est pas configuré » | Base non semée                    | `npm run seed` ou créer le restaurant         |
| Temps réel muet entre instances   | Redis absent                          | Renseigner `REDIS_URL`                        |
| Quotas de débit trop permissifs   | Redis absent (repli mémoire par instance) | Renseigner `REDIS_URL`                    |
| 403 inattendus après une mise à jour de permissions | Effet immédiat, c'est voulu | Vérifier les permissions du compte        |
| Images perdues après redéploiement | Stockage local sans volume           | Monter un volume ou passer à S3               |
