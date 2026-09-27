import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OperacaoFiscal } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertOperacaoFiscalDto } from '../dto/upsert-operacao-fiscal.dto';

export type BucketFiscal = 'comum' | 'day_trade' | 'fii_fiagro';

/** Ações em operações comuns (não day trade) até este total de vendas no mês ficam isentas de IR
 * sobre o ganho — regra vale só pro bucket "comum", nunca pra day trade ou FII/Fiagro. */
const LIMITE_ISENCAO_COMUM_MENSAL = 20_000;

/** Margem de tolerância pra comparação de ponto flutuante nas quantidades. */
const MARGEM_QUANTIDADE = 0.0001;

export interface ApuracaoMensalBucket {
  anoMes: string;
  bucket: BucketFiscal;
  totalVendas: number;
  resultadoBruto: number;
  prejuizoCompensado: number;
  resultadoAposCompensacao: number;
  prejuizoAcumuladoFinal: number;
  isento: boolean;
}

export interface ApuracaoAnual {
  ano: number;
  meses: ApuracaoMensalBucket[];
  /** Tickers onde uma venda excedeu a quantidade acumulada no livro até aquela data — sinal de
   * operação de compra faltando no histórico ou lançada fora de ordem. Não impede o cálculo (a
   * apuração segue com a quantidade zerada nesse ponto), só avisa que o número pode estar errado. */
  avisos: string[];
}

interface CustoTicker {
  quantidade: number;
  custoMedio: number;
}

const BUCKETS: BucketFiscal[] = ['comum', 'day_trade', 'fii_fiagro'];

function bucketDaOperacao(op: Pick<OperacaoFiscal, 'assetType' | 'tradeType'>): BucketFiscal {
  if (op.tradeType === 'day_trade') return 'day_trade';
  return op.assetType === 'fii' ? 'fii_fiagro' : 'comum';
}

function formatAnoMes(data: Date): string {
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class FiscalService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(userId: string, ano?: number): Promise<OperacaoFiscal[]> {
    return this.prisma.operacaoFiscal.findMany({
      where: ano
        ? { userId, data: { gte: new Date(Date.UTC(ano, 0, 1)), lt: new Date(Date.UTC(ano + 1, 0, 1)) } }
        : { userId },
      orderBy: [{ data: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async criar(userId: string, dto: UpsertOperacaoFiscalDto): Promise<OperacaoFiscal> {
    return this.prisma.operacaoFiscal.create({
      data: {
        userId,
        data: new Date(dto.data),
        ticker: dto.ticker.toUpperCase(),
        assetType: dto.assetType,
        tipo: dto.tipo,
        tradeType: dto.tradeType ?? 'swing',
        quantidade: dto.quantidade,
        precoUnitario: dto.precoUnitario,
        custos: dto.custos ?? 0,
      },
    });
  }

  async atualizar(userId: string, id: string, dto: UpsertOperacaoFiscalDto): Promise<OperacaoFiscal> {
    await this.garantirDono(userId, id);
    return this.prisma.operacaoFiscal.update({
      where: { id },
      data: {
        data: new Date(dto.data),
        ticker: dto.ticker.toUpperCase(),
        assetType: dto.assetType,
        tipo: dto.tipo,
        tradeType: dto.tradeType ?? 'swing',
        quantidade: dto.quantidade,
        precoUnitario: dto.precoUnitario,
        custos: dto.custos ?? 0,
      },
    });
  }

  async remover(userId: string, id: string): Promise<void> {
    await this.garantirDono(userId, id);
    await this.prisma.operacaoFiscal.delete({ where: { id } });
  }

  private async garantirDono(userId: string, id: string): Promise<OperacaoFiscal> {
    const operacao = await this.prisma.operacaoFiscal.findUnique({ where: { id } });
    if (!operacao || operacao.userId !== userId) {
      throw new NotFoundException('Operação fiscal não encontrada.');
    }
    return operacao;
  }

  /**
   * Reprocessa TODO o histórico do usuário (não só o ano pedido) porque prejuízo acumulado e
   * custo médio por ticker carregam de um ano pro outro — sem persistir um saldo separado, que
   * ficaria dessincronizado assim que o usuário editasse/inserisse uma operação retroativa.
   * Sem DARF nem declaração anual ainda: só ganho/prejuízo bruto e compensado por bucket/mês.
   */
  async getApuracaoAnual(userId: string, ano: number): Promise<ApuracaoAnual> {
    if (!Number.isInteger(ano) || ano < 2000) {
      throw new BadRequestException('Ano inválido.');
    }

    const operacoes = await this.prisma.operacaoFiscal.findMany({
      where: { userId },
      orderBy: [{ data: 'asc' }, { createdAt: 'asc' }],
    });

    const custoPorTicker = new Map<string, CustoTicker>();
    // resultadoPorMesBucket[anoMes][bucket] = { resultadoBruto, totalVendas }
    const resultadoPorMesBucket = new Map<string, Record<BucketFiscal, { resultadoBruto: number; totalVendas: number }>>();
    const avisos: string[] = [];

    const zeroBuckets = (): Record<BucketFiscal, { resultadoBruto: number; totalVendas: number }> => ({
      comum: { resultadoBruto: 0, totalVendas: 0 },
      day_trade: { resultadoBruto: 0, totalVendas: 0 },
      fii_fiagro: { resultadoBruto: 0, totalVendas: 0 },
    });

    for (const op of operacoes) {
      const anoMes = formatAnoMes(op.data);
      const bucket = bucketDaOperacao(op);
      const custoTicker = custoPorTicker.get(op.ticker) ?? { quantidade: 0, custoMedio: 0 };

      if (op.tipo === 'compra') {
        const custoTotalAntes = custoTicker.quantidade * custoTicker.custoMedio;
        const novaQuantidade = custoTicker.quantidade + op.quantidade;
        custoTicker.custoMedio = novaQuantidade > 0 ? (custoTotalAntes + op.quantidade * op.precoUnitario + op.custos) / novaQuantidade : 0;
        custoTicker.quantidade = novaQuantidade;
      } else {
        if (op.quantidade > custoTicker.quantidade + MARGEM_QUANTIDADE) {
          avisos.push(
            `${op.ticker}: venda de ${op.quantidade} em ${op.data.toISOString().slice(0, 10)} excede a quantidade acumulada no livro fiscal até essa data (${custoTicker.quantidade}) — confira se falta lançar alguma compra.`,
          );
        }
        const valorBruto = op.quantidade * op.precoUnitario;
        const ganho = valorBruto - op.custos - op.quantidade * custoTicker.custoMedio;
        custoTicker.quantidade = Math.max(0, custoTicker.quantidade - op.quantidade);

        const mesBuckets = resultadoPorMesBucket.get(anoMes) ?? zeroBuckets();
        mesBuckets[bucket].resultadoBruto += ganho;
        mesBuckets[bucket].totalVendas += valorBruto;
        resultadoPorMesBucket.set(anoMes, mesBuckets);
      }

      custoPorTicker.set(op.ticker, custoTicker);
    }

    const meses: ApuracaoMensalBucket[] = [];

    for (const bucket of BUCKETS) {
      // Meses anteriores ao ano pedido só servem pra carregar o prejuízo acumulado de entrada —
      // não entram no retorno.
      let prejuizoAcumulado = 0;
      const anoMesInicioAno = `${ano}-01`;
      const mesesAnteriores = [...resultadoPorMesBucket.keys()].filter((am) => am < anoMesInicioAno).sort();
      for (const anoMes of mesesAnteriores) {
        const entrada = resultadoPorMesBucket.get(anoMes)![bucket];
        prejuizoAcumulado = aplicarCompensacao(entrada.resultadoBruto, prejuizoAcumulado).prejuizoAcumulado;
      }

      for (let mes = 1; mes <= 12; mes++) {
        const anoMes = `${ano}-${String(mes).padStart(2, '0')}`;
        const entrada = resultadoPorMesBucket.get(anoMes)?.[bucket] ?? { resultadoBruto: 0, totalVendas: 0 };
        const { prejuizoCompensado, resultadoAposCompensacao, prejuizoAcumulado: prejuizoAcumuladoFinal } = aplicarCompensacao(
          entrada.resultadoBruto,
          prejuizoAcumulado,
        );
        prejuizoAcumulado = prejuizoAcumuladoFinal;

        meses.push({
          anoMes,
          bucket,
          totalVendas: entrada.totalVendas,
          resultadoBruto: entrada.resultadoBruto,
          prejuizoCompensado,
          resultadoAposCompensacao,
          prejuizoAcumuladoFinal,
          isento: bucket === 'comum' && entrada.totalVendas <= LIMITE_ISENCAO_COMUM_MENSAL,
        });
      }
    }

    return { ano, meses, avisos };
  }
}

function aplicarCompensacao(
  resultadoBruto: number,
  prejuizoAcumuladoEntrando: number,
): { prejuizoCompensado: number; resultadoAposCompensacao: number; prejuizoAcumulado: number } {
  if (resultadoBruto >= 0) {
    const prejuizoCompensado = Math.min(prejuizoAcumuladoEntrando, resultadoBruto);
    return {
      prejuizoCompensado,
      resultadoAposCompensacao: resultadoBruto - prejuizoCompensado,
      prejuizoAcumulado: prejuizoAcumuladoEntrando - prejuizoCompensado,
    };
  }
  return {
    prejuizoCompensado: 0,
    resultadoAposCompensacao: resultadoBruto,
    prejuizoAcumulado: prejuizoAcumuladoEntrando - resultadoBruto,
  };
}
