-- AlterTable
ALTER TABLE "users" ADD COLUMN     "birthDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "portfolio_config" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "percentualRendaFixa" DOUBLE PRECISION NOT NULL,
    "percentualFiis" DOUBLE PRECISION NOT NULL,
    "percentualAcoes" DOUBLE PRECISION NOT NULL,
    "percentualEstouro" DOUBLE PRECISION NOT NULL,
    "regraSelecionada" TEXT,
    "baseRegraCustom" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alocacoes_setor" (
    "id" TEXT NOT NULL,
    "portfolioConfigId" TEXT NOT NULL,
    "setor" TEXT NOT NULL,
    "percentual" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "alocacoes_setor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alocacoes_segmento_fii" (
    "id" TEXT NOT NULL,
    "portfolioConfigId" TEXT NOT NULL,
    "segmento" TEXT NOT NULL,
    "percentual" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "alocacoes_segmento_fii_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_config_userId_key" ON "portfolio_config"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "alocacoes_setor_portfolioConfigId_setor_key" ON "alocacoes_setor"("portfolioConfigId", "setor");

-- CreateIndex
CREATE UNIQUE INDEX "alocacoes_segmento_fii_portfolioConfigId_segmento_key" ON "alocacoes_segmento_fii"("portfolioConfigId", "segmento");

-- AddForeignKey
ALTER TABLE "portfolio_config" ADD CONSTRAINT "portfolio_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alocacoes_setor" ADD CONSTRAINT "alocacoes_setor_portfolioConfigId_fkey" FOREIGN KEY ("portfolioConfigId") REFERENCES "portfolio_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alocacoes_segmento_fii" ADD CONSTRAINT "alocacoes_segmento_fii_portfolioConfigId_fkey" FOREIGN KEY ("portfolioConfigId") REFERENCES "portfolio_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
