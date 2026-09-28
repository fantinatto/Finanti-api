import { IsString, MinLength } from 'class-validator';

/** Os 2 campos são preenchidos pelo FRONT a partir do Preview que o usuário está olhando — ver
 * RecommendationEngineService.executeNextBestAction (anti-stale: nunca executa uma ação
 * diferente da que foi confirmada). */
export class ExecutarNextBestActionDto {
  @IsString()
  @MinLength(1)
  expectedActionFingerprint: string;

  @IsString()
  @MinLength(1)
  expectedSnapshotHash: string;
}
