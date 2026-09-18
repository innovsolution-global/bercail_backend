# =============================================================================
#  LE BERCAIL — image de production
#  Construction en trois étages : dépendances, build, exécution.
#  L'image finale ne contient ni sources TypeScript, ni dépendances de
#  développement, et tourne sous un utilisateur non privilégié.
# =============================================================================

# ── 1. Dépendances ───────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Prisma a besoin d'OpenSSL pour ses moteurs.
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# ── 2. Build ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate
RUN npm run build

# On ne garde que les dépendances de production pour l'image finale.
RUN npm prune --omit=dev

# ── 3. Exécution ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl dumb-init

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# Dossier des fichiers téléversés (pilote local).
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node

EXPOSE 3000

# Sonde de disponibilité : l'orchestrateur ne route le trafic que si la
# base répond.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

# Les migrations sont jouees avant le demarrage : un conteneur qui se lance
# sur une base vide doit la mettre a niveau lui-meme, sinon la premiere
# requete echoue sur des tables absentes. `migrate deploy` est idempotent
# (il n'applique que ce qui manque) et prend un verrou : deux instances qui
# demarrent ensemble ne se marchent pas dessus.
#
# `exec` rend la main a node comme processus principal, pour que dumb-init
# lui transmette bien les signaux d'arret.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main"]
