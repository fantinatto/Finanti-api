# Em andamento — 2026-08-17

## Contexto

Sessão sobre normalização de score (Materiais Básicos/CMIN3 puxando distorção de ciclo setorial).
Terminou em: generalizar o `riscoDelta` (Z-score + sigmoide) pra Qualidade e Preço também, criar
`scoreFinalDelta` pra comparar com o `scoreFinal` atual (razão/mediana), e expor tudo em `/ranking`.

## O que já foi feito (concluído, validado)

1. **Bug corrigido em `src/modules/market-data/services/ingestion.service.ts`** (linha ~164): a
   chamada `calcularScores(norms, acao.indicadores)` nunca passava `setor`/`segmento`/
   `estatisticasGrupo`. Duas consequências:
   - `getPesosGrupo` sempre caía no `DEFAULT` — os pesos de Bancos/Utilidade Pública/Consumo
     Cíclico/Bens Industriais (`scoring/setor-pesos.config.ts`) nunca eram aplicados.
   - `riscoDelta`/`riscoComposto` sempre `null` (o comentário do schema dizia que riscoComposto
     "é o que de fato entra no scoreFinal" — não era verdade).
   Corrigido: agora passa `acao.setor, acao.segmento, estatisticasGrupo` (mesmo fix aplicado em
   `scripts/importar-historico-excel.ts`).

2. **`qualidadeDelta`/`precoDelta`/`scoreFinalDelta`** — generalizado `scoring/risco-delta.ts`
   (agora exporta `calcularScoreDeltaGrupo(grupo, ...)`, reusado pros 3 eixos) e
   `scoring/normalizer.ts` (`calcularScores` retorna os 3 campos novos + `scoreFinalDelta` =
   combinação 100% Z-score, pra comparar com `scoreFinal` que é 100% razão/mediana).

3. **Migração Prisma aplicada** (`prisma/migrations/20260817115223_add_qualidade_preco_delta_scores`)
   — 3 colunas `Float?` aditivas em `ScoreNormalizado`. Prisma Client já regenerado.

4. **Recalculado histórico existente** (2026-04, 2026-06, 2026-08 — 1.418 linhas) com um script
   temporário (`scripts/_recalcular-scores.ts`, já **deletado** depois de rodar) que releu
   `IndicadorMensal` já persistido e reescreveu os scores sem precisar chamar a API de novo.
   Validado contra o portfólio real do usuário (BBAS3 final 0.76 → finalDelta 1.47, etc.) —
   achado à parte, não é bug: BBAS3/BBDC3 não têm `dividaLiquidaPatrimonio` na fonte Status
   Invest, então `riscoDelta` fica `null` pros dois (cai no piso 0.3 nos dois modelos).

5. **Exposto em `/ranking`**:
   - `ranking-query.service.ts` `getRanking()` — retorna `qualidadeDelta`, `precoDelta`,
     `scoreFinalDelta` além do que já existia.
   - `Finanti-app` `market-data.interfaces.ts` `RankingItem` — 3 campos novos.
   - `ranking.component.ts`/`.html` — 3 colunas novas (Score Final Δ, Qualidade Δ, Preço Δ) com
     badge tracejado (`.score-badge--delta`, já existia pro Risco Δ). Todas as colunas Δ
     (inclusive Risco Δ, que antes não era clicável) agora são ordenáveis — `th` com `(click)` +
     seta, e botão correspondente na barra "Ordenar por".
   - `ng build --configuration development` limpo nos dois repos em cada etapa.

## Problema aberto — NÃO resolvido

Usuário reportou 2x que `/ranking` "está escondendo as colunas" depois de Risco. Tentativa 1:
troquei `.ranking-table-wrap { overflow: hidden }` → `overflow-x: auto`
(`Finanti-app/src/app/components/pages/ranking/ranking.component.scss:213`) — usuário confirmou
que **ainda está escondendo** depois desse fix.

Investigação já feita (tudo negativo, não é a causa):
- Não há `overflow-x: hidden`/`overflow: hidden` em nenhum ancestral (`app.component.css` —
  `.app-main` sem overflow, `styles.css` global sem overflow-x, `default-login-layout` é só da
  tela de login, não do shell autenticado).
- `.ranking-layout` (max-width 1100px) não é flex/grid — não deveria estar clipando por
  min-width:0 de item flex.
- `.ranking-table { width: 100% }` está em layout `auto` (não `table-layout: fixed`), então em
  teoria a tabela deveria crescer além de 100% se o conteúdo pedir, e o wrap com
  `overflow-x: auto` deveria mostrar scroll.

**Não verificado ainda**: se o dev server (`ng serve`) estava rodando com hot-reload no momento
do teste do usuário, ou se ele testou uma build/servidor parado (o dev server tinha sido
derrubado nessa sessão pra liberar o lock do `prisma generate`, e não ficou claro se foi
reiniciado antes do usuário testar). Também não abri o DevTools/inspecionei o DOM renderizado de
fato — só analisei CSS estaticamente. Próximo passo ao retomar: confirmar que o `ng serve` está
rodando a versão atual do código (restart limpo) e, se persistir, inspecionar via DevTools
(computed width da `.ranking-table` vs `.ranking-table-wrap`, e se aparece scrollbar horizontal)
antes de tentar mais hipóteses de CSS.

## Arquivos tocados nesta sessão

**Finanti-api**: `scoring/risco-delta.ts`, `scoring/normalizer.ts`, `services/ingestion.service.ts`,
`services/ranking-query.service.ts`, `prisma/schema.prisma` + migration,
`scripts/importar-historico-excel.ts`, `rebalancing.config.ts`, `portfolio.controller.ts`,
`portfolio.module.ts`, `services/investimento.service.ts`, `.env` (pooler Supabase).

**Finanti-app**: `investimentos.component.{ts,html,scss}`, `resumo.component.{ts,html,scss}`,
`ranking.component.{ts,html,scss}`, `interfaces/market-data.interfaces.ts`,
`interfaces/portfolio.interfaces.ts`, `services/market-data.service.ts`.
