import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PortfolioConfigService } from './services/portfolio-config.service';
import { RebalancingRuleService } from './services/rebalancing-rule.service';
import { InvestimentoService } from './services/investimento.service';
import type { TipoCarteira } from './services/investimento.service';
import { SimulacaoService } from './services/simulacao.service';
import { HistoricoCarteiraService } from './services/historico-carteira.service';
import { FiscalService } from '../fiscal/services/fiscal.service';
import { RecommendationEngineService } from './recommendation-engine/recommendation-engine.service';
import { UpsertPortfolioConfigDto } from './dto/upsert-portfolio-config.dto';
import { UpsertInvestimentoDto } from './dto/upsert-investimento.dto';
import { VenderInvestimentoDto } from './dto/vender-investimento.dto';
import { UpsertSimulacaoConfigDto } from './dto/upsert-simulacao-config.dto';
import { ExecutarNextBestActionDto } from './dto/executar-next-best-action.dto';
import { BASES_REGRA_PADRAO, CONTRATO_DI_FIXO, TAXA_DI_FIXA } from './rebalancing.config';

@Controller('portfolio')
@UseGuards(JwtAuthGuard)
export class PortfolioController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PortfolioConfigService,
    private readonly regras: RebalancingRuleService,
    private readonly investimentos: InvestimentoService,
    private readonly simulacao: SimulacaoService,
    private readonly historicoCarteira: HistoricoCarteiraService,
    private readonly fiscal: FiscalService,
    private readonly recommendationEngine: RecommendationEngineService,
  ) {}

  @Get('config')
  async getConfig(@Req() req: Request) {
    return this.config.getConfig(req['user'].sub);
  }

  @Put('config')
  async upsertConfig(@Req() req: Request, @Body() dto: UpsertPortfolioConfigDto) {
    return this.config.upsertConfig(req['user'].sub, dto);
  }

  @Get('regras/sugestao')
  async getSugestaoBase(@Req() req: Request, @Query('base', ParseIntPipe) base: number) {
    const idade = await this.getIdadeUsuario(req['user'].sub);
    return { idade, base, percentualSugerido: this.regras.calcularSugestaoBase(idade, base) };
  }

  @Get('regras/sugestao-di')
  async getSugestaoDi(@Req() req: Request, @Query('base', ParseIntPipe) base: number) {
    const idade = await this.getIdadeUsuario(req['user'].sub);

    // Taxa cadastrada manualmente — o endpoint de futuros da brapi.dev não está disponível
    // no plano atual (ver comentário em rebalancing.config.ts).
    const percentualSugerido = this.regras.calcularSugestaoAjustadaPorJuros(idade, base, TAXA_DI_FIXA);
    return { idade, base, contratoDi: CONTRATO_DI_FIXO, taxaDi: TAXA_DI_FIXA, percentualSugerido };
  }

  @Get('regras/bases')
  getBasesDisponiveis() {
    return { bases: BASES_REGRA_PADRAO };
  }

  @Get('investimentos')
  async listarInvestimentos(@Req() req: Request) {
    return this.investimentos.listar(req['user'].sub);
  }

  @Post('investimentos')
  async criarInvestimento(@Req() req: Request, @Body() dto: UpsertInvestimentoDto) {
    const userId = req['user'].sub;
    const investimento = await this.investimentos.criar(userId, dto);

    // Espelha no livro fiscal só se o usuário marcou explicitamente (ver comentário do campo no
    // DTO) — "Adicionar" também serve pra cadastrar uma posição antiga já possuída, então nunca
    // registra por padrão sem confirmação.
    if (dto.registrarFiscal && dto.tipo !== 'renda_fixa' && dto.ticker) {
      await this.fiscal.criar(userId, {
        data: dto.dataOperacao ?? new Date().toISOString().slice(0, 10),
        ticker: dto.ticker,
        assetType: dto.tipo,
        tipo: 'compra',
        tradeType: 'swing',
        quantidade: dto.quantidade,
        precoUnitario: dto.precoMedio,
        custos: dto.custosFiscais ?? 0,
      });
    }

    return investimento;
  }

  @Put('investimentos/:id')
  async atualizarInvestimento(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertInvestimentoDto) {
    return this.investimentos.atualizar(req['user'].sub, id, dto);
  }

  @Delete('investimentos/:id')
  async removerInvestimento(@Req() req: Request, @Param('id') id: string) {
    await this.investimentos.remover(req['user'].sub, id);
    return { ok: true };
  }

  @Post('investimentos/:id/vender')
  async venderInvestimento(@Req() req: Request, @Param('id') id: string, @Body() dto: VenderInvestimentoDto) {
    const userId = req['user'].sub;
    // Buscado ANTES de vender() — vender() pode deletar a linha (posição zerada), e o ticker/tipo
    // fazem falta pra montar a OperacaoFiscal depois.
    const antes = await this.investimentos.garantirDono(userId, id, 'real');
    const resultado = await this.investimentos.vender(userId, id, dto.quantidade);

    // Diferente da criação, uma venda nunca é ambígua (é sempre uma operação de hoje) — registra
    // no fiscal automaticamente sempre que vier um preço, sem precisar de confirmação extra.
    if (dto.precoVenda != null && antes.tipo !== 'renda_fixa' && antes.ticker) {
      await this.fiscal.criar(userId, {
        data: new Date().toISOString().slice(0, 10),
        ticker: antes.ticker,
        assetType: antes.tipo as 'acao' | 'fii',
        tipo: 'venda',
        tradeType: 'swing',
        quantidade: dto.quantidade,
        precoUnitario: dto.precoVenda,
        custos: dto.custosFiscais ?? 0,
      });
    }

    return resultado;
  }

  @Get('investimentos/ganhos')
  async ganhosInvestimentos(@Req() req: Request, @Query('anoMes') anoMes: string) {
    const userId = req['user'].sub;
    await this.historicoCarteira.garantirSnapshotDoMes(userId, 'real', anoMes);
    return this.investimentos.calcularGanhos(userId, anoMes);
  }

  @Get('investimentos/recomendacoes')
  async recomendacoesInvestimentos(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getRecomendacoes(req['user'].sub, anoMes);
  }

  @Get('investimentos/balanceamento')
  async balanceamentoInvestimentos(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getBalanceamentoPorSetor(req['user'].sub, anoMes);
  }

  @Get('investimentos/saude')
  async saudeInvestimentos(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getSaudeCarteira(req['user'].sub, anoMes);
  }

  @Get('investimentos/impacto')
  async impactoInvestimentos(
    @Req() req: Request,
    @Query('anoMes') anoMes: string,
    @Query('ticker') ticker: string,
    @Query('valor') valor: string,
  ) {
    return this.investimentos.simularImpactoCompra(req['user'].sub, anoMes, ticker.toUpperCase(), Number(valor));
  }

  @Get('historico')
  async getHistorico(@Req() req: Request, @Query('carteira') carteira: TipoCarteira) {
    return this.historicoCarteira.listarHistorico(req['user'].sub, carteira ?? 'real');
  }

  @Get('simulacao/config')
  async getSimulacaoConfig(@Req() req: Request) {
    return this.simulacao.getConfig(req['user'].sub);
  }

  @Put('simulacao/config')
  async upsertSimulacaoConfig(@Req() req: Request, @Body() dto: UpsertSimulacaoConfigDto) {
    return this.simulacao.upsertConfig(req['user'].sub, dto);
  }

  @Post('simulacao/reiniciar')
  async reiniciarSimulacao(@Req() req: Request) {
    await this.simulacao.reiniciar(req['user'].sub);
    return { ok: true };
  }

  @Get('simulacao/ganho-realizado')
  async getGanhoRealizado(@Req() req: Request) {
    return { ganhoRealizado: await this.simulacao.getGanhoRealizado(req['user'].sub) };
  }

  @Get('simulacao/transacoes')
  async listarTransacoesSimulacao(@Req() req: Request) {
    return this.simulacao.listarTransacoes(req['user'].sub);
  }

  @Get('simulacao/investimentos')
  async listarInvestimentosSimulacao(@Req() req: Request) {
    return this.investimentos.listar(req['user'].sub, 'simulacao');
  }

  @Post('simulacao/investimentos')
  async criarInvestimentoSimulacao(@Req() req: Request, @Body() dto: UpsertInvestimentoDto, @Query('anoMes') anoMes?: string) {
    return this.simulacao.criar(req['user'].sub, dto, anoMes);
  }

  @Put('simulacao/investimentos/:id')
  async atualizarInvestimentoSimulacao(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertInvestimentoDto) {
    return this.simulacao.atualizar(req['user'].sub, id, dto);
  }

  @Delete('simulacao/investimentos/:id')
  async removerInvestimentoSimulacao(@Req() req: Request, @Param('id') id: string) {
    await this.investimentos.remover(req['user'].sub, id, 'simulacao');
    return { ok: true };
  }

  @Post('simulacao/investimentos/:id/vender')
  async venderInvestimentoSimulacao(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: VenderInvestimentoDto,
    @Query('anoMes') anoMes: string,
  ) {
    return this.simulacao.venderManual(req['user'].sub, id, dto.quantidade, anoMes);
  }

  @Get('simulacao/investimentos/ganhos')
  async ganhosInvestimentosSimulacao(@Req() req: Request, @Query('anoMes') anoMes: string) {
    const userId = req['user'].sub;
    await this.historicoCarteira.garantirSnapshotDoMes(userId, 'simulacao', anoMes);
    return this.investimentos.calcularGanhos(userId, anoMes, 'simulacao');
  }

  @Get('simulacao/investimentos/recomendacoes')
  async recomendacoesInvestimentosSimulacao(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getRecomendacoes(req['user'].sub, anoMes, 'simulacao');
  }

  /**
   * Preview do motor novo (Search Engine depth=3 + Decision Trace) — só leitura, nenhuma
   * mutação, deliberadamente PARALELO ao endpoint legado acima. Não substitui/chama
   * `getRecomendacoes`/`generateB1` nem é chamado por eles.
   */
  @Get('recommendation-engine/preview')
  async previewRecommendationEngine(@Req() req: Request, @Query('anoMes') anoMes: string, @Query('carteira') carteira?: TipoCarteira) {
    return this.recommendationEngine.getPreview(req['user'].sub, anoMes, carteira ?? 'real');
  }

  /**
   * Executa de verdade a Next Best Action do Preview (ver plano "Next Best Action / Receding
   * Horizon") — SEMPRE recalcula o Search aqui dentro antes de executar; `409` (`
   * NEXT_BEST_ACTION_CHANGED`) se a carteira mudou desde o Preview que o usuário confirmou.
   */
  @Post('simulacao/next-best-action/executar')
  async executarNextBestAction(@Req() req: Request, @Body() dto: ExecutarNextBestActionDto, @Query('anoMes') anoMes: string, @Query('carteira') carteira?: TipoCarteira) {
    return this.recommendationEngine.executeNextBestAction(req['user'].sub, anoMes, carteira ?? 'simulacao', dto.expectedActionFingerprint, dto.expectedSnapshotHash);
  }

  @Get('simulacao/investimentos/balanceamento')
  async balanceamentoInvestimentosSimulacao(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getBalanceamentoPorSetor(req['user'].sub, anoMes, 'simulacao');
  }

  @Get('simulacao/investimentos/saude')
  async saudeInvestimentosSimulacao(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getSaudeCarteira(req['user'].sub, anoMes, 'simulacao');
  }

  @Get('simulacao/investimentos/impacto')
  async impactoInvestimentosSimulacao(
    @Req() req: Request,
    @Query('anoMes') anoMes: string,
    @Query('ticker') ticker: string,
    @Query('valor') valor: string,
  ) {
    return this.investimentos.simularImpactoCompra(req['user'].sub, anoMes, ticker.toUpperCase(), Number(valor), 'simulacao');
  }

  @Post('simulacao/investimentos/:id/executar-recomendacao')
  async executarRecomendacao(@Req() req: Request, @Param('id') id: string, @Query('anoMes') anoMes: string) {
    return this.simulacao.executarRecomendacao(req['user'].sub, id, anoMes);
  }

  @Post('simulacao/aplicar-aporte')
  async aplicarAporteSemanal(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.simulacao.aplicarAporteSemanal(req['user'].sub, anoMes);
  }

  @Post('simulacao/investir-caixa')
  async investirCaixa(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.simulacao.investirCaixa(req['user'].sub, anoMes);
  }

  private async getIdadeUsuario(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { uuid_usuario: userId }, select: { birthDate: true } });
    if (!user.birthDate) {
      throw new BadRequestException('Cadastre sua data de nascimento em Configurações antes de usar as regras de rebalanceamento.');
    }
    return this.regras.calcularIdade(user.birthDate);
  }
}
