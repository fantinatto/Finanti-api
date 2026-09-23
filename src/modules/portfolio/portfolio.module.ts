import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioConfigService } from './services/portfolio-config.service';
import { RebalancingRuleService } from './services/rebalancing-rule.service';
import { InvestimentoService } from './services/investimento.service';

@Module({
  imports: [AuthModule, MarketDataModule],
  controllers: [PortfolioController],
  providers: [PortfolioConfigService, RebalancingRuleService, InvestimentoService],
})
export class PortfolioModule {}
