-- CreateTable
CREATE TABLE "ticker_setor" (
    "ticker" TEXT NOT NULL,
    "setor" TEXT NOT NULL,
    "subsetor" TEXT,
    "segmento" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticker_setor_pkey" PRIMARY KEY ("ticker")
);
