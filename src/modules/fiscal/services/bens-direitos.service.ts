import { BadRequestException, Injectable } from '@nestjs/common';
import { AtivoFiscal, ConfigFiscal, OperacaoFiscal } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UpsertAtivoFiscalDto, UpsertConfigFiscalDto } from '../dto/upsert-ativo-fiscal.dto';
import { BENS_DIREITOS_CODIGOS } from '../fiscal.config';

const MARGEM_QUANTIDADE = 0.0001;

export type ClasseAtivo = 'ON' | 'PN' | 'PNA' | 'PNB' | 'UNIT' | 'FII' | 'OUTRO';

export interface PosicaoAno {
  quantidade: number;
  custoMedio: number;
  /** Valor que vai na coluna "Situação em 31/12" da declaração: quantidade × custo médio. */
  custoTotal: number;
}

export interface BemDireito {
  ticker: string;
  assetType: 'acao' | 'fii';
  classe: ClasseAtivo;
  grupo: string;
  codigo: string;
  descricaoCodigo: string;
  /** 31/12 do ano anterior ao ano-base. */
  anterior: PosicaoAno;
  /** 31/12 do ano-base. */
  atual: PosicaoAno;
  /** Só gerencial (não vai na declaração): quantidade × última cotação disponível até dez do ano. */
  valorMercado: number | null;
  cotacaoReferencia: { anoMes: string; preco: number } | null;
  cnpj: string | null;
  razaoSocial: string | null;
  /** true quando a razão social veio do cadastro de mercado (Status Invest), não do usuário. */
  razaoSocialSugerida: boolean;
  administrador: string | null;
  cnpjAdministrador: string | null;
  discriminacao: string;
  pendencias: string[];
}

export interface DivergenciaCarteira {
  ticker: string;
  quantidadeLivro: number;
  quantidadeCarteira: number;
}

export interface BensDireitosAnual {
  ano: number;
  corretoraNome: string | null;
  corretoraCnpj: string | null;
  itens: BemDireito[];
  totais: { anterior: number; atual: number; valorMercado: number };
  /** Posição HOJE no livro fiscal vs carteira real em /investimentos (compra antiga não lançada). */
  divergencias: DivergenciaCarteira[];
}

interface CustoTicker {
  assetType: 'acao' | 'fii';
  quantidade: number;
  custoMedio: number;
}

@Injectable()
export class BensDireitosService {
  constructor(private readonly prisma: PrismaService) {}

  async getBensDireitos(userId: string, ano: number): Promise<BensDireitosAnual> {
    if (!Number.isInteger(ano) || ano < 2000) throw new BadRequestException('Ano inválido.');

    const [operacoes, ativos, config, carteira] = await Promise.all([
      this.prisma.operacaoFiscal.findMany({ where: { userId }, orderBy: [{ data: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.ativoFiscal.findMany({ where: { userId } }),
      this.prisma.configFiscal.findUnique({ where: { userId } }),
      this.prisma.investimento.findMany({
        where: { userId, carteira: 'real', tipo: { in: ['acao', 'fii'] } },
        select: { ticker: true, quantidade: true },
      }),
    ]);

    const anterior = posicoesAte(operacoes, new Date(Date.UTC(ano, 0, 1)));
    const atual = posicoesAte(operacoes, new Date(Date.UTC(ano + 1, 0, 1)));
    const hoje = posicoesAte(operacoes, null);

    const tickers = [...new Set([...anterior.keys(), ...atual.keys()])]
      .filter((t) => (anterior.get(t)?.quantidade ?? 0) > MARGEM_QUANTIDADE || (atual.get(t)?.quantidade ?? 0) > MARGEM_QUANTIDADE)
      .sort();

    const [nomesMercado, cotacoes] = await Promise.all([this.nomesDeMercado(tickers), this.cotacoesAte(tickers, `${ano}-12`)]);
    const ativoPorTicker = new Map(ativos.map((a) => [a.ticker, a]));

    const itens = tickers.map((ticker) =>
      montarItem(ticker, anterior.get(ticker), atual.get(ticker)!, ativoPorTicker.get(ticker), nomesMercado.get(ticker), cotacoes.get(ticker), config),
    );

    // Divergência: quantidade atual no livro ≠ quantidade na carteira real.
    const carteiraPorTicker = new Map<string, number>();
    for (const inv of carteira) {
      if (inv.ticker) carteiraPorTicker.set(inv.ticker, (carteiraPorTicker.get(inv.ticker) ?? 0) + inv.quantidade);
    }
    const divergencias: DivergenciaCarteira[] = [...new Set([...carteiraPorTicker.keys(), ...hoje.keys()])]
      .map((ticker) => ({ ticker, quantidadeLivro: hoje.get(ticker)?.quantidade ?? 0, quantidadeCarteira: carteiraPorTicker.get(ticker) ?? 0 }))
      .filter((d) => Math.abs(d.quantidadeLivro - d.quantidadeCarteira) > MARGEM_QUANTIDADE)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));

    return {
      ano,
      corretoraNome: config?.corretoraNome ?? null,
      corretoraCnpj: config?.corretoraCnpj ?? null,
      itens,
      totais: {
        anterior: arred(itens.reduce((s, i) => s + i.anterior.custoTotal, 0)),
        atual: arred(itens.reduce((s, i) => s + i.atual.custoTotal, 0)),
        valorMercado: arred(itens.reduce((s, i) => s + (i.valorMercado ?? 0), 0)),
      },
      divergencias,
    };
  }

  async upsertAtivo(userId: string, ticker: string, dto: UpsertAtivoFiscalDto): Promise<AtivoFiscal> {
    const t = ticker.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(t)) throw new BadRequestException('Ticker inválido.');
    const dados = {
      cnpj: normalizarCnpj(dto.cnpj, 'CNPJ'),
      razaoSocial: textoOuNull(dto.razaoSocial),
      administrador: textoOuNull(dto.administrador),
      cnpjAdministrador: normalizarCnpj(dto.cnpjAdministrador, 'CNPJ do administrador'),
    };
    return this.prisma.ativoFiscal.upsert({
      where: { userId_ticker: { userId, ticker: t } },
      create: { userId, ticker: t, ...dados },
      update: dados,
    });
  }

  async getConfig(userId: string): Promise<ConfigFiscal | null> {
    return this.prisma.configFiscal.findUnique({ where: { userId } });
  }

  async upsertConfig(userId: string, dto: UpsertConfigFiscalDto): Promise<ConfigFiscal> {
    const dados = { corretoraNome: textoOuNull(dto.corretoraNome), corretoraCnpj: normalizarCnpj(dto.corretoraCnpj, 'CNPJ da corretora') };
    return this.prisma.configFiscal.upsert({ where: { userId }, create: { userId, ...dados }, update: dados });
  }

  private async nomesDeMercado(tickers: string[]): Promise<Map<string, string>> {
    if (!tickers.length) return new Map();
    const [acoes, fiis] = await Promise.all([
      this.prisma.acao.findMany({ where: { ticker: { in: tickers } }, select: { ticker: true, nome: true } }),
      this.prisma.fii.findMany({ where: { ticker: { in: tickers } }, select: { ticker: true, nome: true } }),
    ]);
    return new Map([...acoes, ...fiis].map((x) => [x.ticker, x.nome]));
  }

  /** Última cotação de fechamento disponível até `anoMesLimite` (inclusive), por ticker. */
  private async cotacoesAte(tickers: string[], anoMesLimite: string): Promise<Map<string, { anoMes: string; preco: number }>> {
    if (!tickers.length) return new Map();
    const filtro = { ticker: { in: tickers }, anoMes: { lte: anoMesLimite }, precoFechamento: { not: null } };
    const sel = { ticker: true, anoMes: true, precoFechamento: true };
    const [acoes, fiis] = await Promise.all([
      this.prisma.indicadorMensal.findMany({ where: filtro, select: sel, orderBy: { anoMes: 'desc' } }),
      this.prisma.indicadorMensalFii.findMany({ where: filtro, select: sel, orderBy: { anoMes: 'desc' } }),
    ]);
    const mapa = new Map<string, { anoMes: string; preco: number }>();
    for (const c of [...acoes, ...fiis]) {
      const atual = mapa.get(c.ticker);
      if (c.precoFechamento != null && (!atual || c.anoMes > atual.anoMes)) mapa.set(c.ticker, { anoMes: c.anoMes, preco: c.precoFechamento });
    }
    return mapa;
  }
}

/** Reproduz o livro até `limite` (exclusivo; null = tudo) e devolve quantidade/custo médio por ticker. */
export function posicoesAte(
  operacoes: Pick<OperacaoFiscal, 'data' | 'ticker' | 'assetType' | 'tipo' | 'quantidade' | 'precoUnitario' | 'custos'>[],
  limite: Date | null,
): Map<string, CustoTicker> {
  const mapa = new Map<string, CustoTicker>();
  for (const op of operacoes) {
    if (limite && op.data >= limite) break;
    const c = mapa.get(op.ticker) ?? { assetType: op.assetType === 'fii' ? 'fii' : 'acao', quantidade: 0, custoMedio: 0 };
    if (op.tipo === 'compra') {
      const novaQtd = c.quantidade + op.quantidade;
      c.custoMedio = novaQtd > 0 ? (c.quantidade * c.custoMedio + op.quantidade * op.precoUnitario + op.custos) / novaQtd : 0;
      c.quantidade = novaQtd;
    } else {
      c.quantidade = Math.max(0, c.quantidade - op.quantidade);
      if (c.quantidade <= MARGEM_QUANTIDADE) {
        c.quantidade = 0;
        c.custoMedio = 0;
      }
    }
    mapa.set(op.ticker, c);
  }
  return mapa;
}

/** Classe pelo sufixo do ticker B3. FII sempre "FII"; final 11 em ação = unit. */
export function classeDoTicker(ticker: string, assetType: 'acao' | 'fii'): ClasseAtivo {
  if (assetType === 'fii') return 'FII';
  const sufixo = ticker.match(/(\d+)F?$/)?.[1];
  switch (sufixo) {
    case '3':
      return 'ON';
    case '4':
      return 'PN';
    case '5':
      return 'PNA';
    case '6':
      return 'PNB';
    case '11':
      return 'UNIT';
    default:
      return 'OUTRO';
  }
}

const DESCRICAO_CLASSE: Record<ClasseAtivo, [singular: string, plural: string]> = {
  ON: ['ação ordinária (ON)', 'ações ordinárias (ON)'],
  PN: ['ação preferencial (PN)', 'ações preferenciais (PN)'],
  PNA: ['ação preferencial classe A (PNA)', 'ações preferenciais classe A (PNA)'],
  PNB: ['ação preferencial classe B (PNB)', 'ações preferenciais classe B (PNB)'],
  UNIT: ['unit', 'units'],
  FII: ['cota', 'cotas'],
  OUTRO: ['ação', 'ações'],
};

function montarItem(
  ticker: string,
  anteriorRaw: CustoTicker | undefined,
  atualRaw: CustoTicker,
  ativo: AtivoFiscal | undefined,
  nomeMercado: string | undefined,
  cotacao: { anoMes: string; preco: number } | undefined,
  config: ConfigFiscal | null,
): BemDireito {
  const assetType = atualRaw.assetType;
  const classe = classeDoTicker(ticker, assetType);
  const cod = BENS_DIREITOS_CODIGOS[assetType];
  const anterior = posicaoAno(anteriorRaw);
  const atual = posicaoAno(atualRaw);
  const razaoSocial = ativo?.razaoSocial ?? nomeMercado ?? null;

  const pendencias: string[] = [];
  if (!ativo?.cnpj) pendencias.push(assetType === 'fii' ? 'CNPJ do fundo' : 'CNPJ da empresa');
  if (!ativo?.razaoSocial) pendencias.push(nomeMercado ? 'confirmar razão social' : 'razão social');
  if (assetType === 'fii' && !ativo?.administrador) pendencias.push('administrador');
  if (!config?.corretoraNome) pendencias.push('corretora (em Configurações fiscais)');
  if (classe === 'OUTRO') pendencias.push('classe do ativo não reconhecida pelo ticker — conferir grupo/código');

  const item: BemDireito = {
    ticker,
    assetType,
    classe,
    grupo: cod.grupo,
    codigo: cod.codigo,
    descricaoCodigo: cod.descricao,
    anterior,
    atual,
    valorMercado: cotacao && atual.quantidade > 0 ? arred(cotacao.preco * atual.quantidade) : null,
    cotacaoReferencia: cotacao ?? null,
    cnpj: ativo?.cnpj ?? null,
    razaoSocial,
    razaoSocialSugerida: !ativo?.razaoSocial && !!nomeMercado,
    administrador: ativo?.administrador ?? null,
    cnpjAdministrador: ativo?.cnpjAdministrador ?? null,
    discriminacao: '',
    pendencias,
  };
  item.discriminacao = gerarDiscriminacao(item, config);
  return item;
}

/** Texto pro campo "Discriminação" da ficha Bens e Direitos. Campos faltando viram [marcadores]. */
export function gerarDiscriminacao(
  item: Pick<BemDireito, 'ticker' | 'assetType' | 'classe' | 'atual' | 'anterior' | 'cnpj' | 'razaoSocial' | 'administrador' | 'cnpjAdministrador'>,
  config: Pick<ConfigFiscal, 'corretoraNome' | 'corretoraCnpj'> | null,
): string {
  const pos = item.atual.quantidade > 0 ? item.atual : item.anterior;
  const qtd = formatarQuantidade(pos.quantidade);
  const [singular, plural] = DESCRICAO_CLASSE[item.classe];
  const unidade = pos.quantidade === 1 ? singular : plural;
  const nome = item.razaoSocial ?? '[RAZÃO SOCIAL]';
  const cnpj = item.cnpj ? formatarCnpj(item.cnpj) : '[CNPJ]';
  const corretora = config?.corretoraNome
    ? `${config.corretoraNome}${config.corretoraCnpj ? `, CNPJ ${formatarCnpj(config.corretoraCnpj)}` : ''}`
    : '[CORRETORA]';
  const custoMedio = `R$ ${formatarMoeda(pos.custoMedio)}`;

  if (item.atual.quantidade <= 0) {
    return `${item.ticker} — posição totalmente vendida no ano. Em 31/12 do ano anterior: ${qtd} ${unidade} de ${nome}, CNPJ ${cnpj}, custodiadas na corretora ${corretora}.`;
  }

  if (item.assetType === 'fii') {
    const admin = item.administrador
      ? `${item.administrador}${item.cnpjAdministrador ? ` (CNPJ ${formatarCnpj(item.cnpjAdministrador)})` : ''}`
      : '[ADMINISTRADOR]';
    return `${qtd} ${unidade} do fundo ${nome} (${item.ticker}), CNPJ do fundo ${cnpj}, administrado por ${admin}. Custodiadas na corretora ${corretora}. Custo médio de aquisição: ${custoMedio} por cota.`;
  }

  return `${qtd} ${unidade} de ${nome} (${item.ticker}), CNPJ ${cnpj}. Custodiadas na corretora ${corretora}. Custo médio de aquisição: ${custoMedio} por ${item.classe === 'UNIT' ? 'unit' : 'ação'}.`;
}

function posicaoAno(c: CustoTicker | undefined): PosicaoAno {
  if (!c || c.quantidade <= MARGEM_QUANTIDADE) return { quantidade: 0, custoMedio: 0, custoTotal: 0 };
  return { quantidade: c.quantidade, custoMedio: c.custoMedio, custoTotal: arred(c.quantidade * c.custoMedio) };
}

function arred(v: number): number {
  return Math.round(v * 100) / 100;
}

function formatarMoeda(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatarQuantidade(v: number): string {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
}

export function formatarCnpj(digitos: string): string {
  return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function textoOuNull(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Vazio → null; senão exige 14 dígitos com dígitos verificadores válidos. Grava só dígitos. */
export function normalizarCnpj(v: string | undefined, campo: string): string | null {
  const digitos = (v ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  if (!cnpjValido(digitos)) throw new BadRequestException(`${campo} inválido.`);
  return digitos;
}

export function cnpjValido(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base: string, pesos: number[]) => {
    const soma = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = dv(d.slice(0, 12), p1);
  const d2 = dv(d.slice(0, 12) + d1, [6, ...p1]);
  return d1 === Number(d[12]) && d2 === Number(d[13]);
}
