import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertPortfolioConfigDto } from '../dto/upsert-portfolio-config.dto';

@Injectable()
export class PortfolioConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(userId: string) {
    return this.prisma.portfolioConfig.findUnique({
      where: { userId },
      include: { alocacoesSetor: true, alocacoesSegmentoFii: true },
    });
  }

  async upsertConfig(userId: string, dto: UpsertPortfolioConfigDto) {
    return this.prisma.$transaction(async (tx) => {
      const config = await tx.portfolioConfig.upsert({
        where: { userId },
        create: {
          userId,
          percentualRendaFixa: dto.percentualRendaFixa,
          percentualFiis: dto.percentualFiis,
          percentualAcoes: dto.percentualAcoes,
          percentualEstouro: dto.percentualEstouro,
          regraSelecionada: dto.regraSelecionada,
          baseRegraCustom: dto.baseRegraCustom,
          tipoRankingRecomendacao: dto.tipoRankingRecomendacao ?? 'setor',
        },
        update: {
          percentualRendaFixa: dto.percentualRendaFixa,
          percentualFiis: dto.percentualFiis,
          percentualAcoes: dto.percentualAcoes,
          percentualEstouro: dto.percentualEstouro,
          regraSelecionada: dto.regraSelecionada ?? null,
          baseRegraCustom: dto.baseRegraCustom ?? null,
          tipoRankingRecomendacao: dto.tipoRankingRecomendacao ?? 'setor',
        },
      });

      // replace-all das alocações — mais simples que diff, e o volume é pequeno (poucas dezenas de linhas)
      await tx.alocacaoSetor.deleteMany({ where: { portfolioConfigId: config.id } });
      await tx.alocacaoSegmentoFii.deleteMany({ where: { portfolioConfigId: config.id } });

      if (dto.alocacoesSetor.length) {
        await tx.alocacaoSetor.createMany({
          data: dto.alocacoesSetor.map((a) => ({
            portfolioConfigId: config.id,
            setor: a.nome,
            percentual: a.percentual,
          })),
        });
      }

      if (dto.alocacoesSegmentoFii.length) {
        await tx.alocacaoSegmentoFii.createMany({
          data: dto.alocacoesSegmentoFii.map((a) => ({
            portfolioConfigId: config.id,
            segmento: a.nome,
            percentual: a.percentual,
          })),
        });
      }

      return tx.portfolioConfig.findUniqueOrThrow({
        where: { id: config.id },
        include: { alocacoesSetor: true, alocacoesSegmentoFii: true },
      });
    });
  }
}
