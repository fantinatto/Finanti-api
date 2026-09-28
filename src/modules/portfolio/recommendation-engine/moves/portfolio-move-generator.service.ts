import { Injectable } from '@nestjs/common';
import { InvestimentoService } from '../../services/investimento.service';
import { arredondarParaLote, TAMANHO_FRACIONARIO, TAMANHO_LOTE } from '../../services/lote';
import { availableToInvest, InvestmentCandidateMetadata, OrigemScore, PortfolioPositionState, PortfolioState } from '../domain/portfolio-state';
import { PortfolioMove, RankingConfidence, ReduceSizingStrategy } from '../domain/portfolio-move';
import { PolicyExclusion } from '../domain/recommendation-policy';
import { RecommendationPolicyService } from '../policy/recommendation-policy.service';

/** Espelham as constantes homônimas de investimento.service.ts — matriz de decisão que a B1
 * precisa reproduzir bit-a-bit (ver plano). Duplicadas aqui de propósito: não exportar
 * constantes internas só pra evitar acoplar o motor novo ao arquivo antigo por um detalhe que
 * pode mudar de nome/valor independentemente nas duas frentes durante a transição B1→B2. */
const SCORE_BAIXO_MATRIZ = 1.0;
const DELTA_SCORE_TROCA = 0.6;

/** Ajuste 6 do plano — não só top-N Score Final, senão um candidato ótimo no eixo deficitário
 * mas #4 em Score Final nunca entraria na árvore. Default inicial, configurável por chamada. */
export interface CandidateSeedConfig {
  finalScore: number;
  quality: number;
  risk: number;
  price: number;
}
export const DEFAULT_CANDIDATE_SEEDS: CandidateSeedConfig = { finalScore: 3, quality: 1, risk: 1, price: 1 };

/**
 * Modo B1 (compatibilidade): 1 candidato por necessidade, reproduzindo a pré-seleção que a
 * matriz atual (`InvestimentoService.getRecomendacoes`) já faz — inclusive a mesma ordem de
 * decisão (rotação > venda/aporte simples) e a mesma supressão por caixa disponível.
 * `ADD_NEW_POSITION` fica DESLIGADO nesta fase (ver plano, ajuste bônus da 2ª revisão) — só liga
 * na B2.
 */
@Injectable()
export class PortfolioMoveGeneratorService {
  constructor(
    private readonly investimentos: InvestimentoService,
    private readonly recommendationPolicy: RecommendationPolicyService,
  ) {}

  /**
   * `suppressedByAvailableCash` — ids de posição onde uma venda existiria SE NÃO houvesse caixa
   * disponível suficiente pra financiar o subalocado (ver ajuste 3 do plano: sem HOLD como move,
   * mas o conversor B1→RecomendacaoHolding precisa dessa distinção pra reproduzir a categoria
   * 'aguardar_caixa' — sem isso não daria pra diferenciar de um genuíno 'manter').
   *
   * `legacyCarryForwardSuggestions` — particularidade REAL da matriz atual, isolada aqui (fora do
   * `PortfolioMove`) a pedido do usuário: quando `troca_sugerida` nasce de setor SUBALOCADO, o
   * código original nunca zera `valorSugerido`/`quantidadeSugerida` do rateio de compra (calculado
   * ANTES da troca) ao setar `sugestaoTroca` — então os dois aparecem juntos na saída. B1 precisa
   * reproduzir isso bit-a-bit, mas é uma peculiaridade de COMPATIBILIDADE com o sistema legado, não
   * uma regra do domínio — por isso vive num mapa à parte, consumido só pelo conversor B1→
   * RecomendacaoHolding (`RecommendationEngineService`), nunca pelo `PortfolioMove`/StateTransition/
   * comparador da B2 em diante.
   */
  generateB1(state: PortfolioState): {
    moves: PortfolioMove[];
    suppressedByAvailableCash: Set<string>;
    legacyCarryForwardSuggestions: Map<string, { amount: number; quantity: number | null }>;
  } {
    const moves: PortfolioMove[] = [];
    const suppressedByAvailableCash = new Set<string>();
    const legacyCarryForwardSuggestions = new Map<string, { amount: number; quantity: number | null }>();

    const posicoesPorSetor = new Map<string, PortfolioPositionState[]>();
    for (const p of state.positions) {
      if (!p.setor) continue;
      if (!posicoesPorSetor.has(p.setor)) posicoesPorSetor.set(p.setor, []);
      posicoesPorSetor.get(p.setor)!.push(p);
    }

    // Setores sobrealocados com mais de uma posição: só a de menor scoreFinal é candidata a venda.
    const idVendaEscolhidoPorSetor = new Map<string, string>();
    for (const setorInfo of state.sectors) {
      if (setorInfo.status !== 'sobrealocado') continue;
      const lista = posicoesPorSetor.get(setorInfo.setor) ?? [];
      const comScore = lista.filter((p) => p.scoreFinal != null).sort((a, b) => a.scoreFinal! - b.scoreFinal!);
      if (comScore.length) idVendaEscolhidoPorSetor.set(setorInfo.setor, comScore[0].id);
    }

    // Setores subalocados: rateia o déficit em R$ entre as posições qualificadas do setor —
    // reusa calcularValorCompraPorSetor (método público e puro, sem I/O).
    const valorCompraPorPosicao = new Map<string, number>();
    for (const setorInfo of state.sectors) {
      if (setorInfo.status !== 'subalocado') continue;
      const lista = posicoesPorSetor.get(setorInfo.setor) ?? [];
      if (!lista.length) continue; // setor descoberto — sem posição pra ratear, ADD_NEW_POSITION é B2
      const valorAlvoSetor = (setorInfo.percentualAlvo / 100) * state.valorTotalAcoes;
      const deficitSetor = valorAlvoSetor - setorInfo.valorAtual;
      const acoesContexto = lista.map((p) => ({ id: p.id, ticker: p.ticker, scoreFinal: p.scoreFinal, scoreQualidade: p.scoreQualidade, scorePreco: p.scorePreco }));
      for (const [id, valor] of this.investimentos.calcularValorCompraPorSetor(acoesContexto, deficitSetor)) {
        valorCompraPorPosicao.set(id, valor);
      }
    }

    const existeSetorSubalocado = state.sectors.some((s) => s.status === 'subalocado');
    const suprimirVendaPorCaixa = state.capital.existingCash > 0 && existeSetorSubalocado;

    for (const p of state.positions) {
      const setorInfo = p.setor ? state.sectors.find((s) => s.setor === p.setor) : undefined;
      const statusSetor = setorInfo?.status ?? null;

      let sugestaoRebalanceamento: 'comprar' | 'vender' | null = null;
      let valorSugerido: number | null = null;
      let escolhidaParaVender = false;

      if (statusSetor === 'sobrealocado' && setorInfo) {
        const escolhidoId = idVendaEscolhidoPorSetor.get(p.setor as string);
        escolhidaParaVender = !escolhidoId || escolhidoId === p.id;
        if (escolhidaParaVender) {
          sugestaoRebalanceamento = 'vender';
          const valorAlvoSetor = (setorInfo.percentualAlvo / 100) * state.valorTotalAcoes;
          valorSugerido = Math.min(setorInfo.valorAtual - valorAlvoSetor, p.valorAtual);
        }
      } else if (statusSetor === 'subalocado') {
        const valorSplit = valorCompraPorPosicao.get(p.id);
        if (valorSplit != null) {
          sugestaoRebalanceamento = 'comprar';
          valorSugerido = valorSplit;
        }
      }

      // Lote-padrão B3 / fracionário — mesmo arredondamento (nunca "sem arredondar") da matriz atual.
      let quantidadeSugerida: number | null = null;
      if (sugestaoRebalanceamento != null && valorSugerido != null && p.cotacaoAtual != null && p.cotacaoAtual > 0) {
        const quantidadeBruta = valorSugerido / p.cotacaoAtual;
        const quantidadeDisponivel = sugestaoRebalanceamento === 'vender' ? p.quantidade : null;
        const tamanhoUnidade = state.permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
        const quantidadeArredondada = arredondarParaLote(quantidadeBruta, quantidadeDisponivel, tamanhoUnidade);
        if (quantidadeArredondada <= 0) {
          sugestaoRebalanceamento = null;
          valorSugerido = null;
        } else {
          valorSugerido = quantidadeArredondada * p.cotacaoAtual;
          quantidadeSugerida = quantidadeArredondada;
        }
      }

      const melhor = p.scoreFinal != null ? this.melhorDoGrupo(state, p) : null;
      let tratouTroca = false;

      if (melhor && p.scoreFinal != null) {
        const scoreBaixo = p.scoreFinal < SCORE_BAIXO_MATRIZ;
        const deltaScore = melhor.scoreFinal != null ? melhor.scoreFinal - p.scoreFinal : null;
        const scoreFracoOuAtrasado = scoreBaixo || (deltaScore != null && deltaScore > DELTA_SCORE_TROCA);

        if ((statusSetor === 'subalocado' || statusSetor === 'equilibrado') && deltaScore != null && deltaScore > DELTA_SCORE_TROCA) {
          tratouTroca = true;
          moves.push({
            id: `rotate:${p.id}:${melhor.ticker}`,
            type: 'ROTATE_WITHIN_SECTOR',
            sourcePositionId: p.id,
            sourceTicker: p.ticker,
            targetTicker: melhor.ticker,
            setor: p.setor,
            amount: p.valorAtual,
            quantity: p.quantidade,
            primaryReason: 'LOW_RELATIVE_SCORE',
            secondaryReasons: statusSetor === 'subalocado' ? ['SECTOR_UNDERWEIGHT'] : [],
            confidence: this.confidenceDe(p.origemScore),
          });
          // Particularidade real da matriz atual, isolada FORA do PortfolioMove — ver comentário
          // de legacyCarryForwardSuggestions no topo do método.
          if (statusSetor === 'subalocado' && valorSugerido != null) {
            legacyCarryForwardSuggestions.set(p.id, { amount: valorSugerido, quantity: quantidadeSugerida });
          }
        } else if (statusSetor === 'sobrealocado' && scoreFracoOuAtrasado && escolhidaParaVender && sugestaoRebalanceamento === 'vender') {
          tratouTroca = true;
          if (suprimirVendaPorCaixa) {
            suppressedByAvailableCash.add(p.id);
          } else if (valorSugerido != null && quantidadeSugerida != null) {
            moves.push({
              id: `sell:${p.id}`,
              type: 'SELL',
              sourcePositionId: p.id,
              sourceTicker: p.ticker,
              setor: p.setor,
              amount: valorSugerido,
              quantity: quantidadeSugerida,
              primaryReason: 'SECTOR_OVERWEIGHT',
              secondaryReasons: ['LOW_RELATIVE_SCORE'],
              confidence: this.confidenceDe(p.origemScore),
            });
          }
          // suprimido por caixa: nenhum move pra essa necessidade (ver plano, ajuste 3)
        }
      }

      if (tratouTroca) continue;

      // Sem troca acionada — rebalanceamento puro (BUY reforçando o próprio ticker, ou REDUCE).
      if (statusSetor === 'subalocado' && sugestaoRebalanceamento === 'comprar' && valorSugerido != null && quantidadeSugerida != null) {
        moves.push({
          id: `buy:${p.id}`,
          type: 'BUY',
          targetTicker: p.ticker,
          setor: p.setor,
          amount: valorSugerido,
          quantity: quantidadeSugerida,
          primaryReason: 'SECTOR_UNDERWEIGHT',
          secondaryReasons: [],
          confidence: this.confidenceDe(p.origemScore),
        });
      } else if (statusSetor === 'sobrealocado' && escolhidaParaVender && sugestaoRebalanceamento === 'vender' && valorSugerido != null && quantidadeSugerida != null) {
        if (suprimirVendaPorCaixa) {
          suppressedByAvailableCash.add(p.id);
        } else {
          moves.push({
            id: `reduce:${p.id}`,
            type: 'REDUCE',
            sourcePositionId: p.id,
            sourceTicker: p.ticker,
            setor: p.setor,
            amount: valorSugerido,
            quantity: quantidadeSugerida,
            primaryReason: 'SECTOR_OVERWEIGHT',
            secondaryReasons: [],
            confidence: this.confidenceDe(p.origemScore),
          });
        }
      }
    }

    return { moves, suppressedByAvailableCash, legacyCarryForwardSuggestions };
  }

  /** Reproduz InvestimentoService['buscarMelhorDoGrupo'] em memória, usando state.investmentUniverse
   * em vez de bater no banco — mesma regra de agrupamento por tipoRanking. */
  private melhorDoGrupo(state: PortfolioState, p: PortfolioPositionState): InvestmentCandidateMetadata | null {
    let campoGrupo: 'setor' | 'segmento' | null = null;
    if (state.tipoRanking === 'setor' || state.tipoRanking === 'hibrido') campoGrupo = 'setor';
    else if (state.tipoRanking === 'segmento') campoGrupo = 'segmento';

    if (campoGrupo) {
      const valorGrupo = campoGrupo === 'setor' ? p.setor : p.segmento;
      if (!valorGrupo) return null; // sem classificação, não dá pra buscar — igual ao método original
    }

    const candidatos = state.investmentUniverse.filter((c) => {
      if (c.ticker === p.ticker || c.scoreFinal == null) return false;
      if (campoGrupo === 'setor') return c.setor === p.setor;
      if (campoGrupo === 'segmento') return c.segmento === p.segmento;
      return true; // 'geral'
    });
    if (!candidatos.length) return null;

    return candidatos.reduce((melhor, c) => ((c.scoreFinal ?? -Infinity) > (melhor.scoreFinal ?? -Infinity) ? c : melhor));
  }

  private confidenceDe(origemScore: OrigemScore | null): RankingConfidence {
    return origemScore === 'setor_fallback' ? 'MEDIUM' : 'HIGH';
  }

  /**
   * Modo B2 (multi-candidato): várias alternativas por necessidade, pro Evaluator escolher de
   * verdade (ver plano, Fase B2). Setor sobrealocado gera REDUCE pra CADA posição já possuída do
   * setor (pool naturalmente pequeno — só o que já é dono); setor subalocado/descoberto gera
   * BUY/ADD_NEW_POSITION a partir de candidatos diversificados do universo (não só top-N Score
   * Final — ver candidatesDiversificados). `ADD_NEW_POSITION` liga aqui (desligada na B1).
   */
  generateB2(state: PortfolioState, seeds: CandidateSeedConfig = DEFAULT_CANDIDATE_SEEDS): { moves: PortfolioMove[]; policyExclusions: PolicyExclusion[] } {
    const moves: PortfolioMove[] = [];
    const policyExclusions: PolicyExclusion[] = [];

    const posicoesPorSetor = new Map<string, PortfolioPositionState[]>();
    for (const p of state.positions) {
      if (!p.setor) continue;
      if (!posicoesPorSetor.has(p.setor)) posicoesPorSetor.set(p.setor, []);
      posicoesPorSetor.get(p.setor)!.push(p);
    }

    // `dynamicSectors` — mesma base ESTÁVEL (`searchAllocationBase`) que o Evaluator/Comparator
    // usam pra pontuar (= `stableSectors` em modo FIXED; banda por Preço em modo DYNAMIC_PRICE —
    // ver "Estouro Dinâmico"). Antes desta correção, `generateB2` decidia por `state.sectors`
    // (denominador VIVO), diferente do que o Comparator pontuava.
    //
    // Sem supressão por caixa aqui (ao contrário do `generateB1`) — ver achado do funding:
    // REDUCE/SELL nunca deveriam depender de `existingCash`, porque são eles que CRIAM capital
    // (`proceedsGeneratedByPlan`), nunca o consomem. A regra `existingCash>0 && existe subalocado
    // → suprimir venda` faz sentido pra reproduzir a matriz legada bit-a-bit (`generateB1`), mas
    // suprimia TODO candidato de redução no B2/busca mesmo quando o excesso do setor era muito
    // maior que o caixa parado (ex: R$57 de caixa suprimindo um excesso de milhares em Petróleo/
    // Utilidade Pública/Consumo Cíclico). Quem impede um BUY sem capital agora é
    // `hasSufficientFunding` (ver domain/portfolio-move.ts), aplicado só pelos consumidores B2/
    // busca — não aqui na geração.
    for (const setorInfo of state.dynamicSectors) {
      if (setorInfo.status === 'sobrealocado') {
        const lista = posicoesPorSetor.get(setorInfo.setor) ?? [];
        const valorAlvoSetor = (setorInfo.percentualAlvo / 100) * state.searchAllocationBase;
        const excessoAoTarget = setorInfo.valorAtual - valorAlvoSetor;
        if (excessoAoTarget <= 0) continue;

        // Move Sizing (ver plano): em vez de UM candidato sempre reduzindo até o target exato,
        // gera até 4 tamanhos economicamente relevantes — banda de tolerância (mínimo pra sair da
        // violação), meio-termo, target (comportamento antigo) e saída total — e deixa o Search
        // Engine comparar, em vez de assumir que "reduzir até o target" é sempre certo (SAPR4
        // virando "vende quase tudo" quando bastaria sair da banda).
        const bandaSetor = state.dynamicAllocationBands.find((b) => b.setor === setorInfo.setor);
        const bandMaxPercent = bandaSetor?.max ?? setorInfo.percentualAlvo + state.percentualEstouro;
        const valorNaFaixaSuperior = (bandMaxPercent / 100) * state.searchAllocationBase;
        const excessoAteFaixa = setorInfo.valorAtual - valorNaFaixaSuperior; // sempre > 0 aqui (setor já sobrealocado)

        for (const p of lista) {
          if (p.cotacaoAtual == null || p.cotacaoAtual <= 0) continue;
          const tamanhoUnidade = state.permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;

          const candidatosTamanho: { strategy: ReduceSizingStrategy; valorAlvo: number }[] = [
            { strategy: 'REDUCE_TO_UPPER_BAND', valorAlvo: Math.min(excessoAteFaixa, p.valorAtual) },
            { strategy: 'REDUCE_PARTIAL', valorAlvo: Math.min((excessoAteFaixa + excessoAoTarget) / 2, p.valorAtual) },
            { strategy: 'REDUCE_TO_TARGET', valorAlvo: Math.min(excessoAoTarget, p.valorAtual) },
            { strategy: 'FULL_EXIT', valorAlvo: p.valorAtual },
          ];

          const quantidadesJaGeradas = new Set<number>();
          for (const { strategy, valorAlvo } of candidatosTamanho) {
            if (valorAlvo <= 0) continue;
            const quantidadeArredondada = arredondarParaLote(valorAlvo / p.cotacaoAtual, p.quantidade, tamanhoUnidade);
            if (quantidadeArredondada <= 0) continue;
            if (quantidadesJaGeradas.has(quantidadeArredondada)) continue; // dedupe — banda estreita/posição pequena podem colidir
            quantidadesJaGeradas.add(quantidadeArredondada);

            const vendeTudo = quantidadeArredondada >= p.quantidade - 0.0001;
            moves.push({
              id: `reduceB2:${p.id}:${strategy}`,
              type: vendeTudo ? 'SELL' : 'REDUCE',
              sourcePositionId: p.id,
              sourceTicker: p.ticker,
              setor: p.setor,
              amount: quantidadeArredondada * p.cotacaoAtual,
              quantity: quantidadeArredondada,
              primaryReason: 'SECTOR_OVERWEIGHT',
              secondaryReasons: p.scoreFinal != null && p.scoreFinal < SCORE_BAIXO_MATRIZ ? ['LOW_RELATIVE_SCORE'] : [],
              confidence: this.confidenceDe(p.origemScore),
              sizingStrategy: strategy,
            });
          }
        }
      } else if (setorInfo.status === 'subalocado' || setorInfo.semNenhumaAcao) {
        const valorAlvoSetor = (setorInfo.percentualAlvo / 100) * state.searchAllocationBase;
        const deficitSetor = valorAlvoSetor - setorInfo.valorAtual;
        if (deficitSetor <= 0) continue;

        const candidatosBrutos = this.candidatosDiversificados(state, setorInfo.setor, seeds);
        const jaPossuidosTickers = new Set((posicoesPorSetor.get(setorInfo.setor) ?? []).map((p) => p.ticker));

        // Ownership+Entry Gate (RecommendationPolicy) — avaliado sobre a lista UNIFICADA, antes
        // de decidir BUY vs ADD_NEW_POSITION por ticker: POMO3 (já possuído) e MILS3 (novo)
        // disputam a MESMA necessidade (o déficit do setor), nunca sub-branches separados.
        const { admitidos: candidatos, excluidos } = this.recommendationPolicy.partitionBySectorNeed(candidatosBrutos);
        for (const { candidato, assessment } of excluidos) {
          policyExclusions.push({ ticker: candidato.ticker, setor: candidato.setor, segmento: candidato.segmento, assessment });
        }

        for (const c of candidatos) {
          if (c.cotacao == null || c.cotacao <= 0) continue;
          const tamanhoUnidade = state.permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
          const quantidadeArredondada = arredondarParaLote(deficitSetor / c.cotacao, null, tamanhoUnidade);
          if (quantidadeArredondada <= 0) continue;

          moves.push({
            id: `buyB2:${setorInfo.setor}:${c.ticker}`,
            type: jaPossuidosTickers.has(c.ticker) ? 'BUY' : 'ADD_NEW_POSITION',
            targetTicker: c.ticker,
            setor: setorInfo.setor,
            amount: quantidadeArredondada * c.cotacao,
            quantity: quantidadeArredondada,
            primaryReason: setorInfo.semNenhumaAcao ? 'NEW_SECTOR_POSITION' : 'SECTOR_UNDERWEIGHT',
            secondaryReasons: [],
            confidence: this.confidenceDe(c.origemScore),
          });
        }
      } else if (setorInfo.status === 'equilibrado') {
        // Fase C.1: setor "equilibrado" no agregado pode ainda estar mal composto por dentro (ex:
        // Financeiro 100% Bancos, nada em Seguros/Bolsas). Gera candidato de diversificação SÓ
        // com capital livre (nunca vendendo a posição concentrada pra financiar — "complementar,
        // nunca forçar" pedido pelo usuário); sem capital livre, nenhum candidato nasce.
        const concentracao = state.segmentConcentration.find((s) => s.setor === setorInfo.setor);
        if (!concentracao?.concentrado) continue;

        const capitalLivre = availableToInvest(state.capital);
        if (capitalLivre <= 0) continue;

        const segmentoDominante = concentracao.segments.reduce((max, s) => (s.percentualDoSetor > max.percentualDoSetor ? s : max)).segmento;
        const jaPossuidosTickers = new Set((posicoesPorSetor.get(setorInfo.setor) ?? []).map((p) => p.ticker));

        const melhorPorSegmentoSubRepresentado = new Map<string, InvestmentCandidateMetadata>();
        for (const c of state.investmentUniverse) {
          if (c.setor !== setorInfo.setor || c.segmento == null || c.segmento === segmentoDominante || c.scoreFinal == null) continue;
          const atual = melhorPorSegmentoSubRepresentado.get(c.segmento);
          if (!atual || (c.scoreFinal ?? -Infinity) > (atual.scoreFinal ?? -Infinity)) melhorPorSegmentoSubRepresentado.set(c.segmento, c);
        }

        for (const c of melhorPorSegmentoSubRepresentado.values()) {
          if (c.cotacao == null || c.cotacao <= 0) continue;

          // Ownership+Entry Gate avaliado POR SEGMENTO (necessidade própria) — diversificar pro
          // segmento B e diversificar pro segmento C são necessidades DIFERENTES; um PREFERRED
          // em B não pode eliminar um ELIGIBLE saudável em C (ver plano, fixture do trade-off).
          const { admitidos, excluidos } = this.recommendationPolicy.partitionBySectorNeed([c]);
          for (const { candidato, assessment } of excluidos) {
            policyExclusions.push({ ticker: candidato.ticker, setor: candidato.setor, segmento: candidato.segmento, assessment });
          }
          if (!admitidos.length) continue;

          const tamanhoUnidade = state.permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
          const quantidadeArredondada = arredondarParaLote(capitalLivre / c.cotacao, null, tamanhoUnidade);
          if (quantidadeArredondada <= 0) continue;

          moves.push({
            id: `diversifyB2:${setorInfo.setor}:${c.ticker}`,
            type: jaPossuidosTickers.has(c.ticker) ? 'BUY' : 'ADD_NEW_POSITION',
            targetTicker: c.ticker,
            setor: setorInfo.setor,
            amount: quantidadeArredondada * c.cotacao,
            quantity: quantidadeArredondada,
            primaryReason: 'SEGMENT_CONCENTRATION',
            secondaryReasons: [],
            confidence: this.confidenceDe(c.origemScore),
          });
        }
      }
    }

    return { moves, policyExclusions };
  }

  /**
   * Sementes diversificadas (ajuste 6 do plano): top-N por Score Final, top-N por Qualidade Δ,
   * Risco Δ e Preço Δ, união deduplicada por ticker. Evita que um candidato excelente num eixo
   * específico (mas não top-3 em Score Final) fique fora da árvore.
   */
  private candidatosDiversificados(state: PortfolioState, setor: string, seeds: CandidateSeedConfig): InvestmentCandidateMetadata[] {
    const doSetor = state.investmentUniverse.filter((c) => c.setor === setor && c.scoreFinal != null);

    const topPor = <K extends keyof InvestmentCandidateMetadata>(campo: K, n: number) =>
      [...doSetor]
        .filter((c) => c[campo] != null)
        .sort((a, b) => (b[campo] as number) - (a[campo] as number))
        .slice(0, n);

    const uniao = [...topPor('scoreFinal', seeds.finalScore), ...topPor('qualidadeDelta', seeds.quality), ...topPor('riscoDelta', seeds.risk), ...topPor('precoDelta', seeds.price)];

    const vistos = new Set<string>();
    const diversificados = uniao.filter((c) => (vistos.has(c.ticker) ? false : (vistos.add(c.ticker), true)));

    // 5ª semente (Fase C.1): garante que TODO segmento presente no setor tenha ao menos 1
    // candidato na árvore, mesmo que nenhum dos seus tickers seja top-N nos 4 critérios acima —
    // sem isso, um segmento sub-representado nunca teria chance de competir pra complementar uma
    // posição já dominante do mesmo setor.
    const segmentosJaRepresentados = new Set(diversificados.map((c) => c.segmento).filter((s): s is string => s != null));
    const porSegmento = new Map<string, InvestmentCandidateMetadata>();
    for (const c of doSetor) {
      if (!c.segmento || segmentosJaRepresentados.has(c.segmento) || vistos.has(c.ticker)) continue;
      const atual = porSegmento.get(c.segmento);
      if (!atual || (c.scoreFinal ?? -Infinity) > (atual.scoreFinal ?? -Infinity)) porSegmento.set(c.segmento, c);
    }

    return [...diversificados, ...porSegmento.values()];
  }
}
