import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BolsaiService } from './bolsai.service';
import { StatusInvestService } from './statusinvest.service';
import { BolsaiFundamentals } from '../dto/bolsai.types';
import { StatusInvestItem } from '../dto/statusinvest.types';
import { INDICATOR_CONFIG } from '../scoring/indicator.config';
import { calcularMedias, calcularMediaEDesvio, IndicadoresMap } from '../scoring/average.calculator';
import { calcularScores, normalizarAcao } from '../scoring/normalizer';
import { IngestionFiltroDto } from '../dto/ingestion-filtro.dto';
import { FILTROS_AVANCADOS_CONFIG } from '../filtro-avancado.config';

type TipoGrupo = 'setor' | 'segmento' | 'geral';

/**
 * nomeGrupo único usado pro agrupamento "geral" — não é um setor/segmento real, é um bucket
 * só contendo o universo inteiro (todas as ações que passaram nos filtros), pra computar médias
 * e scores sem segregar por classificação nenhuma. Ver agruparPor.
 */
const NOME_GRUPO_GERAL = 'Mercado';

interface AcaoEnriquecida {
  ticker: string;
  nome: string;
  setor: string | null;
  segmento: string | null;
  precoFechamento: number | null;
  /** R$/dia — usado só pro fator de penalização de liquidez em calcularScores, ver scoring/liquidez.ts. */
  liquidezMediaDiaria: number | null;
  indicadores: IndicadoresMap;
}

/**
 * Tentativa de detectar ticker "fantasma" (empresa incorporada/deslistada cuja fonte continua
 * servindo o último balanço, ex: SMLS3/Smiles) via liquidez muito baixa + fundamentos idênticos
 * ao mês anterior — TESTADA e REVERTIDA em 2026-09-23: o campo liquidezmediadiaria vem ausente
 * até pra blue chips líquidas (VIVT4 confirmado com liquidezmediadiaria: undefined na fonte ao
 * vivo), e a comparação "mês anterior" ficou contaminada porque os meses persistidos nesse
 * ambiente foram gravados com poucos dias reais de diferença (ingests de teste da mesma sessão),
 * não um mês de pregão real — então blue chips genuinamente ativas (VIVT4) também apareciam
 * "congeladas" e seriam excluídas por engano. Não reintroduzir sem validar contra meses
 * realmente espaçados por um ciclo de pregão completo (ingestão mensal real em produção).
 */

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bolsai: BolsaiService,
    private readonly statusInvest: StatusInvestService,
  ) {}

  async executar(filtro: IngestionFiltroDto = {}): Promise<{ processadas: number; erros: number }> {
    const anoMes = this.getAnoMes();
    this.logger.log(`Iniciando ingestão para ${anoMes}`);

    // Status Invest é a fonte primária: um request só devolve ticker, setor/segmento
    // e quase todos os fundamentos pro universo inteiro de ações (sem rate limit por ticker).
    const universo = await this.statusInvest.buscarTodas();
    this.logger.log(`${universo.length} tickers encontrados (status invest)`);

    // Cache persistente ticker→setor (upsert-only), desacoplado de completude de fundamentos —
    // serve de base pra quando alguma fonte futura não trouxer setor pro ticker.
    await this.upsertTickerSetor(universo);

    const listaFiltrada = this.filtrarLista(universo, filtro);
    this.logger.log(`${listaFiltrada.length} tickers após filtros`);

    // 1ª passada: mapeia só com Status Invest.
    const acoesBase = listaFiltrada.map((item) => this.mapearAcao(item, undefined));

    // bolsai tem cota escassa (free tier) — só vale a pena chamar pros tickers que
    // ficaram com campo obrigatório faltando depois da Status Invest, não pra todo mundo.
    const itemPorTicker = new Map(listaFiltrada.map((item) => [item.ticker, item]));
    const ticketsIncompletos = acoesBase.filter((a) => !this.isValida(a.indicadores)).map((a) => a.ticker);
    this.logger.log(`${ticketsIncompletos.length} de ${acoesBase.length} tickers incompletos após status invest`);

    const bolsaiMap = await this.bolsai.buscarFundamentais(ticketsIncompletos);
    this.logger.log(`${bolsaiMap.size} tickers completados via bolsai`);

    const incompletosSet = new Set(ticketsIncompletos);
    const acoes = acoesBase.map((a) => {
      if (!incompletosSet.has(a.ticker)) return a;
      const item = itemPorTicker.get(a.ticker);
      return item ? this.mapearAcao(item, bolsaiMap.get(a.ticker)) : a;
    });

    const aindaIncompletas = acoes.filter((a) => !this.isValida(a.indicadores)).length;
    this.logger.log(`${aindaIncompletas} tickers permanecem incompletos mesmo após bolsai — salvos com flag dadosIncompletos`);

    // Full refresh, não merge incremental — ver comentário de limparMesVigente. Só depois que
    // já temos a lista final de ações prontas pra persistir, pra não apagar dados bons se a
    // coleta falhar antes disso (ex: bloqueio do Cloudflare na Status Invest).
    await this.limparMesVigente(anoMes);

    // 1. Persistir dados brutos (todos — incompletos entram com a flag, não são descartados)
    let processadas = 0;
    let erros = 0;

    for (const acao of acoes) {
      try {
        await this.upsertAcao(acao, anoMes);
        processadas++;
      } catch (err) {
        this.logger.error(`Erro ao persistir ${acao.ticker}: ${(err as Error).message}`);
        erros++;
      }
    }

    // 2. Calcular e persistir médias por setor, segmento e mercado inteiro (sem segregação)
    await this.processarMediasEScores(acoes, anoMes, 'setor');
    await this.processarMediasEScores(acoes, anoMes, 'segmento');
    await this.processarMediasEScores(acoes, anoMes, 'geral');

    this.logger.log(`Ingestão concluída: ${processadas} processadas, ${erros} erros`);
    return { processadas, erros };
  }

  /**
   * A ingestão sempre usou upsert (nunca delete) em IndicadorMensal/MediaAgrupamento/
   * ScoreNormalizado — um ticker que passava numa coleta anterior do mês e é excluído por um
   * filtro mais rígido (ex: filtrosAvancados) numa coleta seguinte DO MESMO anoMes ficava com
   * dado velho pra sempre, porque a coleta nova nunca chegava a tocar esse ticker de novo pra
   * sobrescrever (confirmado: PPLA11 continuava aparecendo mesmo depois de configurar um filtro
   * que deveria tê-lo excluído — a coleta anterior daquele mês nunca tinha rodado com esse
   * filtro). Por isso: refresh completo do mês antes de persistir os dados novos, não merge.
   *
   * Não apaga Acao (cadastro master, compartilhado entre meses) nem TickerSetor (cache
   * upsert-only, deliberadamente nunca apagado — ver comentário em upsertTickerSetor).
   */
  private async limparMesVigente(anoMes: string): Promise<void> {
    const [scores, medias, indicadores] = await Promise.all([
      this.prisma.scoreNormalizado.deleteMany({ where: { anoMes } }),
      this.prisma.mediaAgrupamento.deleteMany({ where: { anoMes } }),
      this.prisma.indicadorMensal.deleteMany({ where: { anoMes } }),
    ]);
    this.logger.log(
      `Mês ${anoMes} limpo antes da nova coleta: ${indicadores.count} indicadores, ${medias.count} médias, ${scores.count} scores removidos`,
    );
  }

  private async upsertAcao(acao: AcaoEnriquecida, anoMes: string): Promise<void> {
    await this.prisma.acao.upsert({
      where: { ticker: acao.ticker },
      update: { nome: acao.nome, setor: acao.setor, segmento: acao.segmento },
      create: { ticker: acao.ticker, nome: acao.nome, setor: acao.setor, segmento: acao.segmento },
    });

    const dados = this.indicadoresParaPrisma(acao.indicadores);
    const dadosIncompletos = !this.isValida(acao.indicadores);
    const pvp = acao.indicadores.pvp as number | null | undefined;
    const passivoADescoberto = pvp != null && pvp < 0;
    const extras = {
      dadosIncompletos,
      passivoADescoberto,
      precoFechamento: acao.precoFechamento,
      liquidezMediaDiaria: acao.liquidezMediaDiaria,
    };
    await this.prisma.indicadorMensal.upsert({
      where: { ticker_anoMes: { ticker: acao.ticker, anoMes } },
      update: { ...dados, ...extras },
      create: { ticker: acao.ticker, anoMes, ...dados, ...extras },
    });
  }

  /** Upsert-only — nunca deleta, mesmo que o ticker suma de uma execução futura. */
  private async upsertTickerSetor(universo: StatusInvestItem[]): Promise<void> {
    let gravados = 0;
    for (const item of universo) {
      if (!item.sectorname) continue;
      try {
        await this.prisma.tickerSetor.upsert({
          where: { ticker: item.ticker },
          update: {
            setor: item.sectorname,
            subsetor: item.subsectorname ?? null,
            segmento: item.segmentname ?? null,
          },
          create: {
            ticker: item.ticker,
            setor: item.sectorname,
            subsetor: item.subsectorname ?? null,
            segmento: item.segmentname ?? null,
          },
        });
        gravados++;
      } catch (err) {
        this.logger.warn(`Falha ao gravar ticker_setor de ${item.ticker}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`${gravados} tickers gravados/atualizados em ticker_setor`);
  }

  private async processarMediasEScores(
    acoes: AcaoEnriquecida[],
    anoMes: string,
    tipoGrupo: TipoGrupo,
  ): Promise<void> {
    const grupos = this.agruparPor(acoes, tipoGrupo);

    for (const [nomeGrupo, acoesDoGrupo] of Object.entries(grupos)) {
      if (!nomeGrupo) continue;

      const indicadoresList = acoesDoGrupo.map((a) => a.indicadores);
      const medias = calcularMedias(indicadoresList, INDICATOR_CONFIG);
      // Média + desvio-padrão do grupo, pra calcularScoreDeltaGrupo (qualidadeDelta/riscoDelta/
      // precoDelta) — mesmo agrupamento (setor ou segmento) e mesmos campos de medias, só
      // método estatístico diferente (Z-score em vez de razão contra mediana).
      const estatisticasGrupo = calcularMediaEDesvio(indicadoresList, INDICATOR_CONFIG.map((c) => c.field));

      // Persiste médias do grupo
      await this.prisma.mediaAgrupamento.upsert({
        where: { tipoGrupo_nomeGrupo_anoMes: { tipoGrupo, nomeGrupo, anoMes } },
        update: this.mediasParaPrisma(medias),
        create: { tipoGrupo, nomeGrupo, anoMes, ...this.mediasParaPrisma(medias) },
      });

      // Normaliza e calcula scores por ação dentro do grupo
      for (const acao of acoesDoGrupo) {
        const norms = normalizarAcao(acao.indicadores, medias);
        const scores = calcularScores(norms, acao.indicadores, acao.setor, acao.segmento, estatisticasGrupo, acao.liquidezMediaDiaria);
        const normsParaPrisma = this.normsParaPrisma(norms);

        await this.prisma.scoreNormalizado.upsert({
          where: { ticker_tipoGrupo_nomeGrupo_anoMes: { ticker: acao.ticker, tipoGrupo, nomeGrupo, anoMes } },
          update: { ...normsParaPrisma, ...scores },
          create: { ticker: acao.ticker, tipoGrupo, nomeGrupo, anoMes, ...normsParaPrisma, ...scores },
        });
      }
    }
  }

  private mapearAcao(item: StatusInvestItem, bolsai: BolsaiFundamentals | undefined): AcaoEnriquecida {
    // Bancos (segmento, não o setor "Financeiro e Outros" inteiro — seguradoras/corretoras
    // têm estrutura de dívida mais normal): ROIC e Dívida Líq./EBITDA não fazem sentido pro
    // negócio de captar/emprestar, então saem null e o peso deles é redistribuído
    // automaticamente pra ROE/margens (Qualidade) e dividaLiquidaPatrimonio (Risco) —
    // calcGrupo já ignora campos null e reponderam entre os que sobram.
    const ehBanco = item.segmentname === 'Bancos';

    // Status Invest é a fonte primária (já traz quase tudo num request só, escala percentual
    // já compatível com o que gravamos); bolsai preenche só o que faltar por ticker
    // (ex: dividaLiquidaEbitda — a Status Invest só tem DL/EBIT, métrica diferente).
    const indicadores: IndicadoresMap = {
      pl: item.p_l ?? bolsai?.pl ?? null,
      pvp: item.p_vp ?? bolsai?.pvp ?? null,
      pEbit: item.p_ebit ?? bolsai?.p_ebit ?? null,
      roe: item.roe ?? bolsai?.roe ?? null,
      roic: ehBanco ? null : (item.roic ?? bolsai?.roic ?? null),
      roa: item.roa ?? bolsai?.roa ?? null,
      margemBruta: item.margembruta ?? bolsai?.gross_margin ?? null,
      margemEbit: item.margemebit ?? bolsai?.ebit_margin ?? null,
      margemLiquida: item.margemliquida ?? bolsai?.net_margin ?? null,
      dy: item.dy ?? null,
      dividaLiquidaPatrimonio: item.dividaliquidapatrimonioliquido ?? bolsai?.net_debt_equity ?? null,
      dividaLiquidaEbitda: ehBanco ? null : (bolsai?.net_debt_ebitda ?? null),
      cagrReceita5a: item.receitas_cagr5 ?? bolsai?.cagr_revenue_5y ?? null,
      cagrLucro5a: item.lucros_cagr5 ?? bolsai?.cagr_earnings_5y ?? null,
      lpa: item.lpa ?? bolsai?.lpa ?? null,
      vpa: item.vpa ?? bolsai?.vpa ?? null,
    };

    return {
      ticker: item.ticker,
      nome: item.companyname ?? item.ticker,
      setor: item.sectorname || null,
      segmento: item.segmentname || null,
      precoFechamento: item.price ?? null,
      liquidezMediaDiaria: item.liquidezmediadiaria ?? null,
      indicadores,
    };
  }

  private agruparPor(
    acoes: AcaoEnriquecida[],
    tipo: TipoGrupo,
  ): Record<string, AcaoEnriquecida[]> {
    // "geral" não segrega por classificação nenhuma — bucket único com todo mundo, inclusive
    // ações sem setor/segmento cadastrado (que os outros dois tipos descartam abaixo).
    if (tipo === 'geral') return { [NOME_GRUPO_GERAL]: acoes };

    const grupos: Record<string, AcaoEnriquecida[]> = {};
    for (const acao of acoes) {
      const chave = tipo === 'setor' ? (acao.setor ?? '') : (acao.segmento ?? '');
      if (!chave) continue;
      if (!grupos[chave]) grupos[chave] = [];
      grupos[chave].push(acao);
    }
    return grupos;
  }

  /**
   * Campos que não entram em INDICATOR_CONFIG (logo, nunca são usados por calcularMedias/
   * normalizarAcao) — só nesses é seguro gravar 0 no lugar de null. Nos 12 campos usados no
   * cálculo do score, 0 seria tratado como valor real e distorceria a mediana do grupo.
   */
  private indicadoresParaPrisma(ind: IndicadoresMap): Record<string, number | null> {
    return {
      ...this.mediasParaPrisma(ind),
      roa: (ind.roa as number | null | undefined) ?? 0,
      margemEbit: (ind.margemEbit as number | null | undefined) ?? 0,
      lpa: (ind.lpa as number | null | undefined) ?? 0,
      vpa: (ind.vpa as number | null | undefined) ?? 0,
    };
  }

  /** Campos mínimos exigidos pra persistir a ação — sem eles o registro é descartado. */
  private isValida(ind: IndicadoresMap): boolean {
    const obrigatorios = ['pl', 'pvp', 'lpa', 'vpa', 'roe', 'roa', 'pEbit'] as const;
    return obrigatorios.every((campo) => ind[campo] != null);
  }

  /** Subconjunto de indicadoresParaPrisma sem lpa/vpa — mediaAgrupamento não possui essas colunas. */
  private mediasParaPrisma(ind: IndicadoresMap): Record<string, number | null> {
    return {
      pl: (ind.pl as number | null | undefined) ?? null,
      pvp: (ind.pvp as number | null | undefined) ?? null,
      pEbit: (ind.pEbit as number | null | undefined) ?? null,
      roe: (ind.roe as number | null | undefined) ?? null,
      roic: (ind.roic as number | null | undefined) ?? null,
      roa: (ind.roa as number | null | undefined) ?? null,
      margemBruta: (ind.margemBruta as number | null | undefined) ?? null,
      margemEbit: (ind.margemEbit as number | null | undefined) ?? null,
      margemLiquida: (ind.margemLiquida as number | null | undefined) ?? null,
      dy: (ind.dy as number | null | undefined) ?? null,
      dividaLiquidaPatrimonio: (ind.dividaLiquidaPatrimonio as number | null | undefined) ?? null,
      dividaLiquidaEbitda: (ind.dividaLiquidaEbitda as number | null | undefined) ?? null,
      cagrReceita5a: (ind.cagrReceita5a as number | null | undefined) ?? null,
      cagrLucro5a: (ind.cagrLucro5a as number | null | undefined) ?? null,
    };
  }

  private normsParaPrisma(norms: IndicadoresMap): Record<string, number | null> {
    return {
      pl_norm: (norms['pl_norm'] as number | null | undefined) ?? null,
      pvp_norm: (norms['pvp_norm'] as number | null | undefined) ?? null,
      pEbit_norm: (norms['pEbit_norm'] as number | null | undefined) ?? null,
      roe_norm: (norms['roe_norm'] as number | null | undefined) ?? null,
      roic_norm: (norms['roic_norm'] as number | null | undefined) ?? null,
      roa_norm: (norms['roa_norm'] as number | null | undefined) ?? null,
      margemBruta_norm: (norms['margemBruta_norm'] as number | null | undefined) ?? null,
      margemEbit_norm: (norms['margemEbit_norm'] as number | null | undefined) ?? null,
      margemLiquida_norm: (norms['margemLiquida_norm'] as number | null | undefined) ?? null,
      dy_norm: (norms['dy_norm'] as number | null | undefined) ?? null,
      dividaLiquidaPatrimonio_norm: (norms['dividaLiquidaPatrimonio_norm'] as number | null | undefined) ?? null,
      dividaLiquidaEbitda_norm: (norms['dividaLiquidaEbitda_norm'] as number | null | undefined) ?? null,
      cagrReceita5a_norm: (norms['cagrReceita5a_norm'] as number | null | undefined) ?? null,
      cagrLucro5a_norm: (norms['cagrLucro5a_norm'] as number | null | undefined) ?? null,
    };
  }

  private filtrarLista(lista: StatusInvestItem[], filtro: IngestionFiltroDto): StatusInvestItem[] {
    return lista.filter((item) => {
      const ticker = item.ticker;

      // price = 0 (ou ausente) = sem cotação ativa — ativo não está mais disponível pra
      // investimento. A API não tem um campo "status"/"delisted" explícito, mas quando o
      // preço zera todos os múltiplos derivados dele (p_l, p_vp, p_ebit) também zeram,
      // enquanto ROE/ROIC/margens continuam vindo de demonstrativos antigos "congelados" —
      // sem esse filtro esses tickers rankeavam bem mesmo estando inegociáveis. Sempre
      // aplicado, não é opcional via filtro.
      if (!item.price || item.price <= 0) return false;

      if (filtro.soAcoes && !/^[A-Z]{4}[3456]$/.test(ticker)) return false;
      if (filtro.excluirFiis && ticker.endsWith('11')) return false;
      if (filtro.excluirBdrs && /3[2345]$/.test(ticker)) return false;
      if (filtro.setor && item.sectorname !== filtro.setor) return false;
      if (filtro.marketCapMin != null && (item.valormercado ?? 0) < filtro.marketCapMin) return false;

      if (filtro.filtrosAvancados) {
        for (const { campo } of FILTROS_AVANCADOS_CONFIG) {
          const range = filtro.filtrosAvancados[campo];
          if (!range) continue;

          const valor = item[campo] as number | null;
          if (valor == null) return false; // sem dado pro campo filtrado = não passa
          if (range.min != null && valor < range.min) return false;
          if (range.max != null && valor > range.max) return false;
        }
      }

      return true;
    });
  }

  private getAnoMes(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
