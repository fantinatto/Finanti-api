# Finanti API

Backend do Finanti — ferramenta de controle e análise de carteira de investimentos para o mercado brasileiro (B3), com foco em rebalanceamento analítico e pontuação de ações por ciclo de mercado.

Posicionamento importante: o produto é uma **ferramenta de apoio à decisão**, não uma recomendação de investimento — os scores e rankings gerados não constituem análise de valores mobiliários (evita enquadramento em credenciamento CVM).

## Stack

- **Framework:** NestJS
- **ORM:** Prisma
- **Banco:** Supabase (PostgreSQL)
- **Deploy:** Vercel
- **APIs externas:** bolsai (fundamentos, primária) + brapi.dev (cotação/histórico, complementar)

## Módulos previstos

| Módulo | Responsabilidade |
|---|---|
| `auth` | Autenticação e autorização |
| `portfolio` | Passivos, ganhos e carteira de investimentos mensais do usuário |
| `rebalancing` | Cálculo de regras de alocação (regra dos 100, regra dos 80) por categoria de risco |
| `ranking` | Motor de scoring: normalização setorial/segmento, cálculo de score de Qualidade/Risco/Preço e persistência do histórico |
| `market-data` | Integração com APIs externas (bolsai/brapi) para indicadores de ações |

## Metodologia do Ranking (resumo)

1. **Ingestão:** busca indicadores fundamentalistas por ação via API externa (P/L, P/VP, ROE, ROIC, margens, DY, dívida líquida/patrimônio, CAGR de receita e lucro, etc.), já classificados por Setor > Subsetor > Segmento (B3).
2. **Médias por agrupamento:** cálculo da média de cada indicador por Segmento, Setor e Subsetor.
3. **Normalização:** cada indicador da ação dividido pela média do seu grupo (ex: `indicador_ação / média_segmento`), com limites (`MIN`/`MAX`) para conter outliers.
4. **Score ponderado:** combinação dos indicadores normalizados em três eixos — Qualidade, Risco e Preço — com pesos configuráveis, calculados separadamente por Setor e por Segmento e depois combinados em um Ranking Final.
5. **Persistência histórica:** cada execução mensal grava uma nova linha por ação/mês, permitindo análise de evolução do ranking ao longo do tempo.

## Schema de dados (visão inicial)

- `indicadores_mensais` — dados brutos por ação/mês
- `medias_agrupamento` — médias por segmento/setor/subsetor/mês
- `pesos_config` — pesos configuráveis por indicador/grupo
- `scores_normalizados` — indicadores normalizados por ação/mês
- `ranking_historico` — scores finais por ação/mês
- `passivos`, `ganhos`, `investimentos` — controle financeiro mensal do usuário

## Reaproveitamento

Este projeto reaproveita artefatos (módulos, guards, configuração) de um projeto NestJS existente. Itens candidatos a reuso serão documentados em `REUSE.md` conforme forem migrados.

## Como rodar

```bash
npm install
npx prisma generate
npm run start:dev
```

## Variáveis de ambiente

```
DATABASE_URL=
DIRECT_URL=
BOLSAI_API_KEY=
BRAPI_API_KEY=
```

---
*Documentação em construção — este README será atualizado conforme o projeto evolui.*
