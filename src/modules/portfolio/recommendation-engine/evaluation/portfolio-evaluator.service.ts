import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { PortfolioBalanceState, PortfolioEvaluation, SearchHealthAxis } from '../domain/portfolio-evaluation';

const LIMIAR_COVERAGE_AVISO = 0.8;

/**
 * Função pura: PortfolioState -> PortfolioEvaluation. Sem PrismaService, sem I/O — tudo já veio
 * pronto no snapshot (ver PortfolioSnapshotService). Isso é o que permite avaliar múltiplos
 * estados hipotéticos (Fase B em diante) sem bater no banco por candidato.
 *
 * `health.displayed` reproduz EXATAMENTE a matemática de InvestimentoService.getSaudeCarteira —
 * nenhuma mudança de fórmula (ver plano, ajuste 1). `health.search` é um cálculo NOVO e paralelo
 * (mesmos pesos, mas usando os 3 eixos Δ), só consumido pelo motor de busca (Fase B+).
 */
@Injectable()
export class PortfolioEvaluatorService {
  evaluate(state: PortfolioState): PortfolioEvaluation {
    let somaQualidade = 0, somaRisco = 0, somaPreco = 0, somaFinal = 0;
    let pesoQualidade = 0, pesoRisco = 0, pesoPreco = 0, pesoFinal = 0;

    let somaQualidadeDelta = 0, somaRiscoDelta = 0, somaPrecoDelta = 0;
    let pesoQualidadeDelta = 0, pesoRiscoDelta = 0, pesoPrecoDelta = 0;

    for (const p of state.positions) {
      if (p.valorAtual <= 0) continue;

      if (p.scoreQualidade != null) { somaQualidade += p.valorAtual * p.scoreQualidade; pesoQualidade += p.valorAtual; }
      if (p.riscoComposto != null) { somaRisco += p.valorAtual * p.riscoComposto; pesoRisco += p.valorAtual; }
      if (p.scorePreco != null) { somaPreco += p.valorAtual * p.scorePreco; pesoPreco += p.valorAtual; }
      if (p.scoreFinal != null) { somaFinal += p.valorAtual * p.scoreFinal; pesoFinal += p.valorAtual; }

      if (p.qualidadeDelta != null) { somaQualidadeDelta += p.valorAtual * p.qualidadeDelta; pesoQualidadeDelta += p.valorAtual; }
      if (p.riscoDelta != null) { somaRiscoDelta += p.valorAtual * p.riscoDelta; pesoRiscoDelta += p.valorAtual; }
      if (p.precoDelta != null) { somaPrecoDelta += p.valorAtual * p.precoDelta; pesoPrecoDelta += p.valorAtual; }
    }

    const displayed = {
      scoreQualidadeMedio: pesoQualidade > 0 ? somaQualidade / pesoQualidade : null,
      riscoCompostoMedio: pesoRisco > 0 ? somaRisco / pesoRisco : null,
      scorePrecoMedio: pesoPreco > 0 ? somaPreco / pesoPreco : null,
      scoreFinalMedio: pesoFinal > 0 ? somaFinal / pesoFinal : null,
      pesoQualidade,
      pesoRisco,
      pesoPreco,
      pesoFinal,
      valorTotalCarteira: state.valorTotalCarteira,
    };

    const eixo = (soma: number, peso: number): SearchHealthAxis => ({
      value: peso > 0 ? soma / peso : null,
      coverage: state.valorTotalAcoes > 0 ? peso / state.valorTotalAcoes : 0,
    });

    const search = {
      quality: eixo(somaQualidadeDelta, pesoQualidadeDelta),
      risk: eixo(somaRiscoDelta, pesoRiscoDelta),
      price: eixo(somaPrecoDelta, pesoPrecoDelta),
    };

    const lowCoverageWarnings: string[] = [];
    if (state.valorTotalAcoes > 0) {
      const registrarAvisoSeBaixo = (label: string, axis: SearchHealthAxis, campo: 'qualidadeDelta' | 'riscoDelta' | 'precoDelta') => {
        if (axis.coverage >= LIMIAR_COVERAGE_AVISO) return;
        const semDado = state.positions.filter((p) => p.valorAtual > 0 && p[campo] == null).map((p) => p.ticker);
        const pct = Math.round(axis.coverage * 100);
        lowCoverageWarnings.push(`${label} cobre só ${pct}% da carteira — ${semDado.join(', ') || 'ver posições sem Δ'} sem dado`);
      };
      registrarAvisoSeBaixo('Qualidade Δ', search.quality, 'qualidadeDelta');
      registrarAvisoSeBaixo('Risco Δ', search.risk, 'riscoDelta');
      registrarAvisoSeBaixo('Preço Δ', search.price, 'precoDelta');
    }

    const setoresOrdenados = [...state.sectors].sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));
    const overweightSectors = setoresOrdenados.filter((s) => s.status === 'sobrealocado');
    const underweightSectors = setoresOrdenados.filter((s) => s.status === 'subalocado');
    const balance: PortfolioBalanceState = {
      setores: setoresOrdenados,
      sectorsOutsideBand: overweightSectors.length + underweightSectors.length,
      totalSectorDeviation: state.sectors.reduce((acc, s) => acc + Math.abs(s.diferenca), 0),
      overweightSectors,
      underweightSectors,
      positionConcentrationViolations: [],
      hardViolations: [],
    };

    return {
      health: { displayed, search, lowCoverageWarnings },
      balance,
    };
  }
}
