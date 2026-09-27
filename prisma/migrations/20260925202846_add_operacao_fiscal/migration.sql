-- CreateTable
CREATE TABLE "operacoes_fiscais" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "ticker" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "tradeType" TEXT NOT NULL DEFAULT 'swing',
    "quantidade" DOUBLE PRECISION NOT NULL,
    "precoUnitario" DOUBLE PRECISION NOT NULL,
    "custos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operacoes_fiscais_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operacoes_fiscais_userId_ticker_data_idx" ON "operacoes_fiscais"("userId", "ticker", "data");

-- AddForeignKey
ALTER TABLE "operacoes_fiscais" ADD CONSTRAINT "operacoes_fiscais_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
