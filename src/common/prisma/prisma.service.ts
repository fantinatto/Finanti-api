import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Singleton pattern para evitar múltiplas instâncias (recomendado pelo Prisma para Vercel)
const globalForPrisma = (global as unknown as { prisma?: PrismaClient }) || {};

export const prismaClient =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaClient;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private prisma: PrismaClient = prismaClient;

  async onModuleInit() {
    await this.prisma.$connect();
    this.logger.log('Conectado ao banco de dados');
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

  // Models
  get user() {
    return this.prisma.user;
  }

  get passwordResetToken() {
    return this.prisma.passwordResetToken;
  }
}
