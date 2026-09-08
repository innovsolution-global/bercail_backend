-- ===========================================================================
--  Multi-établissements
--
--  Le système a été bâti pour un seul restaurant : la carte, le stock, les
--  achats, les dépenses et le personnel étaient globaux. Ils appartiennent
--  désormais chacun à un établissement.
--
--  Les données existantes sont rattachées au restaurant en place — celui
--  créé en premier. Aucune ligne n'est perdue et rien ne change pour lui.
-- ===========================================================================

-- ───────────────────── Identité de l'établissement ────────────────────────

ALTER TABLE "restaurants"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Un code lisible pour l'existant ; les suivants seront saisis à la création.
UPDATE "restaurants" SET "code" = 'BRC' WHERE "code" IS NULL;

ALTER TABLE "restaurants" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "restaurants_code_key" ON "restaurants"("code");
CREATE INDEX "restaurants_isActive_idx" ON "restaurants"("isActive");

-- ───────────────────── Rattachement des comptes ───────────────────────────

ALTER TABLE "users" ADD COLUMN "restaurantId" TEXT;

-- Les administrateurs et les livreurs existants rejoignent l'établissement
-- en place. Les clients n'en ont pas : ils commandent où ils veulent. Le
-- SUPER_ADMIN non plus : il les voit tous.
UPDATE "users"
   SET "restaurantId" = (SELECT "id" FROM "restaurants" ORDER BY "createdAt" ASC LIMIT 1)
 WHERE "role" IN ('ADMIN', 'DRIVER');

ALTER TABLE "users" ADD CONSTRAINT "users_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "users_restaurantId_idx" ON "users"("restaurantId");

-- ───────────────────── Rattachement des données ───────────────────────────
--
-- Même traitement pour les dix tables d'exploitation : on ajoute la colonne,
-- on rattache l'existant au restaurant en place, puis on rend la colonne
-- obligatoire. Faire l'inverse échouerait sur la première ligne.

DO $$
DECLARE
  tables text[] := ARRAY[
    'categories', 'menu_items', 'suppliers', 'stock_items', 'stock_movements',
    'purchases', 'expenses', 'incomes', 'employees', 'promotions'
  ];
  entry text;
  first_restaurant text;
BEGIN
  SELECT "id" INTO first_restaurant FROM "restaurants" ORDER BY "createdAt" ASC LIMIT 1;

  FOREACH entry IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN "restaurantId" TEXT', entry);

    IF first_restaurant IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET "restaurantId" = %L', entry, first_restaurant);
    END IF;

    -- Une table vide sur une base neuve n'empêche pas la contrainte.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "restaurantId" SET NOT NULL', entry);

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("restaurantId")
         REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      entry, entry || '_restaurantId_fkey'
    );

    EXECUTE format('CREATE INDEX %I ON %I("restaurantId")', entry || '_restaurantId_idx', entry);
  END LOOP;
END;
$$;

-- ───────────────────── Unicité par établissement ──────────────────────────
--
-- Un code d'article, un slug de rubrique ou un code promotionnel n'a de sens
-- que dans son établissement : deux restaurants indépendants doivent pouvoir
-- utiliser les mêmes sans se gêner.

DROP INDEX IF EXISTS "stock_items_reference_key";
CREATE UNIQUE INDEX "stock_items_restaurantId_reference_key"
  ON "stock_items"("restaurantId", "reference");

DROP INDEX IF EXISTS "categories_slug_key";
CREATE UNIQUE INDEX "categories_restaurantId_slug_key"
  ON "categories"("restaurantId", "slug");

DROP INDEX IF EXISTS "promotions_code_key";
CREATE UNIQUE INDEX "promotions_restaurantId_code_key"
  ON "promotions"("restaurantId", "code");

-- La table « restaurants » est déjà suivie par la synchronisation : son
-- déclencheur a été posé avec les trente-deux autres.
