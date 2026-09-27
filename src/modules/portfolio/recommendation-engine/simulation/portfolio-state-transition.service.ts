import { Injectable } from '@nestjs/common';
import { PortfolioCapitalState, PortfolioPositionState, PortfolioState, SectorAllocationState } from '../domain/portfolio-state';
import { PortfolioMove } from '../domain/portfolio-move';

/**
 * (PortfolioState, PortfolioMove) -> novo PortfolioState. Generaliza
 * InvestimentoService.simularImpactoCompra (que só cobria compra) pra BUY/ADD_NEW_POSITION/
 * REDUCE/SELL/ROTATE_WITHIN_SECTOR. Nunca muta `state` — sempre retorna um objeto novo (permite
 * avaliar vários candidatos a partir do MESMO estado-base sem interferência, essencial pra B2).
 *
 * Mantém PortfolioCapitalState coerente (ver plano, ajuste 5): SELL/REDUCE incrementam
 * `proceedsGeneratedByPlan`; BUY/ADD_NEW_POSITION debitam de availableToInvest (proceeds
 * primeiro, depois aporte externo, depois caixa parado — gasta primeiro o dinheiro que o próprio
 * plano acabou de liberar). ROTATE_WITHIN_SECTOR não mexe em capital (venda e compra
 * simultâneas, líquido zero).
 */
@Injectable()
export class PortfolioStateTransitionService {
  apply(state: PortfolioState, move: PortfolioMove): PortfolioState {
    let positions = state.positions.map((p) => ({ ...p }));
    let capital = { ...state.capital };

    switch (move.type) {
      case 'SELL':
      case 'REDUCE': {
        positions = this.aplicarVenda(positions, move);
        capital = { ...capital, proceedsGeneratedByPlan: capital.proceedsGeneratedByPlan + move.amount };
        break;
      }
      case 'BUY': {
        positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, move.quantity);
        capital = this.debitarCapital(capital, move.amount);
        break;
      }
      case 'ADD_NEW_POSITION': {
        positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, move.quantity);
        capital = this.debitarCapital(capital, move.amount);
        break;
      }
      case 'ROTATE_WITHIN_SECTOR': {
        positions = this.aplicarVenda(positions, move);
        positions = this.aplicarCompra(state, positions, move.targetTicker!, move.amount, undefined);
        // capital inalterado — venda financia a compra no mesmo passo, líquido zero
        break;
      }
    }

    return this.recalcularAgregados({ ...state, positions, capital });
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
    const setoresNomes = new Set([...state.sectors.map((s) => s.setor), ...valorPorSetor.keys()]);

    const sectors: SectorAllocationState[] = [...setoresNomes].map((setor) => {
      const valorAtual = valorPorSetor.get(setor) ?? 0;
      const percentualAtual = valorTotalAcoes > 0 ? (valorAtual / valorTotalAcoes) * 100 : 0;
      const percentualAlvo = alvoPorSetor.get(setor) ?? 0;
      const diferenca = percentualAtual - percentualAlvo;
      let status: SectorAllocationState['status'] = 'equilibrado';
      if (diferenca > state.percentualEstouro) status = 'sobrealocado';
      else if (diferenca < -state.percentualEstouro) status = 'subalocado';
      return { setor, valorAtual, percentualAtual, percentualAlvo, diferenca, status, semNenhumaAcao: valorAtual <= 0 && percentualAlvo > 0 };
    });

    // valorTotalCarteira acompanha a variação do lado de ações — FIIs/renda fixa não entram em
    // `positions` (fora do escopo do motor de recomendações) e não mudam nesta transição.
    const deltaAcoes = valorTotalAcoes - state.valorTotalAcoes;

    return { ...state, valorTotalAcoes, sectors, valorTotalCarteira: state.valorTotalCarteira + deltaAcoes };
  }
}
