export const BASES_REGRA_PADRAO = [80, 100, 110, 120] as const;
export type BaseRegraPadrao = (typeof BASES_REGRA_PADRAO)[number];

/// Taxa neutra de referência (% a.a.) — patamar histórico aproximado do DI, não um dado
/// oficial. Serve só de ponto de comparação pra regra "ajustada por juros"; ajuste livremente.
export const TAXA_NEUTRA_DI_REFERENCIA = 10;

/// Pontos de % de renda variável descontados por ponto percentual de DI acima da taxa neutra.
/// Heurística própria do Finanti (não é regra consagrada na literatura) — quanto maior o juro,
/// menos atrativa fica a renda variável frente à renda fixa.
export const SENSIBILIDADE_JUROS = 1.5;

/// Taxa do contrato DI futuro (% a.a.) cadastrada manualmente — o endpoint /v2/futuros da
/// brapi retorna "Serviço temporariamente indisponível" (provavelmente exige plano Pro do
/// token, mesmo padrão dos módulos de fundamentos que já travam no plano Gratuito). Sem
/// fonte ao vivo disponível, usa esse valor fixo até termos uma API de futuros acessível.
/// Atualizar manualmente quando o mercado se mover — não é uma cotação em tempo real.
export const CONTRATO_DI_FIXO = 'DI1F35';
export const TAXA_DI_FIXA = 14.68;
