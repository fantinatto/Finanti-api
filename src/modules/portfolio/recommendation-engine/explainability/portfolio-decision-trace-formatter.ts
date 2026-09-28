import { PortfolioEvaluation, SearchHealthAxis } from '../domain/portfolio-evaluation';
import { CandidateOutcome, DecisionTrace, EvaluationCriterion, RecommendationPlanStep } from '../domain/portfolio-explainability';
import { PortfolioMove } from '../domain/portfolio-move';

/** Frase do critério que decidiu uma comparação — mesmo vocabulário do comparador
 * (`PortfolioEvaluationComparatorService`), só traduzido pra linguagem natural. */
const FRASE_CRITERIO: Record<EvaluationCriterion, string> = {
  hardViolations: 'evita uma violação das regras da carteira',
  balance: 'reduz mais o desequilíbrio entre os setores da carteira',
  segmentConcentration: 'melhora a composição interna do setor (reduz a concentração num único segmento)',
  maxDeficit: 'deixa uma fraqueza menor no eixo (Qualidade/Risco/Preço) mais crítico',
  sumDeficit: 'deixa a carteira mais forte somando Qualidade, Risco e Preço',
  dominance: 'é melhor ou igual em Qualidade, Risco e Preço, sem perder em nenhum eixo',
  confidence: 'tem mais confiança no score ou um Score Final maior',
  roundTripPenalty: 'evita vender e recomprar o mesmo ticker sem necessidade',
  turnover: 'movimenta menos capital pra chegar num resultado equivalente',
  tie: 'empatou em todos os critérios',
};

function descreverAcao(move: PortfolioMove): string {
  switch (move.type) {
    case 'SELL':
      return `Vender ${move.sourceTicker}`;
    case 'REDUCE':
      return `Reduzir ${move.sourceTicker}`;
    case 'BUY':
      return `Reforçar ${move.targetTicker}`;
    case 'ADD_NEW_POSITION':
      return `Abrir posição em ${move.targetTicker}`;
    case 'ROTATE_WITHIN_SECTOR':
      return `Trocar ${move.sourceTicker} por ${move.targetTicker}`;
  }
}

function tickerDe(move: PortfolioMove): string {
  return move.targetTicker ?? move.sourceTicker ?? '?';
}

function distanciaEixo(a: SearchHealthAxis, b: SearchHealthAxis): number {
  if (a.value == null || b.value == null) return 0;
  return Math.abs(a.value - b.value);
}

/** "Quão perto" um rejeitado chegou de vencer, medido na MESMA grandeza que decidiu a
 * comparação — não decide nada (isso já foi feito pelo comparador), só ordena quem citar como
 * contendor mais próximo. Pra `confidence`/`turnover`/`tie` não há uma distância informativa (são
 * sempre o último desempate, já bem distantes dos critérios estruturais) — ficam por último. */
function distanciaPorCriterio(criterio: EvaluationCriterion, vencedor: PortfolioEvaluation, rejeitado: PortfolioEvaluation): number {
  switch (criterio) {
    case 'hardViolations':
      return Math.abs(vencedor.balance.hardViolations.length - rejeitado.balance.hardViolations.length);
    case 'balance':
      return Math.abs(vencedor.balance.totalSectorDeviation - rejeitado.balance.totalSectorDeviation);
    case 'segmentConcentration':
      return Math.abs(vencedor.balance.worstSegmentConcentration - rejeitado.balance.worstSegmentConcentration);
    case 'maxDeficit':
    case 'sumDeficit':
    case 'dominance':
      return (
        distanciaEixo(vencedor.health.search.quality, rejeitado.health.search.quality) +
        distanciaEixo(vencedor.health.search.risk, rejeitado.health.search.risk) +
        distanciaEixo(vencedor.health.search.price, rejeitado.health.search.price)
      );
    default:
      return Infinity;
  }
}

const MAX_TICKERS_POR_FRASE = 3;

interface CandidatoAvaliadoComCriterio extends CandidateOutcome {
  decidedBy: EvaluationCriterion;
  evaluation: PortfolioEvaluation;
}

/** Só candidatos que REALMENTE chegaram ao Comparator (`lifecycle==='EVALUATED'`) — nunca
 * `MOVE_ORDERING_CUT`/`DOMINATED`/`INVALID` (esses não têm um critério real que os eliminou, é
 * exatamente o achado que motivou separar o lifecycle). Ordena do MAIS perto de vencer pro mais
 * longe (menor distância primeiro) — quem chega no topo é o contendor real, não uma amostra
 * arbitrária da ordem de geração. */
function maisProximosDeVencer(step: RecommendationPlanStep): CandidatoAvaliadoComCriterio[] {
  const avaliados = step.candidateOutcomes.filter((o): o is CandidatoAvaliadoComCriterio => o.lifecycle === 'EVALUATED' && o.decidedBy != null && o.evaluation != null);
  return avaliados.sort((a, b) => distanciaPorCriterio(a.decidedBy, step.afterEvaluation, a.evaluation) - distanciaPorCriterio(b.decidedBy, step.afterEvaluation, b.evaluation));
}

function formatarPasso(step: RecommendationPlanStep): string {
  const linhas: string[] = [];
  linhas.push(`${step.sequence}. ${descreverAcao(step.move)} (R$ ${step.move.amount.toFixed(2)}) — ${FRASE_CRITERIO[step.decidedBy]}.`);

  const ordenados = maisProximosDeVencer(step);
  if (ordenados.length) {
    // Uma frase só por passo (não uma por grupo de critério) — cita os contendores mais PRÓXIMOS
    // de vencer, usando o critério do mais próximo deles como o motivo (o "quase-empate" real,
    // só entre quem de fato chegou a competir).
    const tickers = ordenados.slice(0, MAX_TICKERS_POR_FRASE).map((r) => tickerDe(r.move));
    const restantes = ordenados.length - tickers.length;
    const listaTickers = restantes > 0 ? `${tickers.join(', ')} (e outros ${restantes})` : tickers.join(', ');
    const motivo = FRASE_CRITERIO[ordenados[0].decidedBy];
    linhas.push(`   Por que não ${listaTickers}? Porque a escolha feita ${motivo}.`);
  }

  const cortados = step.candidateOutcomes.filter((o) => o.lifecycle === 'MOVE_ORDERING_CUT').length;
  if (cortados > 0) {
    linhas.push(`   ${cortados} candidato(s) não avaliado(s) — fora do orçamento de expansão (maxMovesPerNode), nunca chegaram a competir.`);
  }

  const banda = step.bandaSetor;
  if (banda?.fallbackReason === 'INSUFFICIENT_PRICE_DATA') {
    linhas.push(`   Banda de ${step.move.setor}: sem dado de Preço confiável esse mês — usou a tolerância fixa (±${banda.baseTolerance}pp).`);
  } else if (banda && banda.priceAttractiveness != null) {
    const direcao = banda.priceAttractiveness > 0.05 ? 'barato' : banda.priceAttractiveness < -0.05 ? 'caro' : 'neutro em preço';
    const guardrail = banda.guardrailApplied ? ' (Qualidade/Risco fracos limitaram a expansão)' : '';
    linhas.push(
      `   Banda de ${step.move.setor}: setor ${direcao}${guardrail} — tolerância ficou ${banda.min.toFixed(1)}%–${banda.max.toFixed(1)}% em vez da fixa ${(banda.target - banda.baseTolerance).toFixed(1)}%–${(banda.target + banda.baseTolerance).toFixed(1)}%.`,
    );
  }

  return linhas.join('\n');
}

/** Formata um `DecisionTrace` em texto — cada passo vira um parágrafo numerado com a ação, o
 * critério que decidiu, e UMA frase citando os contendores mais próximos de vencer (não uma linha
 * por alternativa rejeitada, nem uma frase repetida por grupo de critério). */
export function formatarDecisionTrace(trace: DecisionTrace): string {
  if (!trace.steps.length) return 'Nenhum movimento recomendado — a carteira já está no melhor estado encontrado (STOP).';
  return trace.steps.map(formatarPasso).join('\n\n');
}
