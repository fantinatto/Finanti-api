# `FEATURE_SPEC_FISCAL.md`

> **Status (2026-09-25):** MVP implementado e validado — registro manual de operações,
> apuração mensal de ganho/prejuízo por bucket fiscal, e **sincronização opt-in com a carteira
> REAL de Investimentos** (compra e venda — ver seção 3.2). **DARF, declaração anual,
> sincronização com Simulação, detecção automática de day trade, dividendos/JCP e eventos
> corporativos continuam fora do escopo** (backlog, seção 4).

## 1. Contexto

Usuário colou uma proposta externa extensa (gerada por outra IA) descrevendo um módulo fiscal
completo em 4 blocos: `TaxLedger` (livro de operações), `MonthlyTaxEngine` (apuração + DARF),
`TaxSimulator` (simular imposto de uma venda antes de executá-la) e `AnnualTaxReport`
(declaração de IR anual — posição 31/12, CNPJ, resumo mês a mês).

Antes de implementar, mapeei os gaps reais contra o codebase:
- A carteira **real** (`Investimento`) não tem nenhum histórico de transação — é só a posição
  consolidada atual. `InvestimentoService.vender()` decrementa/deleta sem deixar rastro.
- Não existe corretagem/emolumentos nem CNPJ/razão social armazenados em lugar nenhum.
- Diferente do motor de scoring (posicionado explicitamente como "apoio à decisão", não
  recomendação — ver `README.md`/`Why` do projeto), um erro aqui é **dinheiro declarado errado
  ao Fisco**, categoria de risco mais séria que merece mais cautela e conferência manual.

Perguntei ao usuário quanto escopo abrir de uma vez (MVP mínimo / simulador isolado / arquitetura
completa / adiar). Escolha: **"MVP mínimo primeiro"** — só registrar operações + apurar
ganho/prejuízo mensal por bucket, sem DARF nem declaração anual ainda.

## 2. Decisão de arquitetura: módulo desacoplado

O módulo `fiscal` (`src/modules/fiscal/`) é **totalmente independente** de
`Investimento`/`InvestimentoService`/`SimulacaoService`. Cada operação (compra/venda) é
cadastrada manualmente pelo usuário num livro próprio (`OperacaoFiscal`), não é populada
automaticamente pelas telas de Investimentos ou Simulação.

**Por quê**: o formulário "Adicionar" em `/investimentos` serve tanto pra registrar uma compra
de hoje quanto pra popular uma posição antiga que o usuário já possuía antes de usar o app — não
dá pra inferir "isso é uma operação fiscal de hoje, com esta data" a partir dele sem risco de
sujar o histórico fiscal com datas erradas. Cadastro manual duplica a digitação, mas evita
qualquer acoplamento novo com o motor de rebalanceamento já validado (que não tem noção nenhuma
de data de aquisição) e garante que só entra no livro fiscal o que o usuário confirma
explicitamente como uma operação real, na data real.

**Consequência importante pro usuário**: posições que já existiam em `/investimentos` antes de
começar a usar `/fiscal` **não aparecem automaticamente no livro fiscal**. Pra ter um custo
médio fiscal correto dali em diante, é preciso lançar manualmente as compras históricas dessas
posições (data e preço reais de aquisição) em `/fiscal`, não só as operações novas.

## 3. O que já foi implementado (validado)

### Backend
- **Prisma**: model `OperacaoFiscal` (migration `20260925202846_add_operacao_fiscal`,
  puramente aditiva) — `data`, `ticker`, `assetType` ('acao'|'fii'), `tipo` ('compra'|'venda'),
  `tradeType` ('swing'|'day_trade', default 'swing'), `quantidade`, `precoUnitario`, `custos`
  (corretagem/emolumentos, default 0).
- **`src/modules/fiscal/services/fiscal.service.ts`** (`FiscalService`):
  - CRUD: `listar(userId, ano?)`, `criar`, `atualizar`, `remover`.
  - `getApuracaoAnual(userId, ano)` — núcleo do cálculo, ver seção 3.1.
- **`src/modules/fiscal/fiscal.controller.ts`**: `GET/POST /fiscal/operacoes`,
  `PUT/DELETE /fiscal/operacoes/:id`, `GET /fiscal/apuracao?ano=`.
- **`src/modules/fiscal/fiscal.module.ts`**, registrado em `app.module.ts`.
- **`src/common/prisma/prisma.service.ts`**: getter `operacaoFiscal` adicionado (convenção do
  projeto — `PrismaService` expõe cada model via getter explícito, não delegação automática).

### 3.1. Como o cálculo funciona (`getApuracaoAnual`)

- **3 buckets fiscais**, mutuamente exclusivos por operação:
  - `comum` — ações em operações comuns (swing trade).
  - `day_trade` — qualquer ativo marcado manualmente como day trade (**sem detecção automática**
    de compra+venda no mesmo dia/ticker nesta versão — o usuário escolhe o `tradeType` no
    formulário).
  - `fii_fiagro` — FIIs/Fiagros (nunca têm isenção, independente do valor).
- **Custo médio por ticker**, recalculado deterministicamente a partir do próprio livro fiscal
  (NÃO usa `Investimento.precoMedio`) — a cada chamada de `getApuracaoAnual`, reprocessa **todo**
  o histórico de operações do usuário em ordem cronológica, acumulando quantidade e custo médio
  ponderado por ticker. Nenhum saldo (custo médio, prejuízo acumulado) fica persistido em
  tabela — isso evita dessincronização quando o usuário insere ou edita uma operação retroativa
  (o padrão já usado no projeto pra `ganhoRealizado`/`caixaDisponivel` da Simulação, ver
  `project_finanti.md`).
- **Prejuízo acumulado carrega mês a mês DENTRO do mesmo bucket**, nunca atravessa bucket
  (prejuízo de day trade não compensa ganho de operação comum, e vice-versa — regra real da
  Receita).
- **Isenção de R$20.000/mês só se aplica ao bucket `comum`** — nunca a day trade ou FII/Fiagro.
- Venda que excede a quantidade acumulada no livro até aquela data **não trava a apuração** —
  gera um item em `avisos[]` (sinal de compra faltando no histórico ou operação lançada fora de
  ordem) e segue o cálculo com a quantidade zerada naquele ponto, pra um lançamento errado não
  quebrar a tela inteira.
- **Não calcula valor de DARF nem aplica alíquota** (15%/20%) — só retorna resultado bruto,
  prejuízo compensado, resultado após compensação e a flag de isenção, por decisão de escopo
  explícita do usuário nesta rodada.

### 3.2. Sincronização com a carteira REAL (implementada 2026-09-25)

Resolve o item 1 do backlog original, mas só pro lado que dava pra resolver sem ambiguidade —
ver a decisão da seção 2. **Continua sem sincronização com Simulação** (não é dinheiro real, sem
implicação fiscal) e **edição de posição (`atualizar`) continua sem gerar operação fiscal**
(é uma correção da posição existente, não necessariamente uma transação nova).

- **Criar posição (`POST /portfolio/investimentos`)** — `UpsertInvestimentoDto` ganhou 3 campos
  opcionais: `registrarFiscal` (boolean), `dataOperacao` (ISO date, default hoje),
  `custosFiscais` (default 0). Quando `registrarFiscal=true` e o tipo não é `renda_fixa`, o
  controller chama `FiscalService.criar` logo após criar o `Investimento`, com `tipo: 'compra'`.
  **Sempre opt-in** (nunca automático sem essa flag) — "Adicionar" também serve pra cadastrar uma
  posição antiga já possuída, e logar isso como uma compra de hoje sujaria a apuração fiscal com
  uma data errada. Frontend: checkbox "Também registrar essa compra no Fiscal" (pré-marcado,
  default `true`) + campos de data/custos, visível só na criação (não na edição) de ação/FII.
- **Vender (`POST /portfolio/investimentos/:id/vender`)** — `VenderInvestimentoDto` ganhou
  `precoVenda` (opcional) e `custosFiscais` (opcional). Diferente da criação, uma venda **nunca é
  ambígua** (é sempre uma operação acontecendo agora) — se vier um `precoVenda`, o controller
  registra automaticamente uma `OperacaoFiscal` (`tipo: 'venda'`), sem precisar de checkbox.
  Frontend: o fluxo de venda (`window.prompt`) ganhou um segundo prompt pedindo o preço de venda,
  opcional — em branco, comportamento antigo (sem fiscal).
- `PortfolioModule` importa `FiscalModule` (que agora exporta `FiscalService`) pra o controller
  poder injetar os dois lados.
- Validado com script standalone: criar com `registrarFiscal=true` gerou a `OperacaoFiscal`
  esperada; criar sem a flag não gerou nenhuma; vender com `precoVenda` gerou a operação de
  venda correta e manteve a posição restante íntegra; vender sem `precoVenda` não gerou operação
  nova (comportamento antigo preservado).

### Frontend
- **`src/app/interfaces/fiscal.interfaces.ts`**, **`src/app/services/fiscal.service.ts`**
  (Angular) — espelham o contrato do backend.
- **`src/app/components/pages/fiscal/`** (`FiscalModule`, lazy-loaded em `/fiscal`):
  formulário de registro/edição de operação, tabela de operações do ano selecionado, um card por
  bucket com a apuração mensal (12 meses, badge "Isento"), lista de avisos.
  Aviso fixo no topo da página: "não calcula DARF nem gera declaração de IR — confira sempre
  contra a apuração oficial (ReVar) antes de decidir algo com dinheiro real."
- Link adicionado nas 3 posições de navegação (`app.component.html`: nav desktop, dropdown do
  user-menu, mobile drawer).

### Validação
Rodado contra o banco real via script standalone (`NestFactory.createApplicationContext`, nunca
porta 3000 — ver `TROUBLESHOOTING.md`), operações criadas e removidas ao final:
- Compra 100@20 + 100@22 (custo médio 21) + venda 100@25 → ganho 400, isento (vendas R$2.500 <
  R$20.000).
- Venda de 150 unidades com só 100 disponíveis no livro → gerou aviso, apurou o resultado mesmo
  assim (não travou).
- Prejuízo de -R$500 num mês compensou integralmente um ganho de +R$1.000 no mês seguinte
  (resultado após compensação = R$500, prejuízo acumulado final = R$0) — todos os números batendo
  exatamente com o cálculo manual esperado.

## 4. Backlog — não implementado ainda (ordem sugerida)

1. ~~Sincronização automática com Investimentos~~ — **implementado 2026-09-25** (seção 3.2),
   opt-in na criação, automático na venda. Sincronização com **Simulação** continua fora de
   escopo (sem dinheiro real, sem implicação fiscal). Edição de posição também continua sem
   gerar operação fiscal, por decisão consciente (ver seção 3.2).
2. **Detecção automática de day trade** — comparar compra e venda do mesmo ticker no mesmo dia
   em vez de depender do usuário marcar manualmente.
3. **Cálculo de DARF** — aplicar alíquota (15% comum, 20% day trade/FII), código de recolhimento
   6015, data de vencimento (último dia útil do mês seguinte).
4. **IRRF "dedo-duro"** — 0,005% retido na fonte em operações comuns, abate do DARF devido.
5. **Dividendos/JCP/rendimentos de FII** — hoje o módulo só cobre compra/venda.
6. **Eventos corporativos** (desdobramento, grupamento, bonificação) — afetam quantidade/custo
   médio e não são tratados hoje; um desdobramento não registrado quebraria o custo médio
   calculado pelo livro fiscal.
7. **Relatório anual de declaração de IR** — posição em 31/12 por ativo (custo fiscal, não valor
   de mercado), CNPJ/razão social, resumo mês a mês pronto pra copiar na declaração.
8. **Simulador de venda plugado nas Recomendações** — mostrar o impacto fiscal estimado de uma
   recomendação (`venda_prioritaria`/`troca_sugerida`/`reducao_risco`) antes de executá-la,
   reaproveitando `getApuracaoAnual` pra projetar "e se eu vender X hoje".
9. **Alerta de proximidade do limite de isenção** (R$20mil/mês, bucket comum) no dashboard —
   avisar antes que uma venda planejada estoure o limite do mês.

## 5. Riscos e limitações conhecidas

- **Não substitui apuração oficial** (ReVar da Receita Federal) nem orientação de contador —
  é uma ferramenta de apoio pessoal, mesmo posicionamento do motor de scoring do resto do app.
- **Reprocessa todo o histórico do usuário a cada chamada de apuração** (sem tabela de saldo
  persistido) — decisão deliberada de simplicidade/consistência; se o volume de operações de um
  usuário crescer muito (milhares de lançamentos), reavaliar performance antes de escalar pra
  multi-usuário sério.
- **Sem herança de custo médio da carteira `Investimento`** — ver aviso da seção 2, é a limitação
  mais fácil de esquecer e mais fácil de gerar número errado se ignorada.
