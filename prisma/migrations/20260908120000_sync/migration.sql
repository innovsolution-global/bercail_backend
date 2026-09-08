-- ===========================================================================
--  Synchronisation local ↔ en ligne
--
--  Le journal des écritures n'est pas alimenté par le code applicatif mais
--  par des déclencheurs : c'est la seule façon de garantir qu'aucune
--  écriture n'y échappe, y compris celles d'une requête SQL directe, d'un
--  script de maintenance ou d'un chemin de code qu'on aurait oublié.
-- ===========================================================================

CREATE TYPE "SyncNode" AS ENUM ('LOCAL', 'CLOUD');
CREATE TYPE "SyncOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL,
    "origin" "SyncNode" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" "SyncOperation" NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_outbox_status_occurredAt_idx" ON "sync_outbox"("status", "occurredAt");
CREATE INDEX "sync_outbox_entity_entityId_idx" ON "sync_outbox"("entity", "entityId");
CREATE INDEX "sync_outbox_occurredAt_idx" ON "sync_outbox"("occurredAt");

CREATE TABLE "sync_applied" (
    "id" TEXT NOT NULL,
    "origin" "SyncNode" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_applied_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_applied_appliedAt_idx" ON "sync_applied"("appliedAt");
CREATE INDEX "sync_applied_entity_entityId_idx" ON "sync_applied"("entity", "entityId");

CREATE TABLE "sync_conflicts" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "origin" "SyncNode" NOT NULL,
    "incoming" JSONB NOT NULL,
    "existing" JSONB,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_conflicts_resolvedAt_idx" ON "sync_conflicts"("resolvedAt");
CREATE INDEX "sync_conflicts_entity_entityId_idx" ON "sync_conflicts"("entity", "entityId");

CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL DEFAULT 'sync',
    "node" "SyncNode" NOT NULL,
    "cursor" TIMESTAMP(3),
    "lastPushAt" TIMESTAMP(3),
    "lastPullAt" TIMESTAMP(3),
    "lastError" TEXT,
    "pushedCount" INTEGER NOT NULL DEFAULT 0,
    "pulledCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- ───────────────────── Identité du nœud ───────────────────────────────────
--
-- Elle est portée par la base elle-même, pas par la session : un pool de
-- connexions rouvre des sessions en permanence, et une identité posée par
-- session finirait par manquer sur l'une d'elles.
--
-- À l'installation du nœud en ligne, exécuter :
--     ALTER DATABASE <base> SET app.sync_node = 'CLOUD';
-- Le nœud local garde la valeur par défaut.

-- ───────────────────── Déclencheur d'écriture ─────────────────────────────

CREATE OR REPLACE FUNCTION sync_record_change() RETURNS trigger AS $$
DECLARE
  payload   jsonb;
  operation "SyncOperation";
  entity_id text;
  node      "SyncNode";
BEGIN
  -- Garde anti-écho : une écriture reçue du pair ne repart pas vers lui.
  -- Sans elle, chaque changement ferait des allers-retours sans fin entre
  -- les deux serveurs.
  IF current_setting('app.sync_apply', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    payload := to_jsonb(OLD);
    operation := 'DELETE';
    entity_id := OLD.id;
  ELSIF TG_OP = 'INSERT' THEN
    payload := to_jsonb(NEW);
    operation := 'CREATE';
    entity_id := NEW.id;
  ELSE
    payload := to_jsonb(NEW);
    operation := 'UPDATE';
    entity_id := NEW.id;
  END IF;

  node := COALESCE(NULLIF(current_setting('app.sync_node', true), ''), 'LOCAL')::"SyncNode";

  INSERT INTO sync_outbox ("id", "origin", "entity", "entityId", "operation", "payload", "occurredAt", "status", "attempts", "createdAt")
  VALUES (gen_random_uuid()::text, node, TG_ARGV[0], entity_id, operation, payload, clock_timestamp(), 'PENDING', 0, clock_timestamp());

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ───────────────────── Tables suivies ─────────────────────────────────────
--
-- Volontairement pas toutes. Sont exclus :
--   • les jetons et secrets (refresh_tokens, auth_tokens, codes de remise) —
--     une session n'a pas à voyager ;
--   • les positions GPS des livreurs — gros volume, sans valeur différée ;
--   • les paniers et favoris — état de travail du client, pas une donnée
--     d'exploitation ;
--   • le journal d'audit et les notifications — chaque nœud garde le sien ;
--   • les tables de synchronisation elles-mêmes, évidemment.

DO $$
DECLARE
  -- Nom de table PostgreSQL → nom logique de l'entité côté application.
  tracked text[][] := ARRAY[
    -- Exploitation : écrite sur place.
    ['menu_items', 'MenuItem'],
    ['categories', 'Category'],
    ['menu_option_groups', 'MenuOptionGroup'],
    ['menu_options', 'MenuOption'],
    ['recipe_ingredients', 'RecipeIngredient'],
    ['stock_items', 'StockItem'],
    ['stock_movements', 'StockMovement'],
    ['suppliers', 'Supplier'],
    ['purchases', 'Purchase'],
    ['purchase_items', 'PurchaseItem'],
    ['expenses', 'Expense'],
    ['incomes', 'Income'],
    ['employees', 'Employee'],
    ['promotions', 'Promotion'],
    ['restaurants', 'Restaurant'],
    ['opening_hours', 'OpeningHour'],
    ['system_settings', 'SystemSettings'],
    ['permissions', 'Permission'],
    ['role_permissions', 'RolePermission'],
    ['user_permissions', 'UserPermission'],
    -- Clientèle : écrite en ligne.
    ['users', 'User'],
    ['customer_profiles', 'CustomerProfile'],
    ['driver_profiles', 'DriverProfile'],
    ['addresses', 'Address'],
    ['deliveries', 'Delivery'],
    ['delivery_events', 'DeliveryEvent'],
    -- Partagé : créé des deux côtés, jamais modifié par les deux.
    ['orders', 'Order'],
    ['order_items', 'OrderItem'],
    ['order_item_options', 'OrderItemOption'],
    ['order_status_history', 'OrderStatusHistory'],
    ['payments', 'Payment'],
    ['payment_events', 'PaymentEvent'],
    ['coupon_usages', 'CouponUsage']
  ];
  entry text[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY tracked LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION sync_record_change(%L)',
      'sync_' || entry[1], entry[1], entry[2]
    );
  END LOOP;
END;
$$;
