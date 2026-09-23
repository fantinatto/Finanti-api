-- CreateTable
CREATE TABLE "acoes" (
    "ticker" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "setor" TEXT,
    "subsetor" TEXT,
    "segmento" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acoes_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "indicadores_mensais" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "pl" DOUBLE PRECISION,
    "pvp" DOUBLE PRECISION,
    "pEbit" DOUBLE PRECISION,
    "roe" DOUBLE PRECISION,
    "roic" DOUBLE PRECISION,
    "roa" DOUBLE PRECISION,
    "margemBruta" DOUBLE PRECISION,
    "margemEbit" DOUBLE PRECISION,
    "margemLiquida" DOUBLE PRECISION,
    "dy" DOUBLE PRECISION,
    "dividaLiquidaPatrimonio" DOUBLE PRECISION,
    "dividaLiquidaEbitda" DOUBLE PRECISION,
    "cagrReceita5a" DOUBLE PRECISION,
    "cagrLucro5a" DOUBLE PRECISION,
    "lpa" DOUBLE PRECISION,
    "vpa" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicadores_mensais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medias_agrupamento" (
    "id" TEXT NOT NULL,
    "tipoGrupo" TEXT NOT NULL,
    "nomeGrupo" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "pl" DOUBLE PRECISION,
    "pvp" DOUBLE PRECISION,
    "pEbit" DOUBLE PRECISION,
    "roe" DOUBLE PRECISION,
    "roic" DOUBLE PRECISION,
    "roa" DOUBLE PRECISION,
    "margemBruta" DOUBLE PRECISION,
    "margemEbit" DOUBLE PRECISION,
    "margemLiquida" DOUBLE PRECISION,
    "dy" DOUBLE PRECISION,
    "dividaLiquidaPatrimonio" DOUBLE PRECISION,
    "dividaLiquidaEbitda" DOUBLE PRECISION,
    "cagrReceita5a" DOUBLE PRECISION,
    "cagrLucro5a" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medias_agrupamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores_normalizados" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "tipoGrupo" TEXT NOT NULL,
    "nomeGrupo" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "pl_norm" DOUBLE PRECISION,
    "pvp_norm" DOUBLE PRECISION,
    "pEbit_norm" DOUBLE PRECISION,
    "roe_norm" DOUBLE PRECISION,
    "roic_norm" DOUBLE PRECISION,
    "roa_norm" DOUBLE PRECISION,
    "margemBruta_norm" DOUBLE PRECISION,
    "margemEbit_norm" DOUBLE PRECISION,
    "margemLiquida_norm" DOUBLE PRECISION,
    "dy_norm" DOUBLE PRECISION,
    "dividaLiquidaPatrimonio_norm" DOUBLE PRECISION,
    "dividaLiquidaEbitda_norm" DOUBLE PRECISION,
    "cagrReceita5a_norm" DOUBLE PRECISION,
    "cagrLucro5a_norm" DOUBLE PRECISION,
    "scoreQualidade" DOUBLE PRECISION,
    "scoreRisco" DOUBLE PRECISION,
    "scorePreco" DOUBLE PRECISION,
    "scoreFinal" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_normalizados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "indicadores_mensais_ticker_anoMes_key" ON "indicadores_mensais"("ticker", "anoMes");

-- CreateIndex
CREATE UNIQUE INDEX "medias_agrupamento_tipoGrupo_nomeGrupo_anoMes_key" ON "medias_agrupamento"("tipoGrupo", "nomeGrupo", "anoMes");

-- CreateIndex
CREATE UNIQUE INDEX "scores_normalizados_ticker_tipoGrupo_nomeGrupo_anoMes_key" ON "scores_normalizados"("ticker", "tipoGrupo", "nomeGrupo", "anoMes");

-- AddForeignKey
ALTER TABLE "indicadores_mensais" ADD CONSTRAINT "indicadores_mensais_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "acoes"("ticker") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores_normalizados" ADD CONSTRAINT "scores_normalizados_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "acoes"("ticker") ON DELETE CASCADE ON UPDATE CASCADE;
