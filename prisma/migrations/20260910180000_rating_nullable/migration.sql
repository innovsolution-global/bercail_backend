-- La note n'est plus inventée.
--
-- `rating` valait 5 par défaut sur les livreurs comme sur les plats, alors
-- qu'aucun système d'avis ne la calcule. Un livreur inscrit le matin
-- affichait « 5.0 / 5 » à côté de « 0 livraison terminée », et un plat
-- ajouté à la carte se présentait comme excellent sans qu'un seul client
-- l'ait goûté. Une note inventée se lit comme une note méritée.
--
-- Elle devient donc nulle par défaut : « pas encore noté ».

ALTER TABLE "driver_profiles" ALTER COLUMN "rating" DROP DEFAULT;
ALTER TABLE "driver_profiles" ALTER COLUMN "rating" DROP NOT NULL;

ALTER TABLE "menu_items" ALTER COLUMN "rating" DROP DEFAULT;
ALTER TABLE "menu_items" ALTER COLUMN "rating" DROP NOT NULL;

-- Les notes déjà en base qui ne reposent sur rien sont effacées. Celles
-- adossées à un historique réel — des avis, des courses terminées — sont
-- conservées : les effacer perdrait de l'information exacte.
UPDATE "driver_profiles" SET "rating" = NULL WHERE "completedDeliveries" = 0;
UPDATE "menu_items"      SET "rating" = NULL WHERE "reviewCount" = 0;
