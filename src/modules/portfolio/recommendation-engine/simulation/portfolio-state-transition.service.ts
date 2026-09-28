import { Injectable } from '@nestjs/common';
import { availableToInvest, computeSectorAllocation, computeSegmentConcentration, PortfolioCapitalState, PortfolioPositionState, PortfolioState } from '../domain/portfolio-state';
import { DynamicAllocationBandResult } from '../domain/dynamic-allocation-band';
import { PortfolioMove } from '../domain/portfolio-move';
import { arredondarParaLote, TAMANHO_FRACIONARIO, TAMANHO_LOTE } from '../../services/lote';
import { DynamicAllocationBandService } from '../allocation-band/dynamic-allocation-band.service';

/** Resultado de `apply()` — além do novo estado, expõe os dois lados do capital movimentado
 * (ver plano, Fase C seção 0.2 / ajuste 5 do usuário): `ROTATE_WITHIN_SECTOR` mexe nos DOIS lados
 * (venda + compra), então `move.amount` sozinho (só o lado da venda) subestimava o turnover real
 * de uma rotação. `turnoverEfetivo = saleNotional + purchaseNotional` é responsabilidade de quem
 * consome (Fase C, SearchEngine) somar — este serviço só expõe os dois números crus. */
export interface PortfolioTransitionResult {
  state: PortfolioState;
  /** 0 em BUY/ADD_NEW_POSITION. */
  saleNotional: number;
  /** 0 em SELL/REDUCE. */
  purchaseNotional: number;
}

/**
 * (PortfolioState, PortfolioMove) -> novo PortfolioState (+ notionais de venda/compra).
 * Generaliza InvestimentoService.simularImpactoCompra (que só cobria compra) pra BUY/
 * ADD_NEW_POSITION/REDUCE/SELL/ROTATE_WITHIN_SECTOR. Nunca muta `state` — sempre retorna um
 * objeto novo (permite avaliar vários candidatos a partir do MESMO estado-base sem interferência,
 * essencial pra B2/C).
 *
 * Mantém PortfolioCapitalState coerente (ver plano, ajuste 5 da B2): SELL/REDUCE incrementam
 * `proceedsGeneratedByPlan`; BUY/ADD_NEW_POSITION debitam de availableToInvest (proceeds
 * primeiro, depois aporte externo, depois caixa parado — gasta primeiro o dinheiro que o próprio
 * plano acabou de liberar). ROTATE_WITHIN_SECTOR não mexe em capital LÍQUIDO (venda financia a
 * compra no mesmo passo), mas AINDA ASSIM movimenta os dois lados — refletido em
 * `saleNotional`/`purchaseNotional`, não em `capital`.
 */
@Injectable()
export class PortfolioStateTransitionService {
  constructor(private readonly dynamicAllocationBandService: DynamicAllocationBandService) {}

  apply(state: PortfolioState, move: PortfolioMove): PortfolioTransitionResult {
    let positions = state.positions.map((p) => ({ ...p }));
    let capital = { ...state.capital };
    let saleNotional = 0;
    let purchaseNotional = 0;

    switch (move.type) {
      case 'SELL':
      case 'REDUCE': {
        positions = this.aplicarVenda(positions, move);
        capital = { ...capital, proceedsGeneratedByPlan: capital.proceedsGeneratedByPlan + move.amount };
        saleNotional = move.amount;
        break;
      }
      case 'BUY': {
        positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, move.quantity);
        capital = this.debitarCapital(capital, move.amount);
        this.garantirCapitalNaoNegativo(capital, move);
        purchaseNotional = move.amount;
        break;
      }
      case 'ADD_NEW_POSITION': {
        positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, move.quantity);
        capital = this.debitarCapital(capital, move.amount);
        this.garantirCapitalNaoNegativo(capital, move);
        purchaseNotional = move.amount;
        break;
      }
      case 'ROTATE_WITHIN_SECTOR': {
        positions = this.aplicarVenda(positions, move);
        saleNotional = move.amount;
        // Lote/fracionário (invariante 3): a compra do destino pode não fechar exatamente o valor
        // vendido (arredondamento pra baixo). O residual NUNCA pode desaparecer — vira
        // proceedsGeneratedByPlan (capital não alocado), igual a qualquer venda sem par exato.
        const candidatoDestino = state.investmentUniverse.find((c) => c.ticker === move.targetTicker);
        const cotacaoDestino = candidatoDestino?.cotacao ?? null;
        let valorComprado = move.amount;
        if (cotacaoDestino != null && cotacaoDestino > 0) {
          const tamanhoUnidade = state.permiteFracionario ? TAMANHO_FRACIONARIO : TAMANHO_LOTE;
          const quantidadeArredondada = arredondarParaLote(move.amount / cotacaoDestino, null, tamanhoUnidade);
          valorComprado = quantidadeArredondada * cotacaoDestino;
          positions = this.aplicarCompra(state, positions, move.targetTicker!, valorComprado, quantidadeArredondada);
        } else {
          positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, undefined);
        }
        purchaseNotional = valorComprado;
        const residual = move.amount - valorComprado;
        if (Math.abs(residual) > 1e-9) {
          capital = { ...capital, proceedsGeneratedByPlan: capital.proceedsGeneratedByPlan + residual };
        }
        break;
      }
    }

    return { state: this.recalcularAgregados({ ...state, positions, capital }), saleNotional, purchaseNotional };
  }

  /** Invariante defensivo (rede de segurança, não o mecanismo principal — quem impede um BUY sem
   * capital é `hasSufficientFunding`, aplicado ANTES de chegar aqui pelos consumidores B2/busca).
   * Nunca deveria disparar; se disparar, é bug no Generator/Validator/funding-check, não um estado
   * "meio inválido" que deveríamos silenciosamente aceitar. */
  private garantirCapitalNaoNegativo(capital: PortfolioCapitalState, move: PortfolioMove): void {
    if (availableToInvest(capital) < -1e-6) {
      throw new Error(`StateTransition: move ${move.id} (${move.type} ${move.targetTicker}) deixaria capital negativo — capital insuficiente não foi barrado antes de aplicar`);
    }
  }

  private aplicarVenda(positions: PortfolioPositionState[], move: PortfolioMove): PortfolioPositionState[] {
    const idx = positions.findIndex((p) => p.id === move.sourcePositionId);
    if (idx === -1) throw new Error(`StateTransition: posição ${move.sourcePositionId} não encontrada no estado`);
    const pos = positions[idx];
    const quantidadeVendida = move.quantity ?? pos.quantidade;
    const restante = pos.quantidade - quantidadeVendida;

    const resultado = [...positions];
    if (restante <= 0.0001) {
      resultado.splice(idx, 1);
    } else {
      resultado[idx] = { ...pos, quantidade: restante, valorAtual: pos.cotacaoAtual != null ? restante * pos.cotacaoAtual : 0 };
    }
    return resultado;
  }

  private aplicarCompra(state: PortfolioState, positions: PortfolioPositionState[], ticker: string, valor: number, quantidadeInformada?: number): PortfolioPositionState[] {
    const candidato = state.investmentUniverse.find((c) => c.ticker === ticker);
    const cotacao = candidato?.cotacao ?? null;
    const quantidade = quantidadeInformada ?? (cotacao != null && cotacao > 0 ? valor / cotacao : 0);

    const idx = positions.findIndex((p) => p.ticker === ticker);
    const resultado = [...positions];

    if (idx >= 0) {
      const pos = positions[idx];
      const novaQuantidade = pos.quantidade + quantidade;
      const novoPrecoMedio = novaQuantidade > 0 ? (pos.quantidade * pos.precoMedio + valor) / novaQuantidade : pos.precoMedio;
      resultado[idx] = {
        ...pos,
        quantidade: novaQuantidade,
        precoMedio: novoPrecoMedio,
        valorAtual: cotacao != null ? novaQuantidade * cotacao : pos.valorAtual + valor,
      };
    } else {
      resultado.push({
        id: `novo:${ticker}`,
        ticker,
        nome: candidato?.nome ?? ticker,
        tipo: 'acao',
        quantidade,
        precoMedio: cotacao ?? (quantidade > 0 ? valor / quantidade : 0),
        cotacaoAtual: cotacao,
        valorAtual: cotacao != null ? quantidade * cotacao : valor,
        setor: candidato?.setor ?? null,
        segmento: candidato?.segmento ?? null,
        scoreQualidade: candidato?.scoreQualidade ?? null,
        qualidadeDelta: candidato?.qualidadeDelta ?? null,
        scoreRisco: candidato?.scoreRisco ?? null,
        riscoDelta: candidato?.riscoDelta ?? null,
        riscoComposto: candidato?.riscoComposto ?? null,
        scorePreco: candidato?.scorePreco ?? null,
        precoDelta: candidato?.precoDelta ?? null,
        scoreFinal: candidato?.scoreFinal ?? null,
        scoreFinalDelta: candidato?.scoreFinalDelta ?? null,
        origemScore: candidato?.origemScore ?? null,
      });
    }
    return resultado;
  }

  private debitarCapital(capital: PortfolioCapitalState, amount: number): PortfolioCapitalState {
    let restante = amount;
    let proceeds = capital.proceedsGeneratedByPlan;
    let externo = capital.externalContributionBudget;
    let existing = capital.existingCash;

    const usarProceeds = Math.min(restante, proceeds);
    proceeds -= usarProceeds;
    restante -= usarProceeds;

    const usarExterno = Math.min(restante, externo);
    externo -= usarExterno;
    restante -= usarExterno;

    existing -= restante; // pode ficar negativo se faltar capital — Validator (Fase C) trava isso antes de aplicar

    return { existingCash: existing, externalContributionBudget: externo, proceedsGeneratedByPlan: proceeds };
  }

  private recalcularAgregados(state: PortfolioState): PortfolioState {
    const valorTotalAcoes = state.positions.reduce((acc, p) => acc + p.valorAtual, 0);

    const valorPorSetor = new Map<string, number>();
    for (const p of state.positions) {
      if (!p.setor) continue;
      valorPorSetor.set(p.setor, (valorPorSetor.get(p.setor) ?? 0) + p.valorAtual);
    }

    const alvoPorSetor = new Map(state.sectors.map((s) => [s.setor, s.percentualAlvo]));

    // Denominador VIVO (legado/B1) vs ESTÁVEL (searchAllocationBase, congelado em t0, nunca
    // recalculado aqui) — mesma dualidade do snapshot (ver "achado" do Estouro Dinâmico).
    const sectors = computeSectorAllocation(valorPorSetor, alvoPorSetor, valorTotalAcoes, state.percentualEstouro);
    const stableSectors = computeSectorAllocation(valorPorSetor, alvoPorSetor, state.searchAllocationBase, state.percentualEstouro);

    // valorTotalCarteira acompanha a variação do lado de ações — FIIs/renda fixa não entram em
    // `positions` (fora do escopo do motor de recomendações) e não mudam nesta transição.
    const deltaAcoes = valorTotalAcoes - state.valorTotalAcoes;
    const segmentConcentration = computeSegmentConcentration(state.positions, state.investmentUniverse, sectors);

    let dynamicAllocationBands: DynamicAllocationBandResult[] = [];
    let dynamicSectors = stableSectors;
    if (state.rebalanceToleranceMode === 'DYNAMIC_PRICE') {
      // sectorMarketStates é invariante durante a busca (deriva só de investmentUniverse, que
      // StateTransition nunca modifica) — carregado adiante sem recomputar.
      const marketStatePorSetor = new Map(state.sectorMarketStates.map((s) => [s.setor, s]));
      dynamicAllocationBands = stableSectors.map((s) =>
        this.dynamicAllocationBandService.calculate({
          setor: s.setor,
          target: s.percentualAlvo,
          percentualAtual: s.percentualAtual,
          baseTolerance: state.percentualEstouro,
          marketState: marketStatePorSetor.get(s.setor),
          universo: state.sectorMarketStates,
          maxAdjustment: state.dynamicRebalanceConfig.maxAdjustment,
          guardrailEnabled: state.dynamicRebalanceConfig.guardrailEnabled,
        }),
      );
      const bandaPorSetor = new Map(dynamicAllocationBands.map((b) => [b.setor, b]));
      dynamicSectors = stableSectors.map((s) => ({ ...s, status: bandaPorSetor.get(s.setor)?.status ?? s.status }));
    }

    return {
      ...state,
      valorTotalAcoes,
      sectors,
      stableSectors,
      dynamicSectors,
      dynamicAllocationBands,
      segmentConcentration,
      valorTotalCarteira: state.valorTotalCarteira + deltaAcoes,
    };
  }
}
