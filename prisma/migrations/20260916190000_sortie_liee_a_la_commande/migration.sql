-- ===========================================================================
--  La sortie de stock retient sa commande
--
--  Une sortie « préparation » notait la référence de la commande dans un
--  texte libre, et rien d'autre. Pour dire ce qu'un achat a rapporté — les
--  ventes faites avec la marchandise achetée, jusqu'à son épuisement —, il
--  faut retrouver les commandes servies avec chaque lot. D'où la clé.
-- ===========================================================================

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN "orderId" TEXT;

-- CreateIndex
CREATE INDEX "stock_movements_orderId_idx" ON "stock_movements"("orderId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Les sorties déjà passées : la commande se retrouve par sa référence,
-- notée dans le texte du mouvement (« Préparation BRC-260914-VPSW »).
UPDATE "stock_movements" m
   SET "orderId" = o.id
  FROM "orders" o
 WHERE m."orderId" IS NULL
   AND m."reason" = 'PREPARATION'
   AND m."note" = 'Préparation ' || o."reference";
