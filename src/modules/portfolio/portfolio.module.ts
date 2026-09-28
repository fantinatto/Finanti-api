import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { FiscalModule } from '../fiscal/fiscal.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioConfigService } from './services/portfolio-config.service';
import { RebalancingRuleService } from './services/rebalancing-rule.service';
import { InvestimentoService } from './services/investimento.service';
import { SimulacaoService } from './services/simulacao.service';
import { HistoricoCarteiraService } from './services/historico-carteira.service';
import { PortfolioSnapshotService } from './recommendation-engine/snapshot/portfolio-snapshot.service';
import { PortfolioEvaluatorService } from './recommendation-engine/evaluation/portfolio-evaluator.service';
import { PortfolioEvaluationComparatorService } from './recommendation-engine/evaluation/portfolio-evaluation-comparator.service';
import { PortfolioMoveGeneratorService } from './recommendation-engine/moves/portfolio-move-generator.service';
import { PortfolioMoveValidatorService } from './recommendation-engine/moves/portfolio-move-validator.service';
import { PortfolioStateTransitionService } from './recommendation-engine/simulation/portfolio-state-transition.service';
import { RecommendationEngineService } from './recommendation-engine/recommendation-engine.service';
import { PortfolioStateHashService } from './recommendation-engine/search/portfolio-state-hash.service';
import { PortfolioCycleGuardService } from './recommendation-engine/search/portfolio-cycle-guard.service';
import { PortfolioMoveOrderingService } from './recommendation-engine/search/portfolio-move-ordering.service';
import { PortfolioDominanceService } from './recommendation-engine/search/portfolio-dominance.service';
import { PortfolioSearchEngineService } from './recommendation-engine/search/portfolio-search-engine.service';
import { PortfolioDecisionTraceService } from './recommendation-engine/explainability/portfolio-decision-trace.service';
import { DynamicAllocationBandService } from './recommendation-engine/allocation-band/dynamic-allocation-band.service';
import { SegmentDiversificationAdmissibilityService } from './recommendation-engine/segment-diversification/segment-diversification-admissibility.service';
import { RecommendationPolicyService } from './recommendation-engine/policy/recommendation-policy.service';

@Module({
  imports: [AuthModule, MarketDataModule, FiscalModule],
  controllers: [PortfolioController],
  providers: [
    PortfolioConfigService,
    RebalancingRuleService,
    InvestimentoService,
    SimulacaoService,
    HistoricoCarteiraService,
    PortfolioSnapshotService,
    PortfolioEvaluatorService,
    PortfolioEvaluationComparatorService,
    PortfolioMoveGeneratorService,
    PortfolioMoveValidatorService,
    PortfolioStateTransitionService,
    RecommendationEngineService,
    PortfolioStateHashService,
    PortfolioCycleGuardService,
    PortfolioMoveOrderingService,
    PortfolioDominanceService,
    PortfolioSearchEngineService,
    PortfolioDecisionTraceService,
    DynamicAllocationBandService,
    SegmentDiversificationAdmissibilityService,
    RecommendationPolicyService,
  ],
})
export class PortfolioModule {}
