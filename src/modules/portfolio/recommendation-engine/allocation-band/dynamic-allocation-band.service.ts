import { Injectable } from '@nestjs/common';
import { deriveSectorStatus } from '../domain/portfolio-state';
import { DynamicAllocationBandResult } from '../domain/dynamic-allocation-band';
import { QTD_MINIMA_AMOSTRA_PRECO_SETOR, SectorMarketState } from '../domain/sector-market-state';

export interface CalcularBandaParams {
  setor: string;
  target: number;
  percentualAtual: number;
  baseTolerance: number;
  marketState: SectorMarketState | undefined;
  /** Todos os setores do mês com amostra suficiente — universo de comparação do percentil. */
  universo: SectorMarketState[];
  maxAdjustment: number;
  guardrailEnabled: boolean;
}

/**
 * Função pura: nenhuma query, nenhum I/O — os dados chegam prontos do Snapshot
 * (`SectorMarketState[]`, já construído a partir de `investmentUniverse`). Ver plano "Estouro
 * Dinâmico".
 *
 * O `target` estratégico NUNCA muda por atratividade de preço (seção 16 do pedido) — só o
 * `min`/`max` de tolerância ao redor dele. Setor caro (Preço pouco atrativo) ganha MAIS
 * tolerância pra ficar subalocado e MENOS pra ficar sobrealocado; setor barato, o oposto.
 */
@Injectable()
export class DynamicAllocationBandService {
  calculate(params: CalcularBandaParams): DynamicAllocationBandResult {
    const { setor, target, percentualAtual, baseTolerance, marketState, universo, maxAdjustment, guardrailEnabled } = params;

    // Target=0 é hard constraint (seção 9) — atratividade de preço nunca cria exposição sozinha.
    if (target === 0) {
      return {
        setor, target, baseTolerance, priceAttractiveness: null, dynamicAdjustment: 0,
        lowerTolerance: baseTolerance, upperTolerance: baseTolerance, min: 0, max: 0,
        status: deriveSectorStatus(percentualAtual, 0, 0), guardrailApplied: false, fallbackReason: null,
      };
    }

    const amostraInsuficiente = !marketState || marketState.amostra < QTD_MINIMA_AMOSTRA_PRECO_SETOR || marketState.precoDeltaMedio == null;
    if (amostraInsuficiente) {
      const min = Math.max(0, target - baseTolerance);
      const max = target + baseTolerance;
      return {
        setor, target, baseTolerance, priceAttractiveness: null, dynamicAdjustment: 0,
        lowerTolerance: baseTolerance, upperTolerance: baseTolerance, min, max,
        status: deriveSectorStatus(percentualAtual, min, max), guardrailApplied: false, fallbackReason: 'INSUFFICIENT_PRICE_DATA',
      };
    }

    const percentilDe = (campo: 'precoDeltaMedio' | 'qualidadeDeltaMedio' | 'riscoDeltaMedio', setorAlvo: string): number | null => {
      const comparaveis = universo.filter((s) => s[campo] != null);
      if (comparaveis.length < 2) return null;
      const ordenado = [...comparaveis].sort((a, b) => (a[campo] as number) - (b[campo] as number));
      const idx = ordenado.findIndex((s) => s.setor === setorAlvo);
      if (idx === -1) return null;
      return 2 * (idx / (ordenado.length - 1)) - 1;
    };

    const priceAttractiveness = percentilDe('precoDeltaMedio', setor);
    if (priceAttractiveness == null) {
      const min = Math.max(0, target - baseTolerance);
      const max = target + baseTolerance;
      return {
        setor, target, baseTolerance, priceAttractiveness: null, dynamicAdjustment: 0,
        lowerTolerance: baseTolerance, upperTolerance: baseTolerance, min, max,
        status: deriveSectorStatus(percentualAtual, min, max), guardrailApplied: false, fallbackReason: 'INSUFFICIENT_PRICE_DATA',
      };
    }

    // Guardrail (seção 8) — "está barato" sozinho não pode justificar grande expansão positiva
    // se Qualidade/Risco do setor não sustentam isso. Só neutraliza a parte POSITIVA (mais
    // tolerância pra sobrealocação); nunca restringe o lado negativo.
    let priceAttractivenessEfetiva = priceAttractiveness;
    let guardrailApplied = false;
    if (guardrailEnabled && priceAttractiveness > 0) {
      const qualidadeAttractiveness = percentilDe('qualidadeDeltaMedio', setor);
      const riscoAttractiveness = percentilDe('riscoDeltaMedio', setor);
      const qualidadeOuRiscoFracos = (qualidadeAttractiveness != null && qualidadeAttractiveness < 0) || (riscoAttractiveness != null && riscoAttractiveness < 0);
      if (qualidadeOuRiscoFracos) {
        priceAttractivenessEfetiva = 0;
        guardrailApplied = true;
      }
    }

    const dynamicAdjustment = maxAdjustment * priceAttractivenessEfetiva;
    const upperTolerance = baseTolerance + dynamicAdjustment;
    const lowerTolerance = baseTolerance - dynamicAdjustment;
    const min = Math.max(0, target - lowerTolerance);
    const max = target + upperTolerance;

    return {
      setor, target, baseTolerance, priceAttractiveness, dynamicAdjustment, lowerTolerance, upperTolerance, min, max,
      status: deriveSectorStatus(percentualAtual, min, max), guardrailApplied, fallbackReason: null,
    };
  }
}
