-- CreateTable
CREATE TABLE "fiis" (
    "ticker" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipoFundo" TEXT,
    "segmento" TEXT,
    "gestao" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiis_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "indicadores_mensais_fii" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "precoFechamento" DOUBLE PRECISION,
    "dy" DOUBLE PRECISION,
    "pvp" DOUBLE PRECISION,
    "valorPatrimonialCota" DOUBLE PRECISION,
    "liquidezMediaDiaria" DOUBLE PRECISION,
    "percentualCaixa" DOUBLE PRECISION,
    "dividendCagr" DOUBLE PRECISION,
    "cotaCagr" DOUBLE PRECISION,
    "numeroCotistas" INTEGER,
    "numeroCotas" INTEGER,
    "patrimonio" DOUBLE PRECISION,
    "lastDividend" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicadores_mensais_fii_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "indicadores_mensais_fii_ticker_anoMes_key" ON "indicadores_mensais_fii"("ticker", "anoMes");

-- AddForeignKey
ALTER TABLE "indicadores_mensais_fii" ADD CONSTRAINT "indicadores_mensais_fii_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "fiis"("ticker") ON DELETE CASCADE ON UPDATE CASCADE;
