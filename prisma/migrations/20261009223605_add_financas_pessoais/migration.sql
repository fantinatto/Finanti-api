-- CreateTable
CREATE TABLE "gastos_mensais" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "formaPagamento" TEXT,
    "valor" DOUBLE PRECISION NOT NULL,
    "pago" BOOLEAN NOT NULL DEFAULT false,
    "dataVencimento" TIMESTAMP(3),
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gastos_mensais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ganhos_mensais" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "recebido" BOOLEAN NOT NULL DEFAULT false,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ganhos_mensais_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gastos_mensais_userId_anoMes_idx" ON "gastos_mensais"("userId", "anoMes");

-- CreateIndex
CREATE INDEX "ganhos_mensais_userId_anoMes_idx" ON "ganhos_mensais"("userId", "anoMes");

-- AddForeignKey
ALTER TABLE "gastos_mensais" ADD CONSTRAINT "gastos_mensais_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ganhos_mensais" ADD CONSTRAINT "ganhos_mensais_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
