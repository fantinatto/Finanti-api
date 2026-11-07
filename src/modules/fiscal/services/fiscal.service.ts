import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OperacaoFiscal } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertOperacaoFiscalDto } from '../dto/upsert-operacao-fiscal.dto';
import {
  ALIQUOTAS,
  CODIGO_DARF,
  IRRF_ALIQUOTA_DAY_TRADE_SOBRE_GANHO,
  IRRF_ALIQUOTA_SWING_SOBRE_VENDA,
  IRRF_SWING_DISPENSA_ATE,
  LIMITE_ISENCAO_COMUM_MENSAL,
  VALOR_MINIMO_DARF,
} from '../fiscal.config';

export type BucketFiscal = 'comum' | 'day_trade' | 'fii_fiagro';

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
  /** Ganho que entra no DARF: resultado após compensação, positivo e não isento. */
  baseTributavel: number;
  aliquota: number;
  impostoDevido: number;
}

/** Um DARF 6015 por mês, somando os 3 buckets (é assim que a Receita recolhe na PF). */
export interface DarfMensal {
  anoMes: string;
  codigoReceita: string;
  impostoDevido: number;
  /** IRRF retido nas vendas do mês (informado na operação ou estimado). */
  irrfDoMes: number;
  /** true se parte do IRRF do mês foi estimada (operação sem valor informado da nota). */
  irrfEstimado: boolean;
  /** IRRF do mês + saldo não usado nos meses anteriores do mesmo ano. */
  irrfDisponivel: number;
  irrfCompensado: number;
  /** Saldo de IRRF que sobra pro mês seguinte (zera na virada do ano — vai pra declaração). */
  irrfSaldoFinal: number;
  /** DARF < R$ 10 de meses anteriores que ainda não foi pago. */
  valorAcumuladoAnterior: number;
  /** Imposto após IRRF + acumulado anterior. */
  valorDarf: number;
  /** false quando valorDarf > 0 mas < R$ 10: não paga agora, acumula pro mês seguinte. */
  pagar: boolean;
  /** Último dia útil do mês seguinte (YYYY-MM-DD). Só faz sentido quando pagar = true. */
  vencimento: string;
}

export interface ApuracaoAnual {
  ano: number;
  meses: ApuracaoMensalBucket[];
  darfs: DarfMensal[];
  /** Soma dos DARFs a pagar no ano. */
  totalDarfAno: number;
  /** IRRF não compensado até dezembro — informar na declaração anual (ficha Renda Variável). */
  irrfSaldoNaoCompensadoAno: number;
  /** DARF < R$ 10 ainda acumulado ao fim de dezembro (segue pros meses do ano seguinte). */
  darfAcumuladoFimAno: number;
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
        irrfRetido: dto.tipo === 'venda' ? (dto.irrfRetido ?? null) : null,
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
        irrfRetido: dto.tipo === 'venda' ? (dto.irrfRetido ?? null) : null,
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
   * Reprocessa TODO o histórico do usuário (não só o ano pedido) porque prejuízo acumulado, custo
   * médio por ticker e DARF < R$ 10 acumulado carregam de um ano pro outro — sem persistir saldo
   * separado, que ficaria dessincronizado assim que o usuário editasse/inserisse uma operação
   * retroativa. Parâmetros legais (alíquotas, código, limites) em fiscal.config.ts.
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
    const porMes = new Map<string, MesAcumulado>();
    const avisos: string[] = [];

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

        const mes = porMes.get(anoMes) ?? mesVazio();
        mes.buckets[bucket].resultadoBruto += ganho;
        mes.buckets[bucket].totalVendas += valorBruto;
        if (op.irrfRetido != null) {
          mes.irrfInformado += op.irrfRetido;
        } else if (bucket === 'day_trade') {
          mes.irrfEstimadoDayTrade += Math.max(0, ganho) * IRRF_ALIQUOTA_DAY_TRADE_SOBRE_GANHO;
        } else {
          mes.irrfEstimadoSwing += valorBruto * IRRF_ALIQUOTA_SWING_SOBRE_VENDA;
        }
        porMes.set(anoMes, mes);
      }

      custoPorTicker.set(op.ticker, custoTicker);
    }

    // Percorre mês a mês, do primeiro mês com operação (ou jan do ano pedido) até dez do ano pedido:
    // prejuízo por bucket e DARF < R$ 10 atravessam anos; saldo de IRRF zera em janeiro (o que
    // sobra em dezembro vai pra declaração anual).
    const primeiroAnoMes = [...porMes.keys()].sort()[0];
    const inicio = primeiroAnoMes && primeiroAnoMes < `${ano}-01` ? primeiroAnoMes : `${ano}-01`;
    const prejuizoPorBucket: Record<BucketFiscal, number> = { comum: 0, day_trade: 0, fii_fiagro: 0 };
    let darfAcumulado = 0;
    let irrfSaldo = 0;

    const meses: ApuracaoMensalBucket[] = [];
    const darfs: DarfMensal[] = [];

    for (const anoMes of mesesEntre(inicio, `${ano}-12`)) {
      if (anoMes.endsWith('-01')) irrfSaldo = 0;
      const doAnoPedido = anoMes.startsWith(`${ano}-`);
      const entrada = porMes.get(anoMes) ?? mesVazio();

      let impostoDevido = 0;
      for (const bucket of BUCKETS) {
        const { resultadoBruto, totalVendas } = entrada.buckets[bucket];
        const isento = bucket === 'comum' && totalVendas <= LIMITE_ISENCAO_COMUM_MENSAL;
        const comp = aplicarCompensacao(resultadoBruto, prejuizoPorBucket[bucket], isento);
        prejuizoPorBucket[bucket] = comp.prejuizoAcumulado;
        const baseTributavel = isento ? 0 : Math.max(0, comp.resultadoAposCompensacao);
        const aliquota = ALIQUOTAS[bucket];
        const impostoBucket = arred(baseTributavel * aliquota);
        impostoDevido += impostoBucket;

        if (doAnoPedido) {
          meses.push({
            anoMes,
            bucket,
            totalVendas,
            resultadoBruto,
            prejuizoCompensado: comp.prejuizoCompensado,
            resultadoAposCompensacao: comp.resultadoAposCompensacao,
            prejuizoAcumuladoFinal: comp.prejuizoAcumulado,
            isento,
            baseTributavel,
            aliquota,
            impostoDevido: impostoBucket,
          });
        }
      }

      const irrfSwing = entrada.irrfEstimadoSwing <= IRRF_SWING_DISPENSA_ATE ? 0 : entrada.irrfEstimadoSwing;
      const irrfDoMes = arred(entrada.irrfInformado + irrfSwing + entrada.irrfEstimadoDayTrade);
      const irrfDisponivel = arred(irrfSaldo + irrfDoMes);
      const irrfCompensado = arred(Math.min(irrfDisponivel, impostoDevido));
      irrfSaldo = arred(irrfDisponivel - irrfCompensado);

      const valorAcumuladoAnterior = darfAcumulado;
      const valorDarf = arred(impostoDevido - irrfCompensado + darfAcumulado);
      const pagar = valorDarf >= VALOR_MINIMO_DARF;
      darfAcumulado = pagar ? 0 : valorDarf;

      if (doAnoPedido) {
        darfs.push({
          anoMes,
          codigoReceita: CODIGO_DARF,
          impostoDevido: arred(impostoDevido),
          irrfDoMes,
          irrfEstimado: irrfSwing + entrada.irrfEstimadoDayTrade > 0,
          irrfDisponivel,
          irrfCompensado,
          irrfSaldoFinal: irrfSaldo,
          valorAcumuladoAnterior,
          valorDarf,
          pagar,
          vencimento: vencimentoDarf(anoMes),
        });
      }
    }

    return {
      ano,
      meses,
      darfs,
      totalDarfAno: arred(darfs.filter((d) => d.pagar).reduce((s, d) => s + d.valorDarf, 0)),
      irrfSaldoNaoCompensadoAno: irrfSaldo,
      darfAcumuladoFimAno: darfAcumulado,
      avisos,
    };
  }
}

interface MesAcumulado {
  buckets: Record<BucketFiscal, { resultadoBruto: number; totalVendas: number }>;
  irrfInformado: number;
  irrfEstimadoSwing: number;
  irrfEstimadoDayTrade: number;
}

function mesVazio(): MesAcumulado {
  return {
    buckets: {
      comum: { resultadoBruto: 0, totalVendas: 0 },
      day_trade: { resultadoBruto: 0, totalVendas: 0 },
      fii_fiagro: { resultadoBruto: 0, totalVendas: 0 },
    },
    irrfInformado: 0,
    irrfEstimadoSwing: 0,
    irrfEstimadoDayTrade: 0,
  };
}

function arred(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/** Lista "YYYY-MM" de inicio até fim, inclusive. */
function mesesEntre(inicio: string, fim: string): string[] {
  const lista: string[] = [];
  let [a, m] = inicio.split('-').map(Number);
  const [aFim, mFim] = fim.split('-').map(Number);
  while (a < aFim || (a === aFim && m <= mFim)) {
    lista.push(`${a}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      a++;
    }
  }
  return lista;
}

/**
 * Ganho isento (vendas de ações comuns ≤ R$ 20 mil) NÃO consome prejuízo acumulado: o prejuízo
 * fica guardado pra abater ganho tributável depois. Prejuízo em mês isento continua acumulando.
 */
export function aplicarCompensacao(
  resultadoBruto: number,
  prejuizoAcumuladoEntrando: number,
  isento = false,
): { prejuizoCompensado: number; resultadoAposCompensacao: number; prejuizoAcumulado: number } {
  if (resultadoBruto >= 0) {
    const prejuizoCompensado = isento ? 0 : Math.min(prejuizoAcumuladoEntrando, resultadoBruto);
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

/** Vencimento do DARF: último dia útil do mês seguinte ao da apuração. */
export function vencimentoDarf(anoMes: string): string {
  const [a, m] = anoMes.split('-').map(Number);
  // m é 1-based: Date.UTC(a, m + 1, 0) = último dia do mês seguinte.
  const dia = new Date(Date.UTC(a, m + 1, 0));
  while (!ehDiaUtil(dia)) dia.setUTCDate(dia.getUTCDate() - 1);
  return dia.toISOString().slice(0, 10);
}

const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25', '12-31'];

/** Fim de semana, feriados nacionais fixos, Sexta-feira Santa e 31/12 (sem expediente bancário). */
function ehDiaUtil(d: Date): boolean {
  const semana = d.getUTCDay();
  if (semana === 0 || semana === 6) return false;
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  if (FERIADOS_FIXOS.includes(mmdd)) return false;
  const sextaSanta = pascoa(d.getUTCFullYear());
  sextaSanta.setUTCDate(sextaSanta.getUTCDate() - 2);
  return d.getTime() !== sextaSanta.getTime();
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em UTC. */
function pascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}
