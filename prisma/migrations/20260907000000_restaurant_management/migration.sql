-- ===========================================================================
--  Gestion d'exploitation : caisse (POS), argent, stock, personnel.
--
--  1. Les commandes peuvent naître au comptoir : `customerId` devient
--     facultatif, une commande de caisse n'ayant pas de compte client.
--  2. Le paiement suit la même règle.
--  3. Nouvelles tables : fournisseurs, stock, achats, dépenses, recettes,
--     employés.
-- ===========================================================================

-- ─────────────────────────── Énumérations ─────────────────────────────────

CREATE TYPE "OrderChannel" AS ENUM ('ONLINE', 'POS');

CREATE TYPE "StockUnit" AS ENUM ('KG', 'G', 'L', 'ML', 'PIECE', 'SAC', 'CARTON', 'BOUTEILLE', 'PLAQUE', 'BOTTE');

CREATE TYPE "StockCategory" AS ENUM ('VIANDE', 'POISSON', 'LEGUME', 'FRUIT', 'EPICERIE', 'BOISSON', 'EMBALLAGE', 'ENTRETIEN', 'AUTRE');

CREATE TYPE "StockMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

CREATE TYPE "StockMovementReason" AS ENUM ('PURCHASE', 'PREPARATION', 'WASTE', 'INVENTORY', 'RETURN', 'OTHER');

CREATE TYPE "ExpenseCategory" AS ENUM ('INGREDIENTS', 'BOISSONS', 'EMBALLAGE', 'ELECTRICITE', 'EAU', 'LOYER', 'SALAIRE', 'CARBURANT', 'TRANSPORT', 'MAINTENANCE', 'EQUIPEMENT', 'MARKETING', 'TAXES', 'COMMUNICATION', 'AUTRE');

CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

CREATE TYPE "IncomeCategory" AS ENUM ('LOCATION_SALLE', 'EVENEMENT', 'SUBVENTION', 'REMBOURSEMENT', 'APPORT', 'AUTRE');

CREATE TYPE "FinancePaymentMethod" AS ENUM ('CASH', 'ORANGE_MONEY', 'MTN_MONEY', 'VIREMENT', 'CHEQUE', 'CARTE', 'AUTRE');

CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

CREATE TYPE "ContractType" AS ENUM ('CDI', 'CDD', 'JOURNALIER', 'STAGE', 'PRESTATAIRE');

-- ───────────────────── Commandes au comptoir ──────────────────────────────

ALTER TABLE "orders" ALTER COLUMN "customerId" DROP NOT NULL;

ALTER TABLE "orders"
  ADD COLUMN "channel" "OrderChannel" NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN "walkInName" TEXT,
  ADD COLUMN "walkInPhone" TEXT,
  ADD COLUMN "tableNumber" TEXT,
  ADD COLUMN "amountReceived" INTEGER,
  ADD COLUMN "changeGiven" INTEGER,
  ADD COLUMN "servedById" TEXT;

ALTER TABLE "orders" ADD CONSTRAINT "orders_servedById_fkey"
  FOREIGN KEY ("servedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "orders_channel_idx" ON "orders"("channel");

ALTER TABLE "payments" ALTER COLUMN "customerId" DROP NOT NULL;

-- ─────────────────────────── Fournisseurs ─────────────────────────────────

CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "speciality" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");
CREATE INDEX "suppliers_isActive_idx" ON "suppliers"("isActive");

-- ────────────────────────────── Stock ─────────────────────────────────────

CREATE TABLE "stock_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reference" TEXT,
    "category" "StockCategory" NOT NULL DEFAULT 'AUTRE',
    "unit" "StockUnit" NOT NULL DEFAULT 'KG',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "averageCost" INTEGER NOT NULL DEFAULT 0,
    "lastPurchaseCost" INTEGER,
    "lastPurchaseAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_items_reference_key" ON "stock_items"("reference");
CREATE INDEX "stock_items_category_idx" ON "stock_items"("category");
CREATE INDEX "stock_items_isActive_idx" ON "stock_items"("isActive");

CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "reason" "StockMovementReason" NOT NULL DEFAULT 'OTHER',
    "quantity" DOUBLE PRECISION NOT NULL,
    "quantityAfter" DOUBLE PRECISION NOT NULL,
    "unitCost" INTEGER NOT NULL DEFAULT 0,
    "totalCost" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "purchaseId" TEXT,
    "createdById" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_movements_stockItemId_idx" ON "stock_movements"("stockItemId");
CREATE INDEX "stock_movements_occurredAt_idx" ON "stock_movements"("occurredAt");
CREATE INDEX "stock_movements_type_idx" ON "stock_movements"("type");

-- ────────────────────────────── Achats ────────────────────────────────────

CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "supplierId" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAmount" INTEGER NOT NULL,
    "paymentMethod" "FinancePaymentMethod" NOT NULL DEFAULT 'CASH',
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PAID',
    "invoiceNumber" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchases_reference_key" ON "purchases"("reference");
CREATE INDEX "purchases_purchasedAt_idx" ON "purchases"("purchasedAt");
CREATE INDEX "purchases_supplierId_idx" ON "purchases"("supplierId");

CREATE TABLE "purchase_items" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "stockItemId" TEXT,
    "name" TEXT NOT NULL,
    "unit" "StockUnit" NOT NULL DEFAULT 'KG',
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_items_purchaseId_idx" ON "purchase_items"("purchaseId");

-- ───────────────────── Dépenses, recettes, personnel ──────────────────────

CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "position" TEXT NOT NULL,
    "contractType" "ContractType" NOT NULL DEFAULT 'CDI',
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "baseSalary" INTEGER NOT NULL DEFAULT 0,
    "hiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employees_userId_key" ON "employees"("userId");
CREATE INDEX "employees_status_idx" ON "employees"("status");
CREATE INDEX "employees_position_idx" ON "employees"("position");

CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PAID',
    "paymentMethod" "FinancePaymentMethod" NOT NULL DEFAULT 'CASH',
    "incurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "period" TEXT,
    "supplierId" TEXT,
    "employeeId" TEXT,
    "purchaseId" TEXT,
    "invoiceNumber" TEXT,
    "note" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expenses_reference_key" ON "expenses"("reference");
CREATE UNIQUE INDEX "expenses_purchaseId_key" ON "expenses"("purchaseId");
CREATE INDEX "expenses_category_idx" ON "expenses"("category");
CREATE INDEX "expenses_status_idx" ON "expenses"("status");
CREATE INDEX "expenses_incurredAt_idx" ON "expenses"("incurredAt");
CREATE INDEX "expenses_period_idx" ON "expenses"("period");

CREATE TABLE "incomes" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "IncomeCategory" NOT NULL DEFAULT 'AUTRE',
    "amount" INTEGER NOT NULL,
    "method" "FinancePaymentMethod" NOT NULL DEFAULT 'CASH',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "incomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incomes_reference_key" ON "incomes"("reference");
CREATE INDEX "incomes_receivedAt_idx" ON "incomes"("receivedAt");
CREATE INDEX "incomes_category_idx" ON "incomes"("category");

-- ───────────────────────── Clés étrangères ────────────────────────────────

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stockItemId_fkey"
  FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_stockItemId_fkey"
  FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employees" ADD CONSTRAINT "employees_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "incomes" ADD CONSTRAINT "incomes_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
