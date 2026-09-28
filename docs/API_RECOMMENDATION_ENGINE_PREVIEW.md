# `API_RECOMMENDATION_ENGINE_PREVIEW.md`

> **Status (2026-09-27):** implementado e validado (script standalone + build do frontend). Rota
> só leitura, nenhuma mutação de carteira. Paralela ao motor legado — não substitui nada.

## 1. Contexto

O Portfolio Recommendation Search Engine (`recommendation-engine/`) evoluiu bastante (funding
corrigido, Move Sizing, Estouro Dinâmico, piso de materialidade + guarda de round-trip no
Comparator) mas só era validável via scripts standalone. A tela "Ranking das suas ações" continua
alimentada 100% pelo motor legado (`InvestimentoService.getRecomendacoes`). Esta rota expõe o
motor novo pra comparação lado a lado, sem tocar em nenhuma rota/lógica existente.

Ver `project_finanti.md` (memória do projeto) pra todo o histórico de como o motor chegou até
aqui (Fases A/B1/B2/C, C.1, D, Estouro Dinâmico, correção de funding, Move Sizing, Comparator).

## 2. Endpoint

```
GET /api/v1/portfolio/recommendation-engine/preview
```

- **Auth**: `Bearer <jwt>` obrigatório (`@UseGuards(JwtAuthGuard)`, igual a toda rota de
  `portfolio.controller.ts`). Sem token → `401 Unauthorized`.
- **Query params**:
  | Nome | Obrigatório | Valores | Descrição |
  |---|---|---|---|
  | `anoMes` | sim | `"YYYY-MM"` (ex: `"2026-09"`) | Competência do snapshot — mesmo formato usado em toda rota de `investimentos`/`simulacao`. **Não há validação de formato nesta rota** (não usa DTO/`ValidationPipe`) — enviar sempre um valor válido. |
  | `carteira` | não | `"real"` \| `"simulacao"` | Default `"real"` quando omitido. |

- **Prefixo global**: a API inteira roda sob `app.setGlobalPrefix('api/v1')` (`main.ts`) — a URL
  completa em dev é `http://localhost:3000/api/v1/portfolio/recommendation-engine/preview`. O app
  Angular já cuida disso sozinho (`environment.apiUrl` + `api.interceptor.ts` prefixam toda
  chamada relativa) — só importa lembrar do prefixo ao testar via `curl`/Postman direto.

### Exemplo de chamada

```bash
curl --url 'http://localhost:3000/api/v1/portfolio/recommendation-engine/preview?anoMes=2026-09&carteira=simulacao' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'Accept: application/json'
```

## 3. O que a rota faz (implementação)

`PortfolioController.previewRecommendationEngine` → `RecommendationEngineService.getPreview()`
(`recommendation-engine/recommendation-engine.service.ts`):

1. Monta o `PortfolioSnapshot` (`PortfolioSnapshotService.build`) — mesma fonte de dado que
   `getRecomendacoesB1`/`getEscolhasB2`.
2. Avalia o estado inicial (`PortfolioEvaluatorService.evaluate`).
3. Roda a busca (`PortfolioSearchEngineService.search`) **sempre com `maxDepth=3`** — fixo pra
   esta rota, independente do que estiver configurado como padrão em `DEFAULT_SEARCH_CONFIG`.
4. Reconstrói o "porquê" da linha vencedora (`PortfolioDecisionTraceService.build`).
5. Reaplica os moves da linha vencedora uma segunda vez (`PortfolioStateTransitionService.apply`)
   só pra extrair `saleNotional`/`purchaseNotional`/capital por passo — dado que o Decision Trace
   não guarda hoje. Isso NÃO executa nada de verdade — é uma simulação em memória, o
   `PortfolioState` retornado por `apply()` nunca é persistido.

Nenhuma escrita no banco acontece em nenhum ponto deste fluxo.

## 4. Formato da resposta

Tipo TypeScript real: `RecommendationPreviewResult`
(`recommendation-engine/domain/portfolio-preview.ts`). Envelope fino sobre tipos de domínio já
existentes (`PortfolioMove`, `PortfolioEvaluation`, `PortfolioCapitalState`,
`RejectedAlternative`, `DynamicAllocationBandResult`) — não há um DTO paralelo duplicando esses
modelos.

```jsonc
{
  "engineVersion": "search-engine-v1-depth3-preview",
  "generatedAt": "2026-09-27T14:40:09.532Z",
  "carteira": "real",
  "anoMes": "2026-09",

  "snapshot": {
    "portfolioValue": 45898,       // valorTotalCarteira (ações + FIIs + renda fixa)
    "investedValue": 45898,        // valorTotalAcoes (só a fatia de ações)
    "availableCapital": 0,         // availableToInvest(capital) no estado inicial
    "rankingVersion": "2026-09:hibrido:real"
  },

  "initialEvaluation": { /* PortfolioEvaluation completo — ver seção 4.1 */ },

  "bestPlan": {
    "steps": [ /* RecommendationPreviewStep[] — ver seção 4.2 */ ],
    "finalEvaluation": { /* PortfolioEvaluation completo, do estado final da linha vencedora */ },
    "turnover": 14936,
    "capitalResidual": { "existingCash": 0, "externalContributionBudget": 0, "proceedsGeneratedByPlan": 7182 }
  },

  "alternatives": [
    // RecommendationPreviewAlternative[] — fronteira de Pareto real dos terminais (Fase C),
    // já deduplicada; nada aqui é "dominado" por construção (sem campo `dominated`).
    { "moves": [ /* PortfolioMove[] */ ], "finalEvaluation": { /* ... */ }, "turnover": 14974 }
  ],

  "searchMetadata": {
    "depthReached": 3,
    "statesGenerated": 162,
    "statesEvaluated": 122,
    "statesPruned": 17,
    "transpositionHits": 40,
    "durationMs": 63
  },

  "config": {
    "maxDepth": 3,
    "beamWidth": 20,
    "maxMovesPerNode": 6,
    "rebalanceToleranceMode": "FIXED",       // ou "DYNAMIC_PRICE" — depende da config do usuário
    "balanceMaterialityThresholdPp": 0.1,
    "engineVersion": "search-engine-v1-depth3-preview",
    "rankingVersion": "2026-09:hibrido:real"
  }
}
```

### 4.1. `PortfolioEvaluation` (usado em `initialEvaluation`, `bestPlan.finalEvaluation`, por passo e por alternativa)

Campos relevantes pra UI (existem outros usados internamente pelo motor — ver
`domain/portfolio-evaluation.ts` pro tipo completo):

| Campo | Descrição |
|---|---|
| `health.search.quality/risk/price.value` | Δ médio ponderado do eixo (null = sem cobertura). |
| `health.search.quality/risk/price.coverage` | 0–1: fração da carteira com esse Δ calculado. |
| `health.lowCoverageWarnings` | Avisos textuais quando `coverage < 0.8`. |
| `balance.totalSectorDeviation` | Soma de \|percentualAtual − percentualAlvo\| de todos os setores — a métrica "desvio total" mostrada na UI. |
| `balance.sectorsOutsideBand` | Quantos setores estão fora da banda de tolerância. |
| `balance.worstSegmentConcentration` | Pior concentração de segmento dentro de um único setor (0–100%). |
| `balance.unallocatedCapital` | Capital disponível não alocado nesse estado. |

### 4.2. `RecommendationPreviewStep` (um item de `bestPlan.steps`)

| Campo | Descrição |
|---|---|
| `sequence` | Posição do passo na linha (1-indexed). |
| `move` | `PortfolioMove` completo — `type` (`BUY`\|`ADD_NEW_POSITION`\|`REDUCE`\|`SELL`\|`ROTATE_WITHIN_SECTOR`), `sourceTicker`/`targetTicker`, `setor`, `amount`, `quantity`, `sizingStrategy` (`REDUCE_TO_UPPER_BAND`\|`REDUCE_PARTIAL`\|`REDUCE_TO_TARGET`\|`FULL_EXIT` — só em REDUCE/SELL gerados pelo branch sobrealocado), `primaryReason`/`secondaryReasons`, `confidence` (`HIGH`\|`MEDIUM`). |
| `saleNotional` / `purchaseNotional` | Quanto esse passo especificamente vendeu/comprou (não confundir com `move.amount`, que em `ROTATE_WITHIN_SECTOR` cobre só um lado). |
| `capitalBefore` / `capitalAfter` | `PortfolioCapitalState` (`existingCash`, `externalContributionBudget`, `proceedsGeneratedByPlan`) antes/depois deste passo. |
| `evaluationBefore` / `evaluationAfter` | `PortfolioEvaluation` completo antes/depois deste passo específico. |
| `decidedBy` | Qual critério do Comparator decidiu esse passo frente ao rejeitado mais próximo — `hardViolations`\|`balance`\|`segmentConcentration`\|`roundTripPenalty`\|`maxDeficit`\|`sumDeficit`\|`dominance`\|`confidence`\|`turnover`\|`tie` (ordem lexicográfica real, ver `evaluation/portfolio-evaluation-comparator.service.ts`). |
| `rejectedAlternatives` | Lista de candidatos que perderam nesse passo, cada um com `move` + `decidedBy` (o critério que eliminou ELE especificamente frente ao vencedor). Pode ter dezenas de itens — é o principal fator no tamanho do payload (ver seção 6). |
| `bandaSetor` | Só presente quando `rebalanceToleranceMode='DYNAMIC_PRICE'` e o move tem setor associado — `DynamicAllocationBandResult` (banda dinâmica usada nesse setor nesse momento). |

## 5. Erros conhecidos

| Situação | Resultado |
|---|---|
| Sem header `Authorization` (ex: colar a URL direto no navegador) | `401 Unauthorized` |
| URL sem o prefixo `/api/v1` | `404 Not Found` — `{"message":"Cannot GET /portfolio/...","error":"Not Found","statusCode":404}` |
| `anoMes` omitido ou mal formatado | Não validado explicitamente por esta rota — comportamento depende de como `PortfolioSnapshotService.build` reage a um `anoMes` inesperado (não testado formalmente; enviar sempre `"YYYY-MM"` válido). |

## 6. Performance e tamanho do payload

Medido contra a carteira real do usuário (11 posições, 3 passos na linha vencedora):
`durationMs≈60`, `statesGenerated=162` — bem confortável. **Payload serializado ≈ 658KB** nesse
mesmo teste — a maior parte é `rejectedAlternatives` (cada passo carrega dezenas de candidatos
rejeitados, cada um com o `move` completo). Aceitável pra uma rota de preview/debug usada sob
demanda (não é chamada automática nem em loop); se algum dia isso virar gargalo real, o candidato
óbvio a cortar é o `evaluation` completo dentro de cada `RejectedAlternative` — mas isso pertence
ao domínio do Decision Trace (`domain/portfolio-explainability.ts`), não a esta rota.

## 7. Relação com o motor legado

| | Legado | Preview (esta rota) |
|---|---|---|
| Fonte | `InvestimentoService.getRecomendacoes` | `RecommendationEngineService.getPreview` |
| Rota | `GET /portfolio/(simulacao/)investimentos/recomendacoes` | `GET /portfolio/recommendation-engine/preview` |
| Unidade de saída | 1 sugestão por posição já possuída | 1 PLANO (sequência de movimentos) |
| Profundidade de busca | nenhuma (matriz de decisão, 1 regra por ação) | 3 movimentos (busca real, compara estados) |
| Substitui o outro? | Não — os dois continuam ativos, paralelos, propositalmente | |

Este endpoint **não altera, chama, nem é chamado por** `getRecomendacoes`/`generateB1`/nenhuma
rota legada.
