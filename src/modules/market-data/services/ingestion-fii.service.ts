import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StatusInvestService } from './statusinvest.service';
import { StatusInvestFiiItem } from '../dto/statusinvest.types';

/**
 * Coleta de FII — pipeline isolado de IngestionService/ações (ver comentário do modelo Fii
 * no schema.prisma). Sem bolsai (não cobre FII), sem scoring/médias (ainda não existe
 * metodologia de ranking pra FII — decisão em aberto, ver análise de complexidade) — só coleta
 * e persiste o indicador bruto do mês, igual ao primeiro passo que IngestionService já fazia
 * pra ação antes de normalizar/pontuar.
 */
@Injectable()
export class IngestionFiiService {
  private readonly logger = new Logger(IngestionFiiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statusInvest: StatusInvestService,
  ) {}

  async executar(): Promise<{ processadas: number; erros: number }> {
    const anoMes = this.getAnoMes();
    this.logger.log(`Iniciando ingestão de FIIs para ${anoMes}`);

    const universo = await this.statusInvest.buscarTodasFiis();
    this.logger.log(`${universo.length} FIIs encontrados (status invest)`);

    // Mesmo filtro mínimo de "negociável" já usado pra ação — price<=0 = sem cotação ativa.
    const ativos = universo.filter((item) => item.price != null && item.price > 0);
    this.logger.log(`${ativos.length} FIIs com cotação ativa após filtro`);

    // Full refresh do mês antes de persistir — mesma razão documentada em
    // IngestionService.limparMesVigente (evita indicador velho sobrevivendo se um FII sair
    // do universo numa coleta seguinte do mesmo mês). Não apaga Fii (catálogo, compartilhado
    // entre meses).
    await this.prisma.indicadorMensalFii.deleteMany({ where: { anoMes } });

    let processadas = 0;
    let erros = 0;

    for (const item of ativos) {
      try {
        await this.upsertFii(item, anoMes);
        processadas++;
      } catch (err) {
        this.logger.error(`Erro ao persistir FII ${item.ticker}: ${(err as Error).message}`);
        erros++;
      }
    }

    this.logger.log(`Ingestão de FIIs concluída: ${processadas} processadas, ${erros} erros`);
    return { processadas, erros };
  }

  private async upsertFii(item: StatusInvestFiiItem, anoMes: string): Promise<void> {
    await this.prisma.fii.upsert({
      where: { ticker: item.ticker },
      update: {
        nome: item.companyname ?? item.ticker,
        tipoFundo: item.sectorname || null,
        segmento: item.segment || null,
        gestao: item.gestao_f && item.gestao_f !== '-' ? item.gestao_f : null,
      },
      create: {
        ticker: item.ticker,
        nome: item.companyname ?? item.ticker,
        tipoFundo: item.sectorname || null,
        segmento: item.segment || null,
        gestao: item.gestao_f && item.gestao_f !== '-' ? item.gestao_f : null,
      },
    });

    const dados = {
      precoFechamento: item.price ?? null,
      dy: item.dy ?? null,
      pvp: item.p_vp ?? null,
      valorPatrimonialCota: item.valorpatrimonialcota ?? null,
      liquidezMediaDiaria: item.liquidezmediadiaria ?? null,
      percentualCaixa: item.percentualcaixa ?? null,
      dividendCagr: item.dividend_cagr ?? null,
      cotaCagr: item.cota_cagr ?? null,
      numeroCotistas: item.numerocotistas != null ? Math.round(item.numerocotistas) : null,
      numeroCotas: item.numerocotas != null ? Math.round(item.numerocotas) : null,
      patrimonio: item.patrimonio ?? null,
      lastDividend: item.lastdividend ?? null,
    };

    await this.prisma.indicadorMensalFii.upsert({
      where: { ticker_anoMes: { ticker: item.ticker, anoMes } },
      update: dados,
      create: { ticker: item.ticker, anoMes, ...dados },
    });
  }

  async getMeses(): Promise<string[]> {
    const rows = await this.prisma.indicadorMensalFii.findMany({
      select: { anoMes: true },
      distinct: ['anoMes'],
      orderBy: { anoMes: 'desc' },
    });
    return rows.map((r) => r.anoMes);
  }

  async getIndicadores(anoMes: string) {
    return this.prisma.indicadorMensalFii.findMany({
      where: { anoMes },
      include: { fii: { select: { nome: true, tipoFundo: true, segmento: true } } },
      orderBy: { ticker: 'asc' },
    });
  }

  /**
   * Catálogo real de segmentos (Fii.segmento) — pra tela de Carteira parar de usar a lista
   * provisória hardcoded (SEGMENTOS_FII_PROVISORIOS no front), que tinha nomes diferentes dos
   * reais (ex: "Logística" vs o real "Imóveis Industriais e Logísticos") e fazia o balanceamento
   * mostrar o alvo como 100% subalocado mesmo com posição real no segmento. Vive em Fii (catálogo
   * mestre, não por anoMes) — não precisa de parâmetro de competência.
   */
  async getSegmentos(): Promise<string[]> {
    const rows = await this.prisma.fii.findMany({
      where: { segmento: { not: null } },
      select: { segmento: true },
      distinct: ['segmento'],
      orderBy: { segmento: 'asc' },
    });
    return rows.map((r) => r.segmento as string);
  }

  async getResumo(anoMes: string) {
    const total = await this.prisma.indicadorMensalFii.count({ where: { anoMes } });
    const comDy = await this.prisma.indicadorMensalFii.count({ where: { anoMes, dy: { not: null } } });
    const comPvp = await this.prisma.indicadorMensalFii.count({ where: { anoMes, pvp: { not: null } } });
    return { total, comDy, comPvp };
  }

  private getAnoMes(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
