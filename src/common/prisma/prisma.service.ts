import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Singleton pattern para evitar múltiplas instâncias (recomendado pelo Prisma para Vercel)
const globalForPrisma = (global as unknown as { prisma?: PrismaClient }) || {};

export const prismaClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
    // connection_limit=1 no DATABASE_URL (dev) evita pool ocioso que o Supabase derruba
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaClient;
}

const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 2000;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private prisma: PrismaClient = prismaClient;

  async onModuleInit() {
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        await this.prisma.$connect();
        this.logger.log('Conectado ao banco de dados');
        return;
      } catch (err) {
        if (attempt === CONNECT_RETRIES) throw err;
        this.logger.warn(`Falha na conexão (tentativa ${attempt}/${CONNECT_RETRIES}), retentando em ${CONNECT_RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
      }
    }
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
    this.logger.log('Desconectado do banco de dados');
  }

  // Delegar todas as operações ao cliente Prisma singleton
  get $queryRaw() {
    return this.prisma.$queryRaw.bind(this.prisma);
  }

  get $executeRaw() {
    return this.prisma.$executeRaw.bind(this.prisma);
  }

  get $transaction() {
    return this.prisma.$transaction.bind(this.prisma);
  }

  // Models - Auth
  get user() {
    return this.prisma.user;
  }

  get passwordResetToken() {
    return this.prisma.passwordResetToken;
  }

  // Models - Market Data
  get acao() {
    return this.prisma.acao;
  }

  get tickerSetor() {
    return this.prisma.tickerSetor;
  }

  get indicadorMensal() {
    return this.prisma.indicadorMensal;
  }

  get mediaAgrupamento() {
    return this.prisma.mediaAgrupamento;
  }

  get scoreNormalizado() {
    return this.prisma.scoreNormalizado;
  }

  // Models - Portfolio
  get portfolioConfig() {
    return this.prisma.portfolioConfig;
  }

  get alocacaoSetor() {
    return this.prisma.alocacaoSetor;
  }

  get alocacaoSegmentoFii() {
    return this.prisma.alocacaoSegmentoFii;
  }

  get investimento() {
    return this.prisma.investimento;
  }
}
