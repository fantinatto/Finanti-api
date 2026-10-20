-- CreateTable
CREATE TABLE "transacoes_cartao" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "descricao" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "categoria" TEXT,
    "origemArquivo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transacoes_cartao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fechamentos_mensais" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anoMes" TEXT NOT NULL,
    "fechadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fechamentos_mensais_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transacoes_cartao_userId_anoMes_idx" ON "transacoes_cartao"("userId", "anoMes");

-- CreateIndex
CREATE UNIQUE INDEX "fechamentos_mensais_userId_anoMes_key" ON "fechamentos_mensais"("userId", "anoMes");

-- AddForeignKey
ALTER TABLE "transacoes_cartao" ADD CONSTRAINT "transacoes_cartao_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fechamentos_mensais" ADD CONSTRAINT "fechamentos_mensais_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
