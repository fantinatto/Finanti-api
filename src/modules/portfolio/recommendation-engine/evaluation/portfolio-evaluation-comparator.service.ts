import { Injectable } from '@nestjs/common';
import { PortfolioEvaluation, SearchHealthAxis } from '../domain/portfolio-evaluation';
import { RankingConfidence } from '../domain/portfolio-move';

type Eixo = 'quality' | 'risk' | 'price';
export type CriterioDecisao =
  | 'hardViolations'
  | 'balance'
  | 'segmentConcentration'
  | 'roundTripPenalty'
  | 'maxDeficit'
  | 'sumDeficit'
  | 'dominance'
  | 'confidence'
  | 'turnover'
  | 'tie';

export interface CandidatoParaComparar {
  evaluation: PortfolioEvaluation;
  amount: number;
  confidence: RankingConfidence;
  scoreFinalResultante: number | null;
  /** true quando a linha vende/reduz um ticker E compra/reforça o MESMO ticker de volta em algum
   * outro ponto (não precisa ser adjacente — reversão adjacente já é bloqueada pelo
   * `PortfolioCycleGuardService`) — ver `detectRoundTripSameTicker` em `domain/portfolio-move.ts`.
   * Achado real (Cenário 5B da bateria de depth=3): sem essa guarda, uma melhoria irrisória de
   * `balance` (ruído de arredondamento) podia deixar uma linha "vende tudo, recompra quase tudo"
   * vencer só por ter, por coincidência, um `amount` cumulativo ligeiramente menor. */
  roundTripDetected: boolean;
}

export interface CompareConfig {
  /** pp de `totalSectorDeviation` abaixo do qual duas linhas são tratadas como empatadas no passo
   * `balance` — NÃO é o épsilon técnico de ponto flutuante (esse continua existindo, é menor e
   * só evita ruído de arredondamento; este é um piso ECONÔMICO, "essa diferença não é real o
   * bastante pra decidir sozinha"). Default abaixo, configurável por chamada. */
  balanceMaterialityThresholdPp?: number;
}

export const DEFAULT_BALANCE_MATERIALITY_THRESHOLD_PP = 0.1;

export interface ResultadoComparacao {
  vencedor: 'a' | 'b' | 'tie';
  decidiuPor: CriterioDecisao;
  /** Eixos onde a diferença de coverage entre os dois candidatos impediu comparar o value com
   * confiança (ver plano, ajuste 9 da B2 / seção 0.1 da Fase C) — auditável, não bloqueia a
   * decisão, só pula esse eixo nos passos 3-5. */
  ignoredCoverageShiftAxes: Eixo[];
}

const NEUTRO = 1.5;
/** Diferença de coverage acima da qual dois candidatos deixam de ser comparáveis naquele eixo —
 * exportada pra `PortfolioDominanceService` (Fase C) usar o MESMO critério, sem duplicar o
 * número em dois lugares. */
export const LIMIAR_DIFERENCA_COVERAGE = 0.01;
const ORDEM_EIXO: Eixo[] = ['risk', 'quality', 'price'];

/**
 * Ordem lexicográfica formal — nunca uma média ponderada. Cada critério só decide se os
 * anteriores empataram.
 *
 * Déficit residual (ver plano da Fase C, seção 0.1 — ajuste 1 do usuário): comparar dois estados
 * ancorado no déficit de um `state0` fixo causa overcorrection — se um move já resolveu o eixo
 * mais fraco original, a busca continuaria otimizando esse eixo (já resolvido) em vez do que
 * ficou fraco DEPOIS. Por isso o déficit usado aqui é sempre do PRÓPRIO estado sendo comparado
 * (`a`/`b`), nunca de um estado externo — não existe mais parâmetro `before`. Quem ainda precisa
 * do déficit de `state0` como heurística de EFICIÊNCIA (não de vitória) é o
 * `PortfolioMoveOrderingService` da Fase C, uma camada diferente.
 */
@Injectable()
export class PortfolioEvaluationComparatorService {
  compare(a: CandidatoParaComparar, b: CandidatoParaComparar, config?: CompareConfig): ResultadoComparacao {
    const ignoredCoverageShiftAxes: Eixo[] = [];

    // 1. Violações — sempre vazio nesta fase (ver Fase A), mas o critério já existe pra a Fase E
    // não precisar mexer no comparador de novo.
    const hvA = a.evaluation.balance.hardViolations.length;
    const hvB = b.evaluation.balance.hardViolations.length;
    if (hvA !== hvB) return { vencedor: hvA < hvB ? 'a' : 'b', decidiuPor: 'hardViolations', ignoredCoverageShiftAxes };

    // 2. Balanceamento — nenhum candidato pode piorar o desvio total do setor (base ESTÁVEL,
    // ver stableSetores/totalSectorDeviation em PortfolioEvaluatorService). Piso de MATERIALIDADE
    // (não épsilon técnico) — uma diferença menor que isso é ruído de arredondamento/tamanho de
    // lote, não uma melhoria estrutural real (ver Cenário 5B da bateria de depth=3).
    const limiarBalance = config?.balanceMaterialityThresholdPp ?? DEFAULT_BALANCE_MATERIALITY_THRESHOLD_PP;
    const devA = a.evaluation.balance.totalSectorDeviation;
    const devB = b.evaluation.balance.totalSectorDeviation;
    if (Math.abs(devA - devB) > limiarBalance) return { vencedor: devA < devB ? 'a' : 'b', decidiuPor: 'balance', ignoredCoverageShiftAxes };

    // 3. Concentração de segmento (Fase C.1) — pior problema de composição interna da carteira
    // sob cada candidato; menor vence. Só depois de excesso/desvio de setor corrigidos (passo 2),
    // antes de otimizar Qualidade/Risco/Preço — corrigir composição estrutural primeiro.
    const concA = a.evaluation.balance.worstSegmentConcentration;
    const concB = b.evaluation.balance.worstSegmentConcentration;
    if (Math.abs(concA - concB) > 1e-6) return { vencedor: concA < concB ? 'a' : 'b', decidiuPor: 'segmentConcentration', ignoredCoverageShiftAxes };

    // 4. Guarda de round-trip — logo depois dos critérios ESTRUTURAIS (violações, balance dentro
    // do piso de materialidade, concentração de segmento), ANTES dos critérios finos de
    // Qualidade/Risco/Preço (passos 5-6 abaixo). Colocar essa guarda DEPOIS dos critérios finos
    // (perto do turnover) não funciona na prática — achado real ao validar o Cenário 5B: os
    // valores de Q/R/P de duas linhas quase idênticas (uma delas um round-trip) raramente empatam
    // exatamente (`1e-9`) por causa de ruído de arredondamento de lote/preço médio, então o
    // round-trip já vencia no passo de déficit fino ANTES de qualquer guarda mais tardia ter
    // chance de agir. Aqui, logo após o "big picture" já resolvido/empatado por materialidade, a
    // guarda intercepta o round-trip antes que ruído fino de Q/R/P decida por ele.
    if (a.roundTripDetected !== b.roundTripDetected) {
      return { vencedor: a.roundTripDetected ? 'b' : 'a', decidiuPor: 'roundTripPenalty', ignoredCoverageShiftAxes };
    }

    // Déficit residual por eixo — assimétrico de propósito: só conta ficar ABAIXO do neutro
    // (1,5) como déficit; acima é bom, não soma déficit nenhum. Eixo sem cobertura (value=null)
    // conta 0 — nunca domina a decisão por falta de dado.
    const deficit = (axis: SearchHealthAxis): number => (axis.value == null ? 0 : Math.max(0, NEUTRO - axis.value));

    const eixosComparaveis = ORDEM_EIXO.filter((eixo) => {
      const axA = a.evaluation.health.search[eixo];
      const axB = b.evaluation.health.search[eixo];
      if (Math.abs(axA.coverage - axB.coverage) > LIMIAR_DIFERENCA_COVERAGE) {
        ignoredCoverageShiftAxes.push(eixo);
        return false;
      }
      return true;
    });

    const maxDeficitDe = (cand: CandidatoParaComparar) =>
      eixosComparaveis.reduce((max, eixo) => Math.max(max, deficit(cand.evaluation.health.search[eixo])), 0);
    const sumDeficitDe = (cand: CandidatoParaComparar) => eixosComparaveis.reduce((soma, eixo) => soma + deficit(cand.evaluation.health.search[eixo]), 0);

    // 5. Maior déficit residual — quem deixa a fraqueza mais severa remanescente perde.
    const maxDefA = maxDeficitDe(a);
    const maxDefB = maxDeficitDe(b);
    if (Math.abs(maxDefA - maxDefB) > 1e-9) return { vencedor: maxDefA < maxDefB ? 'a' : 'b', decidiuPor: 'maxDeficit', ignoredCoverageShiftAxes };

    // 6. Soma dos déficits residuais.
    const sumDefA = sumDeficitDe(a);
    const sumDefB = sumDeficitDe(b);
    if (Math.abs(sumDefA - sumDefB) > 1e-9) return { vencedor: sumDefA < sumDefB ? 'a' : 'b', decidiuPor: 'sumDeficit', ignoredCoverageShiftAxes };

    // 7. Dominância Pareto Qualidade/Risco/Preço — só como desempate final, quando os déficits
    // residuais empatarem exatamente (ex: ambos já com todos os eixos ≥ 1,5, sem déficit nenhum).
    let aMelhorEmAlgum = false;
    let aPiorEmAlgum = false;
    for (const eixo of eixosComparaveis) {
      const axA = a.evaluation.health.search[eixo];
      const axB = b.evaluation.health.search[eixo];
      if (axA.value == null || axB.value == null) continue;
      if (axA.value > axB.value) aMelhorEmAlgum = true;
      if (axA.value < axB.value) aPiorEmAlgum = true;
    }
    if (aMelhorEmAlgum && !aPiorEmAlgum) return { vencedor: 'a', decidiuPor: 'dominance', ignoredCoverageShiftAxes };
    if (aPiorEmAlgum && !aMelhorEmAlgum) return { vencedor: 'b', decidiuPor: 'dominance', ignoredCoverageShiftAxes };

    // 8. RankingConfidence / Score Final do ticker resultante.
    if (a.confidence !== b.confidence) return { vencedor: a.confidence === 'HIGH' ? 'a' : 'b', decidiuPor: 'confidence', ignoredCoverageShiftAxes };
    if (a.scoreFinalResultante != null && b.scoreFinalResultante != null && Math.abs(a.scoreFinalResultante - b.scoreFinalResultante) > 1e-9) {
      return { vencedor: a.scoreFinalResultante > b.scoreFinalResultante ? 'a' : 'b', decidiuPor: 'confidence', ignoredCoverageShiftAxes };
    }

    // 9. Turnover — menor valor movimentado vence.
    if (Math.abs(a.amount - b.amount) > 1e-6) return { vencedor: a.amount < b.amount ? 'a' : 'b', decidiuPor: 'turnover', ignoredCoverageShiftAxes };

    return { vencedor: 'tie', decidiuPor: 'tie', ignoredCoverageShiftAxes };
  }
}
