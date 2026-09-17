-- La carte devient commune à toutes les maisons.
--
-- Catégories, plats et promotions n'appartiennent plus à un établissement :
-- l'enseigne tient une seule carte, que chaque maison sert. Le stock, les
-- achats, les dépenses, les recettes et le personnel restent propres à
-- chaque maison, pour que les comptes demeurent séparés.
--
-- Décision du propriétaire, 14 septembre 2026. Base sauvegardée juste avant
-- dans backups/bercail-avant-carte-commune-*.dump ; aucune catégorie, aucun
-- plat, aucune promotion n'existait au moment de la migration.

-- DropForeignKey
ALTER TABLE "categories" DROP CONSTRAINT "categories_restaurantId_fkey";
ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_restaurantId_fkey";
ALTER TABLE "promotions" DROP CONSTRAINT "promotions_restaurantId_fkey";

-- DropIndex
DROP INDEX "categories_restaurantId_idx";
DROP INDEX "categories_restaurantId_slug_key";
DROP INDEX "menu_items_restaurantId_idx";
DROP INDEX "promotions_restaurantId_code_key";
DROP INDEX "promotions_restaurantId_idx";

-- AlterTable
ALTER TABLE "categories" DROP COLUMN "restaurantId";
ALTER TABLE "menu_items" DROP COLUMN "restaurantId";
ALTER TABLE "promotions" DROP COLUMN "restaurantId";

-- Une seule « grillades » pour toute l'enseigne.
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");
