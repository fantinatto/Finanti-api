# Finanti API — Visão Geral

Backend do Finanti. NestJS + Prisma + Supabase (PostgreSQL) + Vercel.

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | NestJS 11 |
| ORM | Prisma 5 |
| Banco | Supabase (PostgreSQL) |
| Deploy | Vercel (serverless via `api/index.ts`) |
| Auth | JWT (email/senha) |
| APIs externas | bolsai + brapi.dev |

## Estrutura de pastas

```
src/
├── app.module.ts          # Módulo raiz — só importa AuthModule, UsersModule, PrismaModule
├── main.ts                # Entry point local (dev)
├── common/
│   ├── prisma/            # PrismaService singleton (padrão Vercel)
│   ├── crypto/            # AES-256-GCM encryption util
│   └── utils/             # Timezone utils
├── modules/
│   ├── auth/              # JWT, login, register, forgot/reset password
│   └── users/             # GET /users/me
prisma/
└── schema.prisma          # Apenas User + PasswordResetToken (crescimento sob demanda)
api/
└── index.ts               # Entry point Vercel (serverless adapter)
```

## Módulos previstos (a criar)

| Módulo | Responsabilidade |
|---|---|
| `portfolio` | Passivos, ganhos e investimentos mensais |
| `rebalancing` | Regras de alocação (regra dos 100/80) |
| `ranking` | Motor de scoring: Qualidade / Risco / Preço |
| `market-data` | Integração bolsai + brapi.dev |

## Schema Prisma — modelos ativos

- `User` — autenticação e perfil
- `PasswordResetToken` — redefinição de senha

> Novos modelos são adicionados conforme os módulos forem implementados. Nunca criar tabelas antecipadamente.
> Consulte `PRISMA.md` para o fluxo correto de migrations.

## Variáveis de ambiente (.env)

```
NODE_ENV=development
FRONTEND_URL=
JWT_SECRET=
COOKIE_SECRET=
NEXT_PUBLIC_SUPABASE_URL=https://lclyhjytdtajehquthbq.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=
DATABASE_URL=
DIRECT_URL=
ENCRYPTION_KEY=
BOLSAI_API_KEY=
BRAPI_TOKEN=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

## Como rodar (desenvolvimento)

```bash
npm install          # também roda prisma generate via postinstall
npm run start:dev    # watch mode
```

Ou via VS Code: `Ctrl+Shift+D` → selecionar **Finanti API — Dev** → `F5`.

## Endpoints disponíveis

### Auth (`/api/v1/auth`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/register` | Cadastro com email/senha |
| POST | `/auth/login` | Login — retorna JWT |
| POST | `/auth/logout` | Logout (stateless) |
| POST | `/auth/forgot-password` | Gera link de redefinição |
| POST | `/auth/reset-password` | Redefine senha via token |
| GET | `/auth/validate` | Valida JWT |
| GET | `/auth/me` | Retorna usuário do token |

### Users (`/api/v1/users`) — requer JWT
| Método | Rota | Descrição |
|---|---|---|
| GET | `/users/me` | Perfil do usuário autenticado |

## Origem dos artefatos

Este projeto foi bootstrapped a partir do `fantiup-api`. Artefatos copiados:
- Infraestrutura NestJS (package.json, tsconfig, nest-cli, vercel.json)
- `PrismaService` singleton (padrão Vercel)
- Módulo `auth` — limpo (removido OAuth Microsoft/Google/LinkedIn, organizations, CV)
- Módulo `users` — simplificado (removido workspace, work schedule, team members)
- `encryption.util.ts`, `timezone.utils.ts`

Consulte `REUSE.md` para rastrear o que foi migrado conforme novos módulos forem criados.
