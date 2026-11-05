# Checkpoint não destrutivo da Medição

Em 05/11/2026, na obra Palácio Rio Madeira, a revisão confirmada era 537 e a base materializada estava na revisão 513. Havia 399 linhas em `measurement_workspace_events`. A consulta ao banco mediu 32.553.710 bytes armazenados nessas linhas e 13.311.726 bytes na medição materializada. O tamanho armazenado difere do tamanho lógico do JSON; não se deve usar a soma de todas as linhas como custo de replay de uma gravação, pois o materializador lê apenas revisões posteriores à base.

Foi aplicado um checkpoint transacional da revisão 537, com comparação do hash da medição antes e depois. O resultado confirmou base 537, revisão 537, 399 eventos preservados e um backup privado da base 513. Nenhum evento ou auditoria foi removido.

## Próximo checkpoint

1. Leia `revision`, `(data->>'revision')::bigint` e `md5(public.materialize_measurement_workspace(project_id)::text)` em `measurement_workspaces` para a obra. Execute em horário de menor atividade.
2. Se houver atraso de revisões, chame `public.checkpoint_measurement_workspace(project_id, revision, hash)` como proprietário. A função confere revisão, conteúdo e índice sob trava da obra e cria backup privado antes de atualizar a base.
3. Confira que a revisão não mudou, que a base alcançou a revisão, que o hash permaneceu igual e que a contagem de `measurement_workspace_events` não diminuiu.

O checkpoint reduz o replay de leitura. Ele não reduz o tamanho de operações que ainda usam `commit_measurement_workspace` com a medição integral. Para cada timeout desse caminho, identificar a ação do usuário e criar um comando delimitado com regressão específica. O salvamento direcionado da edição manual que desvincula desenho entrou na PR #115; os demais casos precisam de evidência própria.

O preflight de `audit_logs` só consulta IDs ainda ausentes da fotografia local, e a retentativa geral usa esperas de 2, 5, 15 e 30 segundos. Um aparente ciclo a cada 1–2 segundos deve ser confirmado por rastreamento da mesma sessão antes de alterar essas proteções.
