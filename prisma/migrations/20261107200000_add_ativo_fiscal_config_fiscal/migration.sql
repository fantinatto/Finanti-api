-- CreateTable
CREATE TABLE "ativos_fiscais" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "cnpj" TEXT,
    "razaoSocial" TEXT,
    "administrador" TEXT,
    "cnpjAdministrador" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ativos_fiscais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_fiscal" (
    "userId" TEXT NOT NULL,
    "corretoraNome" TEXT,
    "corretoraCnpj" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_fiscal_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ativos_fiscais_userId_ticker_key" ON "ativos_fiscais"("userId", "ticker");

-- AddForeignKey
ALTER TABLE "ativos_fiscais" ADD CONSTRAINT "ativos_fiscais_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_fiscal" ADD CONSTRAINT "config_fiscal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

