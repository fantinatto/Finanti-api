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
import { UpsertPortfolioConfigDto } from './dto/upsert-portfolio-config.dto';
import { UpsertInvestimentoDto } from './dto/upsert-investimento.dto';
import { UpsertSimulacaoConfigDto } from './dto/upsert-simulacao-config.dto';
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
    return this.investimentos.criar(req['user'].sub, dto);
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

  @Get('simulacao/investimentos')
  async listarInvestimentosSimulacao(@Req() req: Request) {
    return this.investimentos.listar(req['user'].sub, 'simulacao');
  }

  @Post('simulacao/investimentos')
  async criarInvestimentoSimulacao(@Req() req: Request, @Body() dto: UpsertInvestimentoDto) {
    return this.investimentos.criar(req['user'].sub, dto, 'simulacao');
  }

  @Put('simulacao/investimentos/:id')
  async atualizarInvestimentoSimulacao(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertInvestimentoDto) {
    return this.investimentos.atualizar(req['user'].sub, id, dto, 'simulacao');
  }

  @Delete('simulacao/investimentos/:id')
  async removerInvestimentoSimulacao(@Req() req: Request, @Param('id') id: string) {
    await this.investimentos.remover(req['user'].sub, id, 'simulacao');
    return { ok: true };
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
