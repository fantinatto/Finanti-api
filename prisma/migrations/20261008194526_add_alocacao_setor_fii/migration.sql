-- CreateTable
CREATE TABLE "alocacoes_setor_fii" (
    "id" TEXT NOT NULL,
    "portfolioConfigId" TEXT NOT NULL,
    "setor" TEXT NOT NULL,
    "percentual" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "alocacoes_setor_fii_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alocacoes_setor_fii_portfolioConfigId_setor_key" ON "alocacoes_setor_fii"("portfolioConfigId", "setor");

-- AddForeignKey
ALTER TABLE "alocacoes_setor_fii" ADD CONSTRAINT "alocacoes_setor_fii_portfolioConfigId_fkey" FOREIGN KEY ("portfolioConfigId") REFERENCES "portfolio_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
