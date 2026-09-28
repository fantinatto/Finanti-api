-- AlterTable
ALTER TABLE "portfolio_config" ADD COLUMN     "dynamicGuardrailEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dynamicMaxAdjustment" DOUBLE PRECISION NOT NULL DEFAULT 2,
ADD COLUMN     "rebalanceToleranceMode" TEXT NOT NULL DEFAULT 'FIXED';
