-- AlterTable
ALTER TABLE "investimentos" ADD COLUMN     "carteira" TEXT NOT NULL DEFAULT 'real';

-- CreateTable
CREATE TABLE "transacoes_simulacao" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "preco" DOUBLE PRECISION NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "origem" TEXT NOT NULL,
    "motivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transacoes_simulacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulacao_config" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aporteSemanalValor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ultimoAporteAplicadoEm" TIMESTAMP(3),
    "simulacaoIniciadaEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulacao_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historico_carteira" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "carteira" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "valorTotal" DOUBLE PRECISION NOT NULL,
    "valorInvestidoTotal" DOUBLE PRECISION NOT NULL,
    "valorPorAcoes" DOUBLE PRECISION NOT NULL,
    "valorPorFiis" DOUBLE PRECISION NOT NULL,
    "valorPorRendaFixa" DOUBLE PRECISION NOT NULL,
    "ganhoAcumulado" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_carteira_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transacoes_simulacao_userId_anoMes_idx" ON "transacoes_simulacao"("userId", "anoMes");

-- CreateIndex
CREATE UNIQUE INDEX "simulacao_config_userId_key" ON "simulacao_config"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "historico_carteira_userId_carteira_anoMes_key" ON "historico_carteira"("userId", "carteira", "anoMes");

-- CreateIndex
CREATE INDEX "investimentos_userId_carteira_idx" ON "investimentos"("userId", "carteira");

-- AddForeignKey
ALTER TABLE "transacoes_simulacao" ADD CONSTRAINT "transacoes_simulacao_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulacao_config" ADD CONSTRAINT "simulacao_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historico_carteira" ADD CONSTRAINT "historico_carteira_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
