-- ===========================================================================
--  Fiches techniques : ce qu'un plat consomme réellement en réserve.
--
--  Le maillon manquant de la chaîne « achat → préparation → vente » : les
--  approvisionnements faisaient monter le stock, les ventes ne le faisaient
--  pas descendre. Désormais, chaque plat déclare ses ingrédients et leurs
--  quantités, et la mise en préparation d'une commande sort la matière.
-- ===========================================================================

CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- Un article n'apparaît qu'une fois par fiche : deux lignes de poulet sur le
-- même plat seraient une erreur de saisie, pas une recette.
CREATE UNIQUE INDEX "recipe_ingredients_menuItemId_stockItemId_key"
  ON "recipe_ingredients"("menuItemId", "stockItemId");

CREATE INDEX "recipe_ingredients_stockItemId_idx" ON "recipe_ingredients"("stockItemId");

ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_stockItemId_fkey"
  FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La commande retient si sa matière a déjà été sortie, pour ne jamais la
-- déduire deux fois.
ALTER TABLE "orders" ADD COLUMN "stockConsumedAt" TIMESTAMP(3);
