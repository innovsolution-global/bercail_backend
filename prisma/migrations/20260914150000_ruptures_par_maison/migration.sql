-- ===========================================================================
--  Ruptures par maison
--
--  La carte est commune à toutes les maisons depuis le 14 septembre 2026 ;
--  la rupture, elle, ne l'est pas. Un gérant qui marque un plat « épuisé »
--  ne le fait que chez lui : une ligne ici veut dire « épuisé dans cette
--  maison », son absence « disponible ici ». `menu_items.isAvailable` reste
--  l'interrupteur de l'enseigne, celui qui retire un plat de toute la carte.
--
--  Quand la maison la plus proche d'un client n'a plus l'un des plats de sa
--  commande, celle-ci part chez la plus proche des autres qui a tout.
-- ===========================================================================

-- CreateTable
CREATE TABLE "menu_item_stockouts" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_stockouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_item_stockouts_restaurantId_idx" ON "menu_item_stockouts"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_stockouts_menuItemId_restaurantId_key" ON "menu_item_stockouts"("menuItemId", "restaurantId");

-- AddForeignKey
ALTER TABLE "menu_item_stockouts" ADD CONSTRAINT "menu_item_stockouts_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_stockouts" ADD CONSTRAINT "menu_item_stockouts_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Synchronisation local ↔ en ligne : la rupture est une donnée
-- d'exploitation, écrite sur place, comme le plat lui-même.
CREATE TRIGGER sync_menu_item_stockouts AFTER INSERT OR UPDATE OR DELETE ON "menu_item_stockouts"
  FOR EACH ROW EXECUTE FUNCTION sync_record_change('MenuItemStockout');
