import {
  IndicatorConfig,
  INDICATOR_CONFIG,
  NORM_CLAMP_MAX,
  NORM_CLAMP_MIN,
  SCORE_WEIGHTS,
  ScoreGroup,
} from './indicator.config';
import { getPesosGrupo } from './setor-pesos.config';
import { EstatisticaCampo, IndicadoresMap } from './average.calculator';
import { calcularScoreDeltaGrupo } from './risco-delta';
import { calcularFatorLiquidez } from './liquidez';

export function normalizarIndicador(
  valor: number | null | undefined,
  media: number | null | undefined,
  config: IndicatorConfig,
): number | null {
  if (valor === null || valor === undefined || isNaN(valor as number)) return null;
  if (media === null || media === undefined || media === 0) return null;

  const v = valor as number;

  if (v < 0) {
    if (config.negativeIsGood) return NORM_CLAMP_MAX;
    if (config.penalizeNonPositive) return NORM_CLAMP_MIN;
    if (config.excludeNegativeFromAvg) return null;
  }

  let norm: number;

  if (config.direction === 'higher_better') {
    norm = v / (media as number);
  } else {
    if (v <= 0) return config.penalizeNonPositive ? NORM_CLAMP_MIN : NORM_CLAMP_MAX;
    norm = (media as number) / v;
  }

  return Math.min(NORM_CLAMP_MAX, Math.max(NORM_CLAMP_MIN, norm));
}

export function normalizarAcao(
  indicadores: IndicadoresMap,
  medias: IndicadoresMap,
): IndicadoresMap {
  const norms: IndicadoresMap = {};

  for (const cfg of INDICATOR_CONFIG) {
    norms[`${cfg.field}_norm`] = normalizarIndicador(
      indicadores[cfg.field] as number | null,
      medias[cfg.field] as number | null,
      cfg,
    );
  }

  return norms;
}

/**
 * Caixa líquido (dívida líquida negativa) só é sinal de baixo risco de fato quando a empresa
 * também converte capital em retorno pelo menos na média do setor (roic_norm >= 1.0). Sem
 * isso, pode ser capital ocioso mal alocado (comum em Varejo/Construção Civil estagnados) —
 * então em vez do teto (3.0), esses campos recebem uma nota neutra-positiva.
 */
const CAIXA_LIQUIDO_SEM_RETORNO_NORM = 1.5;
const CAMPOS_DIVIDA_LIQUIDA = ['dividaLiquidaPatrimonio', 'dividaLiquidaEbitda'] as const;

/**
 * P/L e P/VP extremamente baixos (não apenas <= 0) costumam ser value traps: evento não
 * recorrente (venda de ativo, reversão de provisão) ou deterioração iminente do negócio,
 * não "pechincha" real. Sem essa trava, o teto (3.0) premia a distorção com nota máxima de
 * preço. Só rebaixa quando o 3.0 veio do valor extremo (norm == teto), e só quando não há
 * sinal de Qualidade/Risco saudável sustentando o múltiplo baixo — nesse caso é pechincha
 * genuína e mantém a nota alta.
 */
const PL_MIN_SAUDAVEL = 2.0;
const PVP_MIN_SAUDAVEL = 0.3;
const VALUE_TRAP_NORM = 1.0;
const VALUE_TRAP_NORM_RISCO_OK = 1.5;
const QUALIDADE_SAUDAVEL_MIN = 1.0;
const RISCO_SAUDAVEL_MIN = 2.0;

/**
 * Se os dois campos de dívida vierem nulos pra uma ação (não divulga endividamento —
 * comum em empresas em recuperação judicial ou com dado corrompido/ausente na fonte),
 * scoreRisco vira null e a etapa final redistribui o peso do eixo entre Qualidade e Preço.
 * Isso PREMIA a falta de transparência: o modelo simplesmente ignora a alavancagem em vez
 * de tratá-la como desconhecida/arriscada. Em vez de null, aplica uma nota de penalização.
 */
const RISCO_SEM_DADOS_NORM = 0.3;

/**
 * Risco Composto = mistura Risco Estático (mediana/razão, com teto/piso rígido) com
 * riscoDelta (Z-score + sigmoide, curva contínua) — mesmo mês, mesma métrica bruta, só
 * método de normalização diferente. NÃO é sinal temporal/tendência (não temos histórico
 * de dívida entre meses pra isso); é só suavização do efeito de teto no Score Final.
 * scoreRisco e riscoDelta continuam expostos sem alteração pra diagnóstico separado.
 */
const RISCO_COMPOSTO_PESO_ESTATICO = 0.6;
const RISCO_COMPOSTO_PESO_DELTA = 0.4;

export function calcularScores(
  normsMap: IndicadoresMap,
  indicadores?: IndicadoresMap,
  setor?: string | null,
  segmento?: string | null,
  estatisticasGrupo?: Record<string, EstatisticaCampo | null>,
  liquidezMediaDiaria?: number | null,
): {
  scoreQualidade: number | null;
  scoreRisco: number | null;
  riscoDelta: number | null;
  riscoComposto: number | null;
  scorePreco: number | null;
  scoreFinal: number | null;
  qualidadeDelta: number | null;
  precoDelta: number | null;
  scoreFinalDelta: number | null;
} {
  const pesosGrupo = getPesosGrupo(setor ?? null, segmento ?? null);
  const normsAjustados: IndicadoresMap = { ...normsMap };

  const roicNorm = normsMap['roic_norm'] as number | null | undefined;
  const roicSaudavel = roicNorm != null && roicNorm >= 1.0;

  if (!roicSaudavel) {
    for (const campo of CAMPOS_DIVIDA_LIQUIDA) {
      const valorBruto = indicadores?.[campo] as number | null | undefined;
      const normAtual = normsMap[`${campo}_norm`] as number | null | undefined;
      // só rebaixa quando o 3.0 veio do bônus de "caixa líquido" (valor < 0), não de um
      // endividamento baixo positivo que também poderia bater no teto por outro motivo.
      if (valorBruto != null && valorBruto < 0 && normAtual === NORM_CLAMP_MAX) {
        normsAjustados[`${campo}_norm`] = CAIXA_LIQUIDO_SEM_RETORNO_NORM;
      }
    }
  }

  const roeNorm = normsMap['roe_norm'] as number | null | undefined;
  const qualidadeSaudavel =
    (roicNorm != null && roicNorm >= QUALIDADE_SAUDAVEL_MIN) ||
    (roeNorm != null && roeNorm >= QUALIDADE_SAUDAVEL_MIN);

  const plValor = indicadores?.pl as number | null | undefined;
  const plNormAtual = normsMap['pl_norm'] as number | null | undefined;
  if (plValor != null && plValor > 0 && plValor < PL_MIN_SAUDAVEL && plNormAtual === NORM_CLAMP_MAX) {
    normsAjustados['pl_norm'] = qualidadeSaudavel ? NORM_CLAMP_MAX : VALUE_TRAP_NORM;
  }

  const calcGrupo = (grupo: ScoreGroup): number | null => {
    const relevantes = INDICATOR_CONFIG.filter((c) => c.scoreGroup === grupo);
    const pesos = pesosGrupo[grupo];
    let pesoPonderado = 0;
    let pesoTotal = 0;

    for (const cfg of relevantes) {
      const peso = pesos[cfg.field] ?? 0;
      if (peso === 0) continue; // setor não usa esse indicador nesse eixo (ex: ROIC pra bancos)
      const norm = normsAjustados[`${cfg.field}_norm`] as number | null | undefined;
      if (norm === null || norm === undefined) continue;
      pesoPonderado += norm * peso;
      pesoTotal += peso;
    }

    return pesoTotal > 0 ? pesoPonderado / pesoTotal : null;
  };

  const scoreQualidade = calcGrupo('qualidade');
  let scoreRisco = calcGrupo('risco');

  // Nenhum indicador de dívida disponível pra essa ação = falta de transparência sobre
  // alavancagem, não "risco neutro". Sem isso, uma empresa em recuperação judicial que não
  // divulga dívida pontuava melhor que uma com endividamento saudável mas divulgado.
  if (scoreRisco === null) {
    scoreRisco = RISCO_SEM_DADOS_NORM;
  }

  const pvpValor = indicadores?.pvp as number | null | undefined;
  const pvpNormAtual = normsMap['pvp_norm'] as number | null | undefined;
  if (pvpValor != null && pvpValor > 0 && pvpValor < PVP_MIN_SAUDAVEL && pvpNormAtual === NORM_CLAMP_MAX) {
    const riscoSaudavel = scoreRisco != null && scoreRisco >= RISCO_SAUDAVEL_MIN;
    normsAjustados['pvp_norm'] = riscoSaudavel ? VALUE_TRAP_NORM_RISCO_OK : VALUE_TRAP_NORM;
  }

  const scorePreco = calcGrupo('preco');

  // P/VP negativo = patrimônio líquido negativo (tecnicamente insolvente) — é um sinal de
  // risco mais grave do que qualquer combinação de dívida líquida/EBITDA saudável poderia
  // compensar, então achata o score de Risco pro piso em vez de só entrar na média ponderada.
  if (pvpValor != null && pvpValor < 0) {
    scoreRisco = scoreRisco !== null ? Math.min(scoreRisco, NORM_CLAMP_MIN) : NORM_CLAMP_MIN;
  }

  // riscoDelta calculado depois do scoreRisco final (já com piso de insolvência aplicado),
  // pra Risco Composto herdar esse piso também — insolvência não pode ser diluída pela
  // curva contínua do delta.
  let riscoDelta = estatisticasGrupo
    ? calcularScoreDeltaGrupo('risco', indicadores ?? {}, estatisticasGrupo, setor ?? null, segmento ?? null)
    : null;

  // Mesmo piso de insolvência de cima (linha ~188), mas pro riscoDelta: os indicadores do eixo
  // risco (dívida líquida/patrimônio, dívida líquida/EBITDA) fazem a mesma divisão por PL —
  // com PL negativo, o Z-score lê a razão invertida como "endividamento ótimo" (ex.: DTCY4
  // bateu riscoDelta ~2.4-2.9, perto do teto). scoreRisco não sofre isso porque tem trava
  // própria por campo (normalizarIndicador); o Z-score não tem, então sem isso scoreFinalDelta
  // (que usa riscoDelta puro, não riscoComposto) fica exposto à mesma distorção.
  if (pvpValor != null && pvpValor < 0) {
    riscoDelta = riscoDelta !== null ? Math.min(riscoDelta, NORM_CLAMP_MIN) : NORM_CLAMP_MIN;
  }

  const riscoComposto =
    riscoDelta !== null
      ? (scoreRisco as number) * RISCO_COMPOSTO_PESO_ESTATICO + riscoDelta * RISCO_COMPOSTO_PESO_DELTA
      : scoreRisco;

  const qualidadeDelta = estatisticasGrupo
    ? calcularScoreDeltaGrupo('qualidade', indicadores ?? {}, estatisticasGrupo, setor ?? null, segmento ?? null)
    : null;
  const precoDelta = estatisticasGrupo
    ? calcularScoreDeltaGrupo('preco', indicadores ?? {}, estatisticasGrupo, setor ?? null, segmento ?? null)
    : null;

  let scoreFinal: number | null = null;
  const partes: { score: number; peso: number }[] = [];

  if (scoreQualidade !== null) partes.push({ score: scoreQualidade, peso: SCORE_WEIGHTS.qualidade });
  if (riscoComposto !== null) partes.push({ score: riscoComposto, peso: SCORE_WEIGHTS.risco });
  if (scorePreco !== null) partes.push({ score: scorePreco, peso: SCORE_WEIGHTS.preco });

  if (partes.length > 0) {
    const pesoTotal = partes.reduce((acc, p) => acc + p.peso, 0);
    scoreFinal = partes.reduce((acc, p) => acc + p.score * (p.peso / pesoTotal), 0);
  }

  // scoreFinalDelta é o par 100% Z-score do scoreFinal acima: mesmos SCORE_WEIGHTS, mas
  // riscoDelta puro (não riscoComposto) — pra comparar as duas metodologias de normalização
  // lado a lado sem misturar uma dentro da outra.
  let scoreFinalDelta: number | null = null;
  const partesDelta: { score: number; peso: number }[] = [];

  if (qualidadeDelta !== null) partesDelta.push({ score: qualidadeDelta, peso: SCORE_WEIGHTS.qualidade });
  if (riscoDelta !== null) partesDelta.push({ score: riscoDelta, peso: SCORE_WEIGHTS.risco });
  if (precoDelta !== null) partesDelta.push({ score: precoDelta, peso: SCORE_WEIGHTS.preco });

  if (partesDelta.length > 0) {
    const pesoTotal = partesDelta.reduce((acc, p) => acc + p.peso, 0);
    scoreFinalDelta = partesDelta.reduce((acc, p) => acc + p.score * (p.peso / pesoTotal), 0);
  }

  // Penalização de liquidez — só no score final combinado, não nos sub-scores (Qualidade/
  // Risco/Preço são diagnóstico fundamentalista puro, ortogonal a quão fácil é negociar o
  // papel). Ver scoring/liquidez.ts — dado ausente nunca penaliza (fator 1.0).
  const fatorLiquidez = calcularFatorLiquidez(liquidezMediaDiaria);
  if (scoreFinal !== null) scoreFinal = Number((scoreFinal * fatorLiquidez).toFixed(4));
  if (scoreFinalDelta !== null) scoreFinalDelta = Number((scoreFinalDelta * fatorLiquidez).toFixed(4));

  return {
    scoreQualidade,
    scoreRisco,
    riscoDelta,
    riscoComposto,
    scorePreco,
    scoreFinal,
    qualidadeDelta,
    precoDelta,
    scoreFinalDelta,
  };
}
