-- AlterTable
ALTER TABLE "indicadores_mensais" ADD COLUMN     "precoFechamento" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "investimentos" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "ticker" TEXT,
    "nome" TEXT NOT NULL,
    "precoMedio" DOUBLE PRECISION NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investimentos_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "investimentos" ADD CONSTRAINT "investimentos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("uuid_usuario") ON DELETE CASCADE ON UPDATE CASCADE;
