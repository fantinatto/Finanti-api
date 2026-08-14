# Finanti API — Erros Frequentes

## 1. Erros de TypeScript — campos/modelos não existem no Prisma

**Sintoma:**
```
error TS2353: Object literal may only specify known properties, and 'workingHoursPerDay' does not exist in type 'UserSelect'
error TS2339: Property 'subscription' does not exist on type 'PrismaClient'
```

**Causa:** Código copiado do `fantiup-api` referencia modelos que foram removidos do `schema.prisma` (organizations, subscription, CV, workspace, etc.).

**Solução:**
1. Remover o getter do modelo em `src/common/prisma/prisma.service.ts`
2. Reescrever o service/controller que faz a query para usar apenas os campos do schema atual
3. Rodar `npx prisma generate` para regenerar o client

---

## 2. Cannot find module '../integrations/...'

**Sintoma:**
```
error TS2307: Cannot find module '../integrations/microsoft/microsoft.service'
```

**Causa:** Arquivos que referenciam módulos de integração (Microsoft, Google, AzureDevOps, SolMan, Trello) que não foram copiados para o Finanti-api.

**Solução:** Remover os imports e referências nos arquivos afetados. Para `auth.module.ts`, remover todos os `imports` de integration modules. Para `auth.controller.ts`, remover os endpoints OAuth.

---

## 3. Module '"@prisma/client"' has no exported member 'WorkspaceType' / 'OrgRole' / 'ModuleKey'

**Sintoma:**
```
error TS2305: Module '"@prisma/client"' has no exported member 'WorkspaceType'
```

**Causa:** Enums do `fantiup-api` que não existem no schema do Finanti (sem organizations, sem workspace).

**Solução:** Deletar os arquivos que os importam se não forem necessários (ex: `switch-workspace.dto.ts`, `org-module.guard.ts`, `require-module.decorator.ts`). Se o arquivo for necessário, remover apenas o import e a lógica que depende do enum.

---

## 4. Can't find node.js binary "npm" (VS Code Run and Debug)

**Sintoma:**
```
Can't find node.js binary "npm": path does not exist
```

**Causa:** No Windows, o VS Code não resolve o `npm` diretamente como `runtimeExecutable`.

**Solução:** Em `.vscode/launch.json`, trocar:
```json
"runtimeExecutable": "npm",
"runtimeArgs": ["run", "start:dev"]
```
por:
```json
"runtimeExecutable": "cmd",
"runtimeArgs": ["/c", "npm", "run", "start:dev"]
```

---

## 5. prisma generate vs migrate — qual rodar?

Ver `PRISMA.md` para o guia completo. Resumo:

| Situação | Comando |
|---|---|
| Clonou o repo / instalou dependências | `npx prisma generate` |
| Adicionou/alterou model no schema | `npx prisma migrate dev --create-only --name <nome>` → revisar SQL → `npx prisma migrate dev` |
| Deploy em produção | `npx prisma migrate deploy` |

> `prisma generate` nunca toca no banco. `migrate dev` cria e aplica. `migrate deploy` só aplica.
