-- AlterTable
ALTER TABLE "transacoes_simulacao" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transacoes_simulacao_idempotencyKey_key" ON "transacoes_simulacao"("idempotencyKey");
