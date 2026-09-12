-- Visuel des cartes promotionnelles.
--
-- Nullable et sans valeur par défaut : les promotions existantes restent
-- valables sans image, et la carte se présente alors sans visuel plutôt
-- qu'avec une adresse cassée.
ALTER TABLE "promotions" ADD COLUMN "imageUrl" TEXT;
