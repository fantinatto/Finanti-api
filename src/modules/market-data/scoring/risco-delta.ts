import { IndicatorConfig, INDICATOR_CONFIG, ScoreGroup } from './indicator.config';
import { EstatisticaCampo, IndicadoresMap } from './average.calculator';
import { getPesosGrupo } from './setor-pesos.config';

/**
 * Coluna experimental/comparativa — roda em PARALELO ao score por razão/mediana (normalizer.ts),
 * sem substituir nada. Objetivo: comparar lado a lado se a curva sigmoide diferencia melhor
 * "impecável" de "aceitável" do que a trava rígida em NORM_CLAMP_MAX/MIN do modelo atual, e
 * se normalizar contra média/desvio do grupo suaviza distorções de ciclo setorial (ex:
 * commodities no topo/fundo do ciclo) melhor que a razão contra a mediana.
 *
 * Z = (média do grupo − valor da ação) / desvio-padrão do grupo pra campos lower_better
 * (menos é melhor — dívida, múltiplos de preço), invertido pra higher_better (ROE, DY, etc.,
 * onde mais é melhor). Mesma direção que INDICATOR_CONFIG já usa pra normalizarIndicador.
 */
const DELTA_K = 0.85;
const DELTA_TETO = 3.0;

function deltaIndicador(
  valor: number | null | undefined,
  stats: EstatisticaCampo | null,
  direction: IndicatorConfig['direction'],
): number | null {
  if (valor === null || valor === undefined || isNaN(valor) || !stats) return null;

  const z = direction === 'higher_better'
    ? (valor - stats.media) / stats.desvioPadrao
    : (stats.media - valor) / stats.desvioPadrao;
  const sigmoide = 1 / (1 + Math.exp(-DELTA_K * z));
  return DELTA_TETO * sigmoide;
}

/** Combina os campos de um eixo (qualidade/risco/preco) pelos mesmos pesos por setor/segmento
 * que o score por razão usa (getPesosGrupo) — a única diferença é o método de normalização por
 * campo (sigmoide contínua vs. razão com teto/piso), não a ponderação nem os campos usados. */
export function calcularScoreDeltaGrupo(
  grupo: ScoreGroup,
  indicadores: IndicadoresMap,
  estatisticas: Record<string, EstatisticaCampo | null>,
  setor: string | null,
  segmento: string | null,
): number | null {
  const pesos = getPesosGrupo(setor, segmento)[grupo];
  const relevantes = INDICATOR_CONFIG.filter((c) => c.scoreGroup === grupo);
  let pesoPonderado = 0;
  let pesoTotal = 0;

  for (const cfg of relevantes) {
    const peso = pesos[cfg.field] ?? 0;
    if (peso === 0) continue;

    const delta = deltaIndicador(
      indicadores[cfg.field] as number | null | undefined,
      estatisticas[cfg.field] ?? null,
      cfg.direction,
    );
    if (delta === null) continue;

    pesoPonderado += delta * peso;
    pesoTotal += peso;
  }

  return pesoTotal > 0 ? pesoPonderado / pesoTotal : null;
}

/** Atalho mantido pro eixo risco — mesmo comportamento de antes, só reescrito em cima de
 * calcularScoreDeltaGrupo pra não duplicar a lógica de ponderação. */
export function calcularRiscoDelta(
  indicadores: IndicadoresMap,
  estatisticas: Record<string, EstatisticaCampo | null>,
  setor: string | null,
  segmento: string | null,
): number | null {
  return calcularScoreDeltaGrupo('risco', indicadores, estatisticas, setor, segmento);
}
