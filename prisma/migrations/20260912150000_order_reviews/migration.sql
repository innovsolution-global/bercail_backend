-- Les avis des clients : un par commande livrée.
--
-- Il porte la note de la maison, celle du livreur s'il y en a eu un, et
-- une note par plat. Les moyennes des maisons, des livreurs et des plats
-- sont recalculées à chaque avis déposé — jamais saisies à la main.
--
-- Les notes de plats vivaient jusqu'ici dans le téléphone du client et
-- n'arrivaient nulle part : une étoile qui ne compte pour rien est un
-- mensonge.

-- La maison reçoit sa note, nulle tant que personne n'a noté.
ALTER TABLE "restaurants" ADD COLUMN "rating" DOUBLE PRECISION,
ADD COLUMN "reviewCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "order_reviews" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "restaurantRating" INTEGER NOT NULL,
    "driverId" TEXT,
    "driverRating" INTEGER,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_item_reviews" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "rating" INTEGER NOT NULL,
    CONSTRAINT "order_item_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_reviews_orderId_key" ON "order_reviews"("orderId");
CREATE INDEX "order_reviews_restaurantId_idx" ON "order_reviews"("restaurantId");
CREATE INDEX "order_reviews_driverId_idx" ON "order_reviews"("driverId");
CREATE INDEX "order_reviews_customerId_idx" ON "order_reviews"("customerId");
CREATE UNIQUE INDEX "order_item_reviews_orderItemId_key" ON "order_item_reviews"("orderItemId");
CREATE INDEX "order_item_reviews_menuItemId_idx" ON "order_item_reviews"("menuItemId");

ALTER TABLE "order_reviews" ADD CONSTRAINT "order_reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_reviews" ADD CONSTRAINT "order_reviews_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_reviews" ADD CONSTRAINT "order_reviews_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_item_reviews" ADD CONSTRAINT "order_item_reviews_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "order_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item_reviews" ADD CONSTRAINT "order_item_reviews_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item_reviews" ADD CONSTRAINT "order_item_reviews_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
