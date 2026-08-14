# Prisma — Guia de Referência

## Ordem correta de execução

```
1. prisma generate         ← sempre primeiro ao clonar ou mudar o schema
2. prisma migrate dev      ← aplica mudanças no banco (desenvolvimento)
3. prisma migrate deploy   ← produção apenas
```

---

## Comandos e o que fazem

### `npx prisma generate`
- Gera o `PrismaClient` tipado em `node_modules/@prisma/client`
- **Não toca no banco de dados**
- Rodar sempre que: clonar o repo, mudar o `schema.prisma`, rodar `npm install`

### `npx prisma migrate dev --name <nome>`
- Compara o schema com o banco e cria uma migration SQL em `prisma/migrations/`
- Aplica a migration no banco de desenvolvimento
- Roda `prisma generate` automaticamente ao final
- Usar em: desenvolvimento local

### `npx prisma migrate dev --create-only --name <nome>`
- Cria o arquivo SQL da migration **sem aplicar**
- Permite revisar o SQL antes de executar
- Rodar `prisma migrate dev` depois para aplicar

### `npx prisma migrate deploy`
- Aplica migrations pendentes no banco (produção/staging)
- **Não cria novas migrations** — apenas executa as existentes em `prisma/migrations/`
- Usar em: CI/CD, deploy em produção

### `npx prisma db push`
- Sincroniza o schema direto no banco **sem criar arquivo de migration**
- Útil para prototipagem rápida
- **Não usar em produção** — não gera histórico de migrations

### `npx prisma studio`
- Abre interface visual do banco no navegador (localhost:5555)

### `npx prisma migrate reset`
- **DESTRUTIVO** — apaga e recria o banco do zero, aplica todas as migrations
- Usar apenas em desenvolvimento local quando necessário

---

## Fluxo típico de desenvolvimento

```bash
# 1. Clonar repo / instalar dependências
npm install
npx prisma generate

# 2. Adicionar um novo model no schema.prisma, depois:
npx prisma migrate dev --create-only --name add_passivos
# revisar o SQL gerado em prisma/migrations/
npx prisma migrate dev

# 3. Verificar dados no banco
npx prisma studio
```

## Fluxo de deploy (produção)

```bash
npx prisma migrate deploy   # aplica migrations pendentes
npx prisma generate         # gera client atualizado
```

---

## Regras do projeto

- Toda migration deve ser **aditiva** — nunca remover coluna sem garantir que nenhum código a usa
- Sempre usar `--create-only` antes de aplicar para revisar o SQL
- Nunca rodar `migrate reset` em staging/produção
- O schema deste projeto cresce sob demanda — não criar tabelas antecipadamente
