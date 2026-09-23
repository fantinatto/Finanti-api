import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PortfolioConfigService } from './services/portfolio-config.service';
import { RebalancingRuleService } from './services/rebalancing-rule.service';
import { InvestimentoService } from './services/investimento.service';
import { UpsertPortfolioConfigDto } from './dto/upsert-portfolio-config.dto';
import { UpsertInvestimentoDto } from './dto/upsert-investimento.dto';
import { BASES_REGRA_PADRAO, CONTRATO_DI_FIXO, TAXA_DI_FIXA } from './rebalancing.config';

@Controller('portfolio')
@UseGuards(JwtAuthGuard)
export class PortfolioController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PortfolioConfigService,
    private readonly regras: RebalancingRuleService,
    private readonly investimentos: InvestimentoService,
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
    return this.investimentos.calcularGanhos(req['user'].sub, anoMes);
  }

  @Get('investimentos/recomendacoes')
  async recomendacoesInvestimentos(@Req() req: Request, @Query('anoMes') anoMes: string) {
    return this.investimentos.getRecomendacoes(req['user'].sub, anoMes);
  }

  private async getIdadeUsuario(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { uuid_usuario: userId }, select: { birthDate: true } });
    if (!user.birthDate) {
      throw new BadRequestException('Cadastre sua data de nascimento em Configurações antes de usar as regras de rebalanceamento.');
    }
    return this.regras.calcularIdade(user.birthDate);
  }
}
