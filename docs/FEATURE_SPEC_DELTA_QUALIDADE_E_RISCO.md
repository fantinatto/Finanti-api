# `FEATURE_SPEC_DELTA_QUALIDADE_E_RISCO.md`

> **Status:** backlog — depende de termos pelo menos 12 meses de histórico acumulado em
> `indicadores_mensais` pra cada ticker (janela YoY). Não implementar antes disso: com poucos
> meses de dado, a maioria das ações cairia no caso "sem histórico" (nota neutra 1.5000) e a
> feature não teria efeito prático nenhum.

## ⚠️ Notas de adequação ao codebase atual (ler antes de implementar)

A spec abaixo foi escrita em termos genéricos. Os pontos a seguir são onde ela precisa ser
adaptada à implementação real do Finanti-api:

- **`anoMes` é `String` no formato `"YYYY-MM"`** (ex: `"2026-08"`), não um inteiro `YYYYMM`.
  A aritmética `anoMes - 100` da spec não funciona direto — o cálculo do mês YoY precisa
  parsear a string, subtrair 12 meses de um `Date`, e reformatar de volta pra `"YYYY-MM"`.
  Ver `IngestionService.getAnoMes()` pro padrão de formatação já usado.
- **A tabela de destino é `scores_normalizados`** (model `ScoreNormalizado`), não
  `ranking_mensal` — essa última não existe no schema. As colunas novas descritas na seção 6
  devem ser adicionadas ali, seguindo o padrão de nomes já usado (camelCase: `deltaQualidadeBruto`,
  `qualidadeComposta`, etc.), não snake_case.
- **`riscoDelta`/`riscoComposto` já existem hoje**, mas são uma versão *não temporal*: usam
  Z-score/sigmoide sobre o **mesmo mês** (`scoring/risco-delta.ts`), não uma comparação YoY.
  Essa spec descreve a evolução desses campos pra uma versão temporal de verdade — ao
  implementar, decidir se `riscoDelta` é substituído (breaking change de significado) ou se o
  temporal ganha um nome novo (`riscoDeltaTemporal`?) e o atual continua existindo em paralelo.
- **Nomes de campo**: `margem_ebit` → `margemEbit`; `divida_liquida_ebitda` →
  `dividaLiquidaEbitda`; `roic` já bate direto. Ver `scoring/indicator.config.ts`.
- **Pesos por setor**: o Finanti já tem uma matriz de pesos por setor/segmento
  (`scoring/setor-pesos.config.ts`, cobre DEFAULT/Bancos/Utilidade Pública/Consumo
  Cíclico/Bens Industriais). Decidir se `w_ROIC`/`w_EBIT` do ΔQualidade reusam essa mesma
  matriz (consistência) ou são pesos fixos globais (mais simples) — a spec original não
  resolve isso explicitamente.
- **`α = 0.85`** é o mesmo `k` já usado em `RISCO_DELTA_K` (risco-delta.ts) — manter
  consistência ou justificar se for outro valor pro módulo de Qualidade.

---

## 🎯 Objetivo da Feature

Evoluir o modelo quantitativo de ranking de ações através da introdução do **Momentum Fundamentalista**:

1. **$\Delta\text{Qualidade}$ (Qualidade Delta):** Medir a tendência de ganho ou perda de eficiência operacional (ROIC, Margem EBIT, etc.) comparando a foto atual com os dados históricos mantidos na tabela `indicadores_mensais`.
2. **$\Delta\text{Risco}$ (Aprimoramento de Risco Delta):** Refinar o cálculo de evolução de endividamento (Dívida Líquida / EBITDA, Alavancagem) buscando histórico direto da tabela `indicadores_mensais`.
3. **Consolidação de Scores:** Gerar colunas compostas (`Qualidade Composta` e `Risco Composto`) mantendo a integridade da escala do modelo ($0.0000$ a $3.0000$).

---

## 🗄️ 1. Arquitetura da Fonte de Dados

Todas as consultas históricas deverão utilizar exclusivamente a tabela de snapshots do projeto:

* **Tabela Alvo:** `indicadores_mensais`
* **Chave Primária Composta:** `(ticker, anoMes)`
* **Formato do `anoMes`:** Inteiro no formato `YYYYMM` (ex: `202608` para Agosto/2026).
* **Janela do Delta (YoY - Year over Year):**

$$\text{anoMes\_historico} = \text{anoMes\_atual} - 100$$

*(Exemplo: Para o cálculo em `202608`, busca-se o registro exatamente em `202508`).*

> **Nota Teórica:** A janela YoY (12 meses) é obrigatória para neutralizar os efeitos de sazonalidade nos balanços trimestrais (ex: varejo no 4ºT ou agro no 1ºT/2ºT).

---

## 📐 2. Formulação Matemática Detalhada

### 2.1. Módulo $\Delta\text{Qualidade}$

#### A. Variação Bruta de Eficiência ($\Delta Q_{\text{bruto}}$)

Calcula-se a variação dos pilares de qualidade entre o período atual ($t$) e 12 meses atrás ($t-12M$):

$$\Delta \text{ROIC}_i = \text{ROIC}_{i, t} - \text{ROIC}_{i, t-12M}$$

$$\Delta \text{MargemEBIT}_i = \text{MargemEBIT}_{i, t} - \text{MargemEBIT}_{i, t-12M}$$

$$\Delta Q_{\text{bruto}, i} = (w_{\text{ROIC}} \cdot \Delta \text{ROIC}_i) + (w_{\text{EBIT}} \cdot \Delta \text{MargemEBIT}_i)$$

#### B. Normalização Z-Score + Sigmoide

$$Z_{\Delta Q, i} = \frac{\Delta Q_{\text{bruto}, i} - \mu_{\Delta Q}}{\sigma_{\Delta Q}}$$

$$\Delta\text{Qualidade}_i = \frac{3.0000}{1 + e^{-\alpha_Q \cdot Z_{\Delta Q, i}}}$$

*(Parâmetro recomendado: $\alpha_Q = 0.85$. Expoente negativo garante que variações positivas aumentem a nota).*

#### C. Qualidade Composta

$$\text{Qualidade Composta}_i = (0.65 \times \text{Qualidade Estática}_i) + (0.35 \times \Delta\text{Qualidade}_i)$$

---

### 2.2. Módulo $\Delta\text{Risco}$ (Aprimorado)

#### A. Variação Bruta de Endividamento ($\Delta R_{\text{bruto}}$)

Busca-se os indicadores de alavancagem histórica na `indicadores_mensais`:

$$\Delta \text{Alavancagem}_i = \text{DivLiquidaEBITDA}_{i, t} - \text{DivLiquidaEBITDA}_{i, t-12M}$$

#### B. Normalização Z-Score + Sigmoide Invertida

$$Z_{\Delta R, i} = \frac{\Delta \text{Alavancagem}_i - \mu_{\Delta R}}{\sigma_{\Delta R}}$$

$$\Delta\text{Risco}_i = \frac{3.0000}{1 + e^{\alpha_R \cdot Z_{\Delta R, i}}}$$

*(Parâmetro recomendado: $\alpha_R = 0.85$. Expoente positivo inverte o sinal: **redução de dívida gera pontuação alta**).*

#### C. Risco Composto

$$\text{Risco Composto}_i = (0.60 \times \text{Risco Estático}_i) + (0.40 \times \Delta\text{Risco}_i)$$

---

## 🛠️ 3. Pipeline de Implementação (Passo a Passo)

```
[Início]
   │
   ├── 1. Ingestão dos Indicadores do Mês Atual (t)
   │
   ├── 2. Query SQL em `indicadores_mensais` para carregar Registro (t - 100)
   │
   ├── 3. Tratamento de Borda / Edge Cases (IPOs, Dados Faltantes)
   │
   ├── 4. Cálculo dos Deltas Brutos (Qualidade & Risco)
   │
   ├── 5. Aplicação do Z-Score Vetorial (Cross-Sectional por Universo de Ações)
   │
   ├── 6. Mapeamento via Sigmoide (Escala 0.0000 a 3.0000)
   │
   ├── 7. Ponderação dos Scores Compostos (Qualidade Composta e Risco Composto)
   │
   └── 8. Atualização/Persistência dos Resultados na Tabela de Ranking
```

---

## 🔍 4. Estrutura de Queries SQL Esperada

Exemplo de *Self-Join* eficiente para extração temporal no pipeline Python/Pandas ou diretamente no Banco de Dados:

```sql
SELECT
    atual.ticker,
    atual.anoMes AS anoMes_atual,

    -- Indicadores de Qualidade
    atual.roic AS roic_atual,
    anterior.roic AS roic_12m,
    atual.margem_ebit AS margem_ebit_atual,
    anterior.margem_ebit AS margem_ebit_12m,

    -- Indicadores de Risco / Dívida
    atual.divida_liquida_ebitda AS alavancagem_atual,
    anterior.divida_liquida_ebitda AS alavancagem_12m

FROM indicadores_mensais atual
LEFT JOIN indicadores_mensais anterior
    ON atual.ticker = anterior.ticker
   AND anterior.anoMes = (atual.anoMes - 100) -- Exemplo: 202608 -> 202508
WHERE atual.anoMes = :anoMes_execucao;
```

> Ver nota de adequação no topo — no schema atual `anoMes` é string `"YYYY-MM"`, então esse
> self-join precisa comparar contra a string do mês calculado em código (Date - 12 meses),
> não subtração aritmética direta na coluna.

---

## ⚠️ 5. Tratamento de Exceções e Regras de Negócio (Edge Cases)

| Cenário de Erro / Borda | Causa do Problema | Ação / Comportamento Esperado do Sistema |
| --- | --- | --- |
| **Ação Recém-Listada (IPO)** | Não possui registro em `anoMes - 100`. | Atribuir $Z = 0$, resultando em nota neutra na Sigmoide ($\Delta\text{Qualidade} = 1.5000$ e $\Delta\text{Risco} = 1.5000$). |
| **EBITDA Negativo ou Zero** | Distorção matemática no indicador $\text{Dívida Líquida} / \text{EBITDA}$. | Aplicar *cap/floor* no delta ou desconsiderar a ação na média ($\mu$) do Z-Score para evitar contaminação do universo. |
| **Gaps de Dados em `anoMes - 100`** | Registro específico do mês anterior sumiu/falhou na carga. | Implementar *fallback* buscando a janela `anoMes - 101` (11 meses atrás) ou `anoMes - 99` (13 meses atrás). |
| **Ações sem Negociação / Ilíquidas** | Sem dados atualizados no mês corrente. | Excluir do universo do Z-score do mês corrente. |

---

## 🗏 6. Alterações no Schema do Banco de Dados

Novas colunas a serem adicionadas na tabela de saída de ranking (ou na própria `indicadores_mensais`):

```sql
ALTER TABLE ranking_mensal ADD COLUMN delta_qualidade_bruto DECIMAL(10, 4);
ALTER TABLE ranking_mensal ADD COLUMN delta_qualidade_score DECIMAL(5, 4);
ALTER TABLE ranking_mensal ADD COLUMN qualidade_composta DECIMAL(5, 4);

ALTER TABLE ranking_mensal ADD COLUMN delta_risco_bruto DECIMAL(10, 4);
ALTER TABLE ranking_mensal ADD COLUMN delta_risco_score DECIMAL(5, 4);
ALTER TABLE ranking_mensal ADD COLUMN risco_composto DECIMAL(5, 4);
```

> No Finanti isso vira uma migration Prisma aditiva em `ScoreNormalizado`
> (`scores_normalizados`), com nomes camelCase — ver nota de adequação no topo. Seguir o
> mesmo processo já estabelecido: `prisma migrate dev --create-only`, revisar o SQL gerado
> antes de aplicar.

---

## ✅ 7. Critérios de Aceite (Definition of Done - DoD)

1. [ ] **Cobertura SQL/Data:** Query de extração histórica funcional para 100% das ações ativas na base `indicadores_mensais`.
2. [ ] **Normalização Garantida:** Nenhuma nota de $\Delta\text{Qualidade}$ ou $\Delta\text{Risco}$ pode ficar fora do intervalo $[0.0000, 3.0000]$.
3. [ ] **Auditoria de Neutralidade:** Verificar se empresas sem histórico de 12 meses receberam nota exatamente $1.5000$ nos Deltas.
4. [ ] **Validação de Inversão de Sinal no Risco:** Confirmar se empresas que **reduziram** a Dívida Líquida / EBITDA ganharam pontuação de $\Delta\text{Risco}$ alta ($> 2.0000$).
5. [ ] **Validação do Momentum de Qualidade:** Confirmar se empresas que **expandiram ROIC e Margem** ganharam pontuação de $\Delta\text{Qualidade}$ alta ($> 2.0000$).
6. [ ] **Regressão de Ranking:** Validar que o Score Final continuará ponderado no teto $3.0000$ ao utilizar `Qualidade Composta` e `Risco Composto`.
