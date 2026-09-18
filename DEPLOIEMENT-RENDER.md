# Le serveur hébergé (Render)

`https://bercail-backend.onrender.com/api/v1`

L'application mobile et le back-office pointent dessus par défaut. Ce
fichier dit ce que le serveur attend pour fonctionner **complètement** :
au 18 septembre 2026, il répond, mais sa base est vide et plusieurs
services sont muets faute de variables.

## 1. La base est vide

`GET /api/v1/restaurant` répond « Le restaurant n'est pas configuré ».
Sans établissement, aucune carte, aucune commande, aucune connexion.

Deux façons de la peupler, au choix :

- **Repartir de zéro** : `npm run seed` sur le serveur, avec
  `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` définis.
- **Reprendre les données locales** (les deux maisons, la carte, les
  comptes) : restaurer le dernier dump de `backend/backups/` dans la base
  Render.

  ```bash
  pg_restore --no-owner --clean --if-exists \
    --dbname="<DATABASE_URL de Render, sans ?schema=>" \
    backups/bercail-2026-09-18T08-27-58.dump
  ```

  Les migrations doivent être appliquées d'abord : `npm run prisma:apply`.

## 2. Les variables d'environnement

**Tout est prêt dans `backend/render.env`** (ignoré par git : il contient
des secrets). Dans Render → votre service → **Environment** → *Add from
.env* : collez le contenu du fichier, puis *Save changes*. Render
redéploie tout seul.

Deux valeurs y sont **nouvelles**, pas reprises de votre machine :
`JWT_ACCESS_SECRET` et `JWT_REFRESH_SECRET`. Un secret de développement
qui fuite ne doit pas ouvrir la production.

Ne touchez pas à `DATABASE_URL` ni à `PORT` : Render les fournit.

Le détail de ce que chaque groupe débloque :

Obligatoires en production (le serveur refuse de démarrer sans) :
`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`.

À ajouter pour que tout marche :

| Variable | Valeur | Sans elle |
| --- | --- | --- |
| `CORS_ORIGINS` | l'adresse du back-office déployé | le back-office est refusé par le serveur |
| `BACK_OFFICE_URL` | idem | le lien « mot de passe oublié » des e-mails pointe sur localhost |
| `MAIL_DRIVER=smtp`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` | le compte Gmail | aucun e-mail : ni code de réinitialisation, ni accès d'un nouvel admin |
| `PUSH_DRIVER=fcm` + la clé du compte de service | voir ci-dessous | aucune notification push |
| `CHAPCHAP_*` | les clés de Chap Chap, `CHAPCHAP_PUBLIC_BASE_URL=https://bercail-backend.onrender.com` | pas de paiement en ligne — et surtout, plus besoin du tunnel ngrok |
| `REDIS_URL` | une instance Redis | le cache reste « degraded » (le serveur marche, en relisant plus souvent la base) |

La clé Firebase ne peut pas être un fichier sur Render : recopier ses
trois champs dans `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`
(les retours à la ligne de la clé privée s'écrivent `\n`).

## 3. Le réveil du serveur

L'offre gratuite de Render endort le serveur après quinze minutes sans
requête ; le réveil prend jusqu'à une minute. L'application l'absorbe
(délai de réception porté à 75 s hors local), mais la première requête de
la journée reste lente. Une offre payante, ou un appel régulier de
`/health`, supprime l'attente.

## 4. Travailler contre le serveur local

L'adresse par défaut ne bloque rien : elle se remplace au lancement.

```bash
flutter run --dart-define=API_BASE_URL=http://localhost:3000/api/v1
flutter build apk --debug --dart-define=API_BASE_URL=http://localhost:3000/api/v1
```

Avec `adb reverse tcp:3000 tcp:3000` (ou `tool/adb-reverse.ps1`) pour un
téléphone relié en USB.

Back-office : `npm run dev` lit `.env` (local) ; `npm run build` lit
`.env.production` (Render).
