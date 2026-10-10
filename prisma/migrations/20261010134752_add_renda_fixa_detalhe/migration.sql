-- CreateTable
CREATE TABLE "renda_fixa_detalhes" (
    "id" TEXT NOT NULL,
    "investimentoId" TEXT NOT NULL,
    "tipoRentabilidade" TEXT NOT NULL,
    "percentualOuTaxa" DOUBLE PRECISION NOT NULL,
    "dataAplicacao" TIMESTAMP(3) NOT NULL,
    "dataVencimento" TIMESTAMP(3) NOT NULL,
    "isentoIr" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renda_fixa_detalhes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "renda_fixa_detalhes_investimentoId_key" ON "renda_fixa_detalhes"("investimentoId");

-- AddForeignKey
ALTER TABLE "renda_fixa_detalhes" ADD CONSTRAINT "renda_fixa_detalhes_investimentoId_fkey" FOREIGN KEY ("investimentoId") REFERENCES "investimentos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
