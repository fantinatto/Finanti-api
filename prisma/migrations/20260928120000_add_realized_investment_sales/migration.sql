-- CreateTable
CREATE TABLE "vendas_investimentos" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "ticker" TEXT,
    "nome" TEXT NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "precoUnitario" DOUBLE PRECISION NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "custos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ganhoRealizado" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendas_investimentos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendas_investimentos_userId_createdAt_idx" ON "vendas_investimentos"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "vendas_investimentos" ADD CONSTRAINT "vendas_investimentos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
