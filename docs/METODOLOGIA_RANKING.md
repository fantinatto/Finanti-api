# Documento Técnico: Metodologia do Ranking e Motor de Scoring (Finanti)

Este documento estabelece a especificação técnica de referência para o motor de quant/scoring do Finanti. Ele descreve o pipeline ponta a ponta implementado no módulo `src/modules/market-data/` — desde a ingestão até a persistência —, detalhando as salvaguardas financeiras e tratamentos de borda adotados para evitar armadilhas de valuation (*value traps*, distorções de não recorrentes e empresas sem liquidez/insolventes).

---

## Arquitetura e Mapeamento de Código

A orquestração do pipeline é dividida nos seguintes arquivos centrais:

* **Ingestão & Orquestração:** `services/ingestion.service.ts`
* **Filtros Mandatórios e Avançados:** `filtro-avancado.config.ts`
* **Cálculo da Régua de Grupo (Medianas):** `scoring/average.calculator.ts`
* **Catálogo de Indicadores e Pesos:** `scoring/indicator.config.ts`
* **Normalização & Salvaguardas:** `scoring/normalizer.ts`
* **Consultas do Ranking:** `services/ranking-query.service.ts`

---

## 1. Ingestão de Dados

A ingestão opera em modelo primário com *fallback* condicional para otimização de cotas de API:

```
┌────────────────────────────────┐
│   Status Invest (Primária)     │ ─── (Traz ~600+ tickers e fundamentos)
└───────────────┬────────────────┘
                │
                ▼
      ¿Todos campos válidos?
     (pl, pvp, lpa, vpa, roe, roa, pEbit)
                │
        ┌───────┴───────┐
       Sim             Não
        │               │
        │               ▼
        │   ┌─────────────────────────┐
        │   │    Bolsai (Fallback)    │ ─── (Completa apenas lacunas de cota free)
        │   └───────────┬─────────────┘
        │               │
        └───────┬───────┘
                │
                ▼
   Persistência em `indicadores_mensais`
   (Se incompleto: `dadosIncompletos = true`)

```

* **Fonte Primária (Status Invest):** Executa uma única requisição unificada (`statusinvest.service.ts`), recuperando ticker, setor, subsetor, segmento (classificação B3) e fundamentos.
* **Fonte Secundária (Bolsai):** Chamada via `bolsai.service.ts` apenas para tickers onde `isValida` retorne falso (faltando algum campo do *gate* mínimo). Preenche exclusivamente as lacunas sem sobrescrever dados da fonte primária.
* **Módulo do Usuário (Brapi):** A API `brapi.dev` não participa do cálculo de ranking — seu escopo é restrito a cotações em tempo real no módulo de carteira (`portfolio`).
* **Tratamento de Incompletude:** Tickers com dados pendentes pós-fallback são persistidos com `dadosIncompletos = true`. Eles não são descartados da base, mas são isolados dos cálculos de mediana e scoring do período até que os dados sejam normalizados.

---

## 2. Filtros de Pré-processamento

Para evitar contaminação da régua por empresas extintas, incorporadas ou sem liquidez operacional real, o pipeline aplica dois níveis de filtros:

### 2.1 Filtros Incondicionais (Gate Inicial)

Aplicados obrigatoriamente antes de qualquer cálculo estatístico:

1. **`price > 0`:** Remove papéis deslistados/incorporados com cotação zerada ou ausente. Impede que balanços "congelados" passados inflem o ranking via múltiplos defasados.
2. **`liquidezMediaDiaria >= R$ 500.000/dia`:** Remove "micos" de baixíssima liquidez, onde operações residuais de valor inexpressivo distorcem P/L e P/VP de forma irreal.

### 2.2 Filtros Opcionais de Coleta

Disponíveis na interface (`IngestionFiltroDto`) para recortes específicos: `soAcoes` (filtra ordinárias/preferenciais por regex `^[A-Z]{4}[3456]$`), `excluirFiis`, `excluirBdrs`, `setor`, `marketCapMin` e parâmetros da busca avançada (`FILTROS_AVANCADOS_CONFIG`).

---

## 3. Estrutura de Agrupamento

O Finanti opera em modelo de **Processamento Paralelo Independente (Dual-Track)**. Cada empresa é avaliada de forma isolada em duas réguas distintas:

$$\text{Tipo de Grupo} \in \{\text{'setor'}, \text{'segmento'}\}$$

Não há cascata ou ponderação combinada entre Setor e Segmento. Cada execução gera registros em paralelo em `scores_normalizados`, identificados pela chave composta `(ticker, tipoGrupo, nomeGrupo, anoMes)`.

```
                  ┌──────────────────────┐
                  │ Ticker Processado    │
                  └──────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [Trilha 1: SETOR]                 [Trilha 2: SEGMENTO]
   Normalização e Medianas           Normalização e Medianas
   do Setor da Empresa               do Segmento da Empresa
            │                                 │
            ▼                                 ▼
 Score Final (Setor)               Score Final (Segmento)

```

### Exceção Técnica: Setor Financeiro (Bancos)

Para o segmento `'Bancos'`, os indicadores `roic` e `dividaLiquidaEbitda` são anulados (`null`) na ingestão. Como o core business de um banco reside na captação e intermediação financeira, os conceitos de EBIT e Dívida Líquida são conceitualmente inaplicáveis. O motor de scoring redistribui automaticamente seus pesos entre os demais indicadores dos eixos de Qualidade e Risco.

---

## 4. Mediana do Grupo

A régua de comparação é calculada em `average.calculator.ts` (função `calcularMedias`) por grupo, por indicador e por período (`anoMes`).

* **Escolha da Mediana:** A mediana substitui a média aritmética para conferir imunidade estatística contra *outliers* extremos (ex.: empresas com P/L de $1.000$x ou ROE pontualmente distorcido).
* **Manutenção de Negativos na Mediana:** Múltiplos e indicadores de retorno negativos **não são excluídos** do cálculo da mediana do setor/segmento. A remoção de empresas no prejuízo elevaria a mediana do grupo de forma artificial, penalizando indevidamente empresas marginalmente lucrativas.

As medianas do período são persistidas na tabela `medias_agrupamento`.

---

## 5. Normalização por Indicador

A função `normalizarIndicador` converte os valores brutos de cada ação em uma nota normalizada $\text{norm} \in [\text{NORM\_CLAMP\_MIN}, \text{NORM\_CLAMP\_MAX}] = [0.1, 3.0]$.

### 5.1 Fórmulas Base

$$\text{higher\_better}: \quad \text{norm} = \frac{\text{Valor}}{\text{Mediana}_{\text{grupo}}}$$

$$\text{lower\_better}: \quad \text{norm} = \frac{\text{Mediana}_{\text{grupo}}}{\text{Valor}}$$

$$\text{norm}_{\text{final}} = \min(3.0, \, \max(0.1, \, \text{norm}))$$

### 5.2 Catálogo de Configurações (`indicator.config.ts`)

| Campo | Direção | Eixo | Peso | Regra Especial |
| --- | --- | --- | --- | --- |
| `roe` | `higher_better` | Qualidade | 3 | `penalizeNonPositive` |
| `roic` | `higher_better` | Qualidade | 3 | `penalizeNonPositive` |
| `margemBruta` | `higher_better` | Qualidade | 2 | — |
| `margemLiquida` | `higher_better` | Qualidade | 2 | — |
| `cagrReceita5a` | `higher_better` | Qualidade | 2 | — |
| `cagrLucro5a` | `higher_better` | Qualidade | 1 | — |
| `dividaLiquidaPatrimonio` | `lower_better` | Risco | 3 | `negativeIsGood` |
| `dividaLiquidaEbitda` | `lower_better` | Risco | 2 | `negativeIsGood` |
| `pl` | `lower_better` | Preço | 3 | `penalizeNonPositive` |
| `pvp` | `lower_better` | Preço | 3 | `penalizeNonPositive` |
| `dy` | `higher_better` | Preço | 2 | — |
| `pEbit` | `lower_better` | Preço | 1 | `penalizeNonPositive` |

* **`penalizeNonPositive`:** Atribui automaticamente o piso $\text{norm} = 0.1$ para valores $\le 0$ (prejuízo, PL negativo ou múltiplo zerado). Isso impede que uma empresa com prejuízo grave tenha seu campo anulado e acabe pontuando melhor em Qualidade do que uma empresa com lucro modesto.

---

## 6. Camada de Salvaguardas Pós-Normalização

Após a normalização base, a função `calcularScores` aplica cinco correções condicionais baseadas em sinais cruzados entre eixos:

```
                            [ Normalização Base ]
                                      │
       ┌──────────────────────────────┼──────────────────────────────┐
       ▼                              ▼                              ▼
 [ 6.1 Caixa Líquido ]       [ 6.2 / 6.3 Value Traps ]     [ 6.4 / 6.5 Riscos ]
 ROIC_norm < 1.0?            P/L < 2.0 ou P/VP < 0.3?      Sem dados ou P/VP < 0?
 Rebaixa 3.0 ➔ 1.5           Qualidade/Risco sustentam?    Penaliza Risco (0.3 / 0.1)
                             Sim: Mantém  |  Não: 1.0/1.5
       │                              │                              │
       └──────────────────────────────┼──────────────────────────────┘
                                      ▼
                        [ Agregação dos Eixos Final ]

```

### 6.1 Caixa Líquido sem Retorno

* **Gatilho:** Dívida líquida negativa ($\text{Valor} < 0$), que na regra base atinge o teto ($\text{norm} = 3.0$).
* **Condição:** Se $\text{ROIC}_{\text{norm}} < 1.0$ (empresa gera retorno sobre capital reinvestido abaixo da mediana do setor).
* **Ação:** Rebaixa o teto de $3.0$ para **$1.5$** (nota neutra-positiva). Previne que empresas estagnadas com capital parado em caixa sem destinação eficiente ganhem nota máxima de desalavancagem.

### 6.2 Trava de Value Trap para P/L

* **Gatilho:** Múltiplo positivo porem anomalamente baixo ($0 < \text{P/L} < 2.0$), resultando em $\text{norm} = 3.0$ na fórmula base.
* **Condição:** Se $\text{ROIC}_{\text{norm}} \ge 1.0$ ou $\text{ROE}_{\text{norm}} \ge 1.0$.
* **Ação:** Se a empresa demonstrar rentabilidade igual ou superior à mediana do setor, mantém $\text{norm} = 3.0$ (empresa genuinamente barata). Caso contrário, rebaixa para **$1.0$** (nota neutra pura), neutralizando o impacto de lucros não recorrentes pontuais.

### 6.3 Trava de Value Trap para P/VP

* **Gatilho:** $0 < \text{P/VP} < 0.3$ (desconto superior a 70% sobre o Patrimônio Líquido).
* **Condição:** Avaliação do eixo de risco prévio (`scoreRisco`).
* **Ação:** Se $\text{scoreRisco} \ge 2.0$, rebaixa para **$1.5$**; se $\text{scoreRisco} < 2.0$, rebaixa para **$1.0$**. Evita pontuação máxima para empresas em deterioração patrimonial severa ou com riscos de litígio iminentes.

### 6.4 Tratamento de Risco sem Dados

* **Gatilho:** Ausência total de dados de endividamento (`dividaLiquidaPatrimonio` e `dividaLiquidaEbitda` nulos) em empresas não pertencentes ao setor financeiro.
* **Ação:** Atribui diretamente $\text{scoreRisco} = 0.3$ (penalização severa), tratando a falta de transparência contábil ou omissão de dados de dívida como risco elevado.

### 6.5 Patrimônio Líquido Negativo (Insolvência Técnica)

* **Gatilho:** $\text{P/VP} < 0$.
* **Ação em `calcularScores`:** Achatamento imediato do eixo de risco: $\text{scoreRisco} = \min(\text{scoreRisco}, 0.1)$. Sobrepõe-se a qualquer indicador de curto prazo saudável.
* **Registro paralelo:** A mesma condição (`pvp < 0`) também é verificada, de forma independente, em `ingestion.service.ts` (`upsertAcao`), que grava a flag `passivoADescoberto = true` em `indicadores_mensais`. É um cálculo replicado no dado bruto para fins de exibição/filtro na UI, não um efeito colateral de `calcularScores` — as duas rotinas não compartilham estado.

---

## 7. Composição dos Scores por Eixo e Score Final

### 7.1 Score por Eixo

A função `calcGrupo(grupo)` calcula a média ponderada dos indicadores não nulos dentro de cada eixo:

$$\text{score}_{\text{eixo}} = \frac{\sum \left( \text{norm}_{i} \times \text{peso}_{i} \right)}{\sum \text{peso}_{i} \quad \text{para } \text{norm}_{i} \neq \text{null}}$$

### 7.2 Score Final

A consolidação final utiliza os seguintes pesos institucionais:

$$\text{SCORE\_WEIGHTS} = \{ \text{Qualidade}: 0.40, \, \text{Risco}: 0.30, \, \text{Preço}: 0.30 \}$$

$$\text{Score Final} = \frac{\sum \left( \text{score}_{\text{eixo}} \times \text{peso}_{\text{eixo}} \right)}{\sum \text{peso}_{\text{eixo}} \quad \text{para } \text{score}_{\text{eixo}} \neq \text{null}}$$

---

## 8. Persistência e Modelo de Dados

O resultado do pipeline é persistido em três tabelas principais no PostgreSQL:

1. **`indicadores_mensais`:** Registro bruto dos indicadores fundamentais por ticker e mês (`anoMes`), contendo as flags `dadosIncompletos` e `passivoADescoberto`.
2. **`medias_agrupamento`:** Armazena a mediana calculada para cada indicador por `tipoGrupo`, `nomeGrupo` e `anoMes`.
3. **`scores_normalizados`:** Armazena os valores normalizados ($\text{norm}$) de cada indicador, os scores parciais por eixo (`scoreQualidade`, `scoreRisco`, `scorePreco`) e o `scoreFinal`. A gravação é feita via operação de *upsert* na chave `(ticker, tipoGrupo, nomeGrupo, anoMes)`.

---

## 9. Leitura e Consultas

A recuperação dos dados para exibição é gerenciada pelo `RankingQueryService`. O model Prisma correspondente à tabela `scores_normalizados` é exposto no client como `scoreNormalizado` (singular):

```typescript
// Ordenação e exclusão de registros sem pontuação válida
const ranking = await prisma.scoreNormalizado.findMany({
  where: {
    tipoGrupo: filtro.tipoGrupo,
    anoMes: filtro.anoMes,
    scoreFinal: { not: null }
  },
  orderBy: {
    scoreFinal: 'desc'
  }
});

```

* **Tratamento de Ordenação Nula:** O filtro `scoreFinal: { not: null }` é obrigatório. Como o PostgreSQL ordena valores `NULL` no topo em consultas `DESC`, a ausência dessa instrução faria papéis sem score calculado figurarem indevidamente no topo da listagem.

---

## Divergências em Relação ao README.md

A implementação atual em código evoluiu e apresenta as seguintes divergências conceituais em relação à especificação inicial descrita no `README.md`:

---

> [!WARNING]
> ### Mapa de Inconsistências de Documentação
>
>
> 1. **Níveis de Agrupamento:** O `README.md` cita agrupamento em 3 níveis (Setor, Subsetor e Segmento). A implementação real processa apenas **2 réguas independentes** (Setor e Segmento). O atributo `subsetor` é armazenado na ingestão, mas não participa do cálculo de medianas e scores.
> 2. **Unificação de Rankings:** O `README.md` menciona a combinação das notas de Setor e Segmento em uma pontuação consolidada única. O código executa **dois rankings paralelos**, deixando a seleção da visão a cargo da interface gráfica.
> 3. **Gestão de Pesos:** O `README.md` refere-se a uma tabela de banco de dados `pesos_config`. A aplicação utiliza pesos estáticos parametrizados via arquivo de configuração (`indicator.config.ts`).
>
>
