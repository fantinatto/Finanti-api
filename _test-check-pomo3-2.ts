import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/common/prisma/prisma.service';

const REAL_USER_ID = '26644cc4-e5b4-43bb-a928-6bc16f0f08c9';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const linhas = await prisma.investimento.findMany({
      where: { userId: REAL_USER_ID, carteira: 'real', ticker: 'POMO3' },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`Linhas encontradas: ${linhas.length}`);
    for (const l of linhas) {
      console.log({ id: l.id, nome: l.nome, precoMedio: l.precoMedio, quantidade: l.quantidade, createdAt: l.createdAt, updatedAt: l.updatedAt });
    }
  } finally {
    await app.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
