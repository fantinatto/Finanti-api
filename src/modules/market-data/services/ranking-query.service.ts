import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** Formato de linha do ranking híbrido — idêntico ao que getRanking() retorna, pra reusar o
 * componente de tabela existente no front sem precisar de uma interface/coluna nova. */
export interface LinhaHibrida {
  ticker: string;
  nome: string;
  setor: string | null;
  segmento: string | null;
  scoreQualidade: number | null;
  qualidadeDelta: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  precoDelta: number | null;
  scoreFinal: number | null;
  scoreFinalDelta: number | null;
}

/**
 * Abaixo disso, "o campeão do segmento" é só quem não tem concorrência direta e tende a bater
 * no teto de normalização por falta de comparáveis (razão contra a média de si mesmo = 1,0 em
 * todo indicador) — não por mérito. Checado em 2026-09: 42 dos 58 segmentos reais da B3 têm
 * menos de 3 ações com score, e todo segmento com N=1 produz o mesmo score fixo
 * (scoreQualidade=1, scoreRisco=3, scorePreco=1, scoreFinal=1,8) pra qualquer empresa que caia
 * nele. Usado tanto pelo Híbrido (redireciona peso pro setor) quanto pelo fallback do modo
 * "segmento" puro (getScoresSegmentoComFallback) — mesmo limiar, mesma garantia nos dois lugares.
 */
export const QTD_MINIMA_SEGMENTO = 3;

export interface ScoreComOrigem {
  scoreQualidade: number | null;
  qualidadeDelta: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  precoDelta: number | null;
  scoreFinal: number | null;
  scoreFinalDelta: number | null;
  /** 'setor_fallback' quando o segmento da ação tem menos de QTD_MINIMA_SEGMENTO comparáveis —
   * os campos de score acima já vêm do tier 'setor' nesse caso, não do 'segmento' bruto. */
  origemScore: 'segmento' | 'setor_fallback';
}

@Injectable()
export class RankingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getMeses(): Promise<string[]> {
    const rows = await this.prisma.scoreNormalizado.findMany({
      select: { anoMes: true },
      distinct: ['anoMes'],
      orderBy: { anoMes: 'desc' },
    });
    return rows.map((r) => r.anoMes);
  }

  async getGrupos(tipoGrupo: string, anoMes: string): Promise<string[]> {
    const rows = await this.prisma.mediaAgrupamento.findMany({
      where: { tipoGrupo, anoMes },
      select: { nomeGrupo: true },
      orderBy: { nomeGrupo: 'asc' },
    });
    return rows.map((r) => r.nomeGrupo);
  }

  async getIndicadores(anoMes: string) {
    return this.prisma.indicadorMensal.findMany({
      where: { anoMes },
      include: { acao: { select: { nome: true, setor: true, segmento: true } } },
      orderBy: { ticker: 'asc' },
    });
  }

  async getResumoColeta(anoMes: string) {
    const total = await this.prisma.indicadorMensal.count({ where: { anoMes } });
    const comRoe = await this.prisma.indicadorMensal.count({ where: { anoMes, roe: { not: null } } });
    const comPl = await this.prisma.indicadorMensal.count({ where: { anoMes, pl: { not: null } } });
    const comDy = await this.prisma.indicadorMensal.count({ where: { anoMes, dy: { not: null } } });
    return { total, comRoe, comPl, comDy };
  }

  /**
   * nomeGrupo omitido/vazio = "todos os grupos" — cada ação pertence a só um nomeGrupo
   * por tipoGrupo (seu próprio setor ou segmento), então tirar o filtro não duplica
   * linha nenhuma, só junta o ranking inteiro numa lista só.
   *
   * tipoGrupo='segmento' passa pelo fallback de amostra pequena (ver getScoresSegmentoComFallback)
   * — ações em segmento com menos de QTD_MINIMA_SEGMENTO comparáveis mostram o score do SETOR
   * em vez do valor fixo sem sentido (`origemScore: 'setor_fallback'` sinaliza isso pro front).
   */
  async getRanking(tipoGrupo: string, nomeGrupo: string | undefined, anoMes: string) {
    if (tipoGrupo === 'segmento') {
      const scoresPorTicker = await this.getScoresSegmentoComFallback(anoMes);
      const acoes = await this.prisma.acao.findMany({
        where: nomeGrupo ? { segmento: nomeGrupo } : { segmento: { not: null } },
        select: { ticker: true, nome: true, setor: true, segmento: true },
      });

      return acoes
        .map((a) => {
          const s = scoresPorTicker.get(a.ticker);
          if (!s || s.scoreFinal == null) return null;
          return { ticker: a.ticker, nome: a.nome, setor: a.setor, segmento: a.segmento, ...s };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => (b.scoreFinal ?? 0) - (a.scoreFinal ?? 0));
    }

    // scoreFinal: not null — Postgres ordena NULL antes de qualquer valor em DESC,
    // então sem esse filtro ações sem score calculado apareciam em 1º lugar.
    const where: { tipoGrupo: string; nomeGrupo?: string; anoMes: string; scoreFinal: { not: null } } = {
      tipoGrupo,
      anoMes,
      scoreFinal: { not: null },
    };
    if (nomeGrupo) where.nomeGrupo = nomeGrupo;

    const scores = await this.prisma.scoreNormalizado.findMany({
      where,
      include: { acao: { select: { nome: true, setor: true, segmento: true } } },
      orderBy: { scoreFinal: 'desc' },
    });

    return scores.map((s) => ({
      ticker: s.ticker,
      nome: s.acao.nome,
      setor: s.acao.setor,
      segmento: s.acao.segmento,
      scoreQualidade: s.scoreQualidade,
      qualidadeDelta: s.qualidadeDelta,
      scoreRisco: s.scoreRisco,
      riscoDelta: s.riscoDelta,
      riscoComposto: s.riscoComposto,
      scorePreco: s.scorePreco,
      precoDelta: s.precoDelta,
      scoreFinal: s.scoreFinal,
      scoreFinalDelta: s.scoreFinalDelta,
      origemScore: null as 'segmento' | 'setor_fallback' | null,
    }));
  }

  /**
   * Score de cada ticker no tier 'segmento', com fallback pro tier 'setor' quando o segmento
   * tem menos de QTD_MINIMA_SEGMENTO comparáveis (ver o comentário na constante). Base tanto do
   * modo "segmento" puro em getRanking() quanto de tipoRankingRecomendacao='segmento' em
   * InvestimentoService — mesmo critério de confiabilidade usado no Híbrido, só que aqui
   * substituindo o score inteiro em vez de só redistribuir peso (não tem "setor" E "segmento"
   * pra misturar fora do Híbrido, só um dos dois pode vencer).
   */
  async getScoresSegmentoComFallback(anoMes: string): Promise<Map<string, ScoreComOrigem>> {
    const [segmentoRows, setorRows] = await Promise.all([
      this.prisma.scoreNormalizado.findMany({ where: { tipoGrupo: 'segmento', anoMes } }),
      this.prisma.scoreNormalizado.findMany({ where: { tipoGrupo: 'setor', anoMes } }),
    ]);

    const setorPorTicker = new Map(setorRows.map((r) => [r.ticker, r]));
    const qtdPorSegmento = new Map<string, number>();
    for (const r of segmentoRows) {
      if (r.scoreFinal == null) continue; // não conta pra amostra quem nem teve score calculado
      qtdPorSegmento.set(r.nomeGrupo, (qtdPorSegmento.get(r.nomeGrupo) ?? 0) + 1);
    }

    const resultado = new Map<string, ScoreComOrigem>();
    for (const segRow of segmentoRows) {
      const confiavel = (qtdPorSegmento.get(segRow.nomeGrupo) ?? 0) >= QTD_MINIMA_SEGMENTO;
      // Sem score de setor disponível pro ticker (raro), mantém o segmento como último recurso
      // em vez de descartar a ação inteira do ranking.
      const fonte = confiavel ? segRow : (setorPorTicker.get(segRow.ticker) ?? segRow);

      resultado.set(segRow.ticker, {
        scoreQualidade: fonte.scoreQualidade,
        qualidadeDelta: fonte.qualidadeDelta,
        scoreRisco: fonte.scoreRisco,
        riscoDelta: fonte.riscoDelta,
        riscoComposto: fonte.riscoComposto,
        scorePreco: fonte.scorePreco,
        precoDelta: fonte.precoDelta,
        scoreFinal: fonte.scoreFinal,
        scoreFinalDelta: fonte.scoreFinalDelta,
        origemScore: confiavel ? 'segmento' : 'setor_fallback',
      });
    }
    return resultado;
  }

  /**
   * Score Ponderado (híbrido): combina os 3 níveis de agrupamento já persistidos (setor,
   * segmento, geral) numa nota só por ação — Setor 60% + Segmento 30% + Geral 10%. Motivação:
   * olhar só pro "geral" mistura empresas de setores com dinâmica de múltiplos completamente
   * diferente (P/L de Tecnologia não é comparável ao de Utilidade Pública); olhar só pro
   * "setor"/"segmento" isolado perde o contexto de como a ação se compara com a bolsa inteira.
   *
   * Trava de segurança: 33 dos 44 segmentos reais da B3 (checado em 2026-09) têm menos de 3
   * ações com score — nesses casos o "campeão do segmento" é só quem não tem concorrência
   * direta, e tende a bater no teto de normalização por falta de comparáveis, não por mérito.
   * Segmento com menos de QTD_MINIMA_SEGMENTO ações válidas redireciona 100% do peso do
   * segmento pro setor (fica 90% Setor / 10% Geral em vez de 60/30/10).
   *
   * Aplica o mesmo blend em TODOS os campos de score (não só scoreFinal) — Qualidade, Risco,
   * Preço e as variantes Δ — pra reaproveitar o componente de ranking existente sem precisar de
   * uma interface/coluna nova: o resultado tem exatamente o mesmo formato de getRanking().
   * Um campo fica null no resultado se QUALQUER uma das partes ponderadas usadas for null —
   * mesmo critério conservador do resto do motor de score (dado insuficiente = null, não um
   * valor inventado).
   */
  async getRankingHibrido(anoMes: string) {
    const PESO_SETOR = 0.6;
    const PESO_SEGMENTO = 0.3;
    const PESO_GERAL = 0.1;

    const [setorRows, segmentoRows, geralRows] = await Promise.all([
      this.prisma.scoreNormalizado.findMany({
        where: { tipoGrupo: 'setor', anoMes, scoreFinal: { not: null } },
        include: { acao: { select: { nome: true, setor: true, segmento: true } } },
      }),
      this.prisma.scoreNormalizado.findMany({ where: { tipoGrupo: 'segmento', anoMes, scoreFinal: { not: null } } }),
      this.prisma.scoreNormalizado.findMany({ where: { tipoGrupo: 'geral', anoMes, scoreFinal: { not: null } } }),
    ]);

    const segmentoPorTicker = new Map(segmentoRows.map((r) => [r.ticker, r]));
    const geralPorTicker = new Map(geralRows.map((r) => [r.ticker, r]));

    // Quantas ações têm score válido em cada segmento — decide se o segmento é "confiável"
    // o bastante pra pesar 30%, ou se deve redirecionar o peso pro setor.
    const qtdPorSegmento = new Map<string, number>();
    for (const r of segmentoRows) qtdPorSegmento.set(r.nomeGrupo, (qtdPorSegmento.get(r.nomeGrupo) ?? 0) + 1);

    // null se qualquer uma das partes ponderadas usadas for null — dado insuficiente não vira
    // valor inventado, mesmo critério conservador do resto do motor de score.
    const blend = (vSetor: number | null, vSegmento: number | null, vGeral: number | null, pesoSetor: number, pesoSegmento: number): number | null => {
      if (vSetor == null || vGeral == null || (pesoSegmento > 0 && vSegmento == null)) return null;
      return vSetor * pesoSetor + (vSegmento ?? 0) * pesoSegmento + vGeral * PESO_GERAL;
    };

    const resultado: LinhaHibrida[] = [];
    for (const setorRow of setorRows) {
      const geralRow = geralPorTicker.get(setorRow.ticker);
      if (!geralRow) continue; // sem score geral pra comparar, não dá pra compor o híbrido

      const segmentoRow = segmentoPorTicker.get(setorRow.ticker);
      const qtdSegmento = segmentoRow ? (qtdPorSegmento.get(segmentoRow.nomeGrupo) ?? 0) : 0;
      const segmentoConfiavel = !!segmentoRow && qtdSegmento >= QTD_MINIMA_SEGMENTO;

      const pesoSetor = segmentoConfiavel ? PESO_SETOR : PESO_SETOR + PESO_SEGMENTO;
      const pesoSegmento = segmentoConfiavel ? PESO_SEGMENTO : 0;
      const seg = segmentoConfiavel ? segmentoRow : null;

      resultado.push({
        ticker: setorRow.ticker,
        nome: setorRow.acao.nome,
        setor: setorRow.acao.setor,
        segmento: setorRow.acao.segmento,
        scoreQualidade: blend(setorRow.scoreQualidade, seg?.scoreQualidade ?? null, geralRow.scoreQualidade, pesoSetor, pesoSegmento),
        qualidadeDelta: blend(setorRow.qualidadeDelta, seg?.qualidadeDelta ?? null, geralRow.qualidadeDelta, pesoSetor, pesoSegmento),
        scoreRisco: blend(setorRow.scoreRisco, seg?.scoreRisco ?? null, geralRow.scoreRisco, pesoSetor, pesoSegmento),
        riscoDelta: blend(setorRow.riscoDelta, seg?.riscoDelta ?? null, geralRow.riscoDelta, pesoSetor, pesoSegmento),
        riscoComposto: blend(setorRow.riscoComposto, seg?.riscoComposto ?? null, geralRow.riscoComposto, pesoSetor, pesoSegmento),
        scorePreco: blend(setorRow.scorePreco, seg?.scorePreco ?? null, geralRow.scorePreco, pesoSetor, pesoSegmento),
        precoDelta: blend(setorRow.precoDelta, seg?.precoDelta ?? null, geralRow.precoDelta, pesoSetor, pesoSegmento),
        scoreFinal: blend(setorRow.scoreFinal, seg?.scoreFinal ?? null, geralRow.scoreFinal, pesoSetor, pesoSegmento),
        scoreFinalDelta: blend(setorRow.scoreFinalDelta, seg?.scoreFinalDelta ?? null, geralRow.scoreFinalDelta, pesoSetor, pesoSegmento),
      });
    }

    return resultado.filter((r) => r.scoreFinal !== null).sort((a, b) => (b.scoreFinal ?? 0) - (a.scoreFinal ?? 0));
  }

  /** Mediana de cada indicador por grupo (setor/segmento) — tabela medias_agrupamento. */
  async getMedianas(tipoGrupo: string, anoMes: string) {
    return this.prisma.mediaAgrupamento.findMany({
      where: { tipoGrupo, anoMes },
      orderBy: { nomeGrupo: 'asc' },
    });
  }

  /** Série histórica (todos os meses) da mediana de um único grupo — base do gráfico de /medianas. */
  async getMedianasHistorico(tipoGrupo: string, nomeGrupo: string) {
    return this.prisma.mediaAgrupamento.findMany({
      where: { tipoGrupo, nomeGrupo },
      orderBy: { anoMes: 'asc' },
    });
  }

  /** Mapa segmento → setor, derivado da classificação B3 da ação (1 setor : N segmentos). */
  async getMapaSetorSegmento(): Promise<Record<string, string>> {
    const rows = await this.prisma.acao.findMany({
      where: { setor: { not: null }, segmento: { not: null } },
      select: { setor: true, segmento: true },
      distinct: ['segmento'],
      orderBy: { segmento: 'asc' },
    });

    const mapa: Record<string, string> = {};
    for (const r of rows) {
      if (r.setor && r.segmento) mapa[r.segmento] = r.setor;
    }
    return mapa;
  }

  /**
   * Search-help pro campo de ticker do formulário de "Comprar" (Investimentos/Simulação) —
   * autocomplete por ticker OU nome, devolvendo o nome já cadastrado e o último preço de
   * fechamento conhecido (não é cotação em tempo real, é o mesmo dado usado em calcularGanhos).
   * Só cobre `tipo==='acao'` — FIIs/renda fixa não têm ingestão de fundamentos (ver Acao).
   */
  async buscarTickers(
    query: string,
  ): Promise<{ ticker: string; nome: string; precoFechamento: number | null; anoMes: string | null }[]> {
    const termo = query.trim();
    if (termo.length < 1) return [];

    const acoes = await this.prisma.acao.findMany({
      where: {
        OR: [
          { ticker: { contains: termo, mode: 'insensitive' } },
          { nome: { contains: termo, mode: 'insensitive' } },
        ],
      },
      select: { ticker: true, nome: true },
      take: 15,
    });
    if (acoes.length === 0) return [];

    // Ticker que COMEÇA com o termo aparece primeiro (ex: "PETR" → PETR3/PETR4 antes de um nome
    // que só contém "petr" no meio) — mais útil num autocomplete do que ordem alfabética simples.
    const termoUpper = termo.toUpperCase();
    acoes.sort((a, b) => {
      const prioridadeA = a.ticker.startsWith(termoUpper) ? 0 : 1;
      const prioridadeB = b.ticker.startsWith(termoUpper) ? 0 : 1;
      return prioridadeA !== prioridadeB ? prioridadeA - prioridadeB : a.ticker.localeCompare(b.ticker);
    });

    const tickers = acoes.map((a) => a.ticker);
    const indicadores = await this.prisma.indicadorMensal.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, anoMes: true, precoFechamento: true },
      orderBy: { anoMes: 'desc' },
    });
    const maisRecentePorTicker = new Map<string, { anoMes: string; precoFechamento: number | null }>();
    for (const ind of indicadores) {
      if (!maisRecentePorTicker.has(ind.ticker)) {
        maisRecentePorTicker.set(ind.ticker, { anoMes: ind.anoMes, precoFechamento: ind.precoFechamento });
      }
    }

    return acoes.map((a) => ({
      ticker: a.ticker,
      nome: a.nome,
      precoFechamento: maisRecentePorTicker.get(a.ticker)?.precoFechamento ?? null,
      anoMes: maisRecentePorTicker.get(a.ticker)?.anoMes ?? null,
    }));
  }

  /**
   * Evolução mensal da média do top 3 por grupo (setor/segmento) — histórico pro gráfico
   * de linha da tela de Resumo. Mesma métrica que getTop3PorGrupo usa pro mês corrente,
   * só que pra todos os anoMes disponíveis de uma vez (uma query, agrupamento em memória —
   * volume baixo o bastante pra não precisar de agregação no banco).
   */
  async getHistoricoTop3PorGrupo(
    tipoGrupo: string,
  ): Promise<{ anoMes: string; nomeGrupo: string; mediaTop3: number }[]> {
    const scores = await this.prisma.scoreNormalizado.findMany({
      where: { tipoGrupo, scoreFinal: { not: null } },
      select: { anoMes: true, nomeGrupo: true, scoreFinal: true },
      orderBy: [{ anoMes: 'asc' }, { nomeGrupo: 'asc' }, { scoreFinal: 'desc' }],
    });

    const porMes = new Map<string, Map<string, number[]>>();
    for (const s of scores) {
      if (!porMes.has(s.anoMes)) porMes.set(s.anoMes, new Map());
      const porGrupo = porMes.get(s.anoMes)!;
      if (!porGrupo.has(s.nomeGrupo)) porGrupo.set(s.nomeGrupo, []);
      const top3 = porGrupo.get(s.nomeGrupo)!;
      if (top3.length < 3) top3.push(s.scoreFinal as number);
    }

    const resultado: { anoMes: string; nomeGrupo: string; mediaTop3: number }[] = [];
    for (const [anoMes, porGrupo] of porMes) {
      for (const [nomeGrupo, valores] of porGrupo) {
        resultado.push({ anoMes, nomeGrupo, mediaTop3: valores.reduce((acc, v) => acc + v, 0) / valores.length });
      }
    }
    return resultado;
  }

  /** Top 3 ações por scoreFinal dentro de cada grupo (setor/segmento) — tela de resumo. */
  async getTop3PorGrupo(tipoGrupo: string, anoMes: string) {
    // scoreFinal: not null — mesmo motivo do getRanking (NULL não é "1º lugar").
    const scores = await this.prisma.scoreNormalizado.findMany({
      where: { tipoGrupo, anoMes, scoreFinal: { not: null } },
      include: { acao: { select: { nome: true } } },
      orderBy: [{ nomeGrupo: 'asc' }, { scoreFinal: 'desc' }],
    });

    const porGrupo: Record<
      string,
      { ticker: string; nome: string; scoreFinal: number | null; scoreQualidade: number | null; scoreRisco: number | null; scorePreco: number | null }[]
    > = {};

    for (const s of scores) {
      if (!porGrupo[s.nomeGrupo]) porGrupo[s.nomeGrupo] = [];
      if (porGrupo[s.nomeGrupo].length >= 3) continue;
      porGrupo[s.nomeGrupo].push({
        ticker: s.ticker,
        nome: s.acao.nome,
        scoreFinal: s.scoreFinal,
        scoreQualidade: s.scoreQualidade,
        scoreRisco: s.scoreRisco,
        scorePreco: s.scorePreco,
      });
    }

    return porGrupo;
  }
}
