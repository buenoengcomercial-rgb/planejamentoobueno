# Medição independente na nuvem

A tela operacional reutiliza o mesmo MeasurementWorkspace da prévia: boletim editável acima da planilha, painel inferior de quantitativos e exportações compartilhadas. A ativação é registrada por obra no banco; o armazenamento local serve apenas a rascunhos e recuperação.

## Dados e gravação

- Incorporação inicial exige exportação integral conferida e comparação de quantidade/valor. Os registros originais de Produção, orçamento, auditoria e plantas não são reescritos.
- Uma transação confirma detalhes, referências, plantas, períodos e histórico. Revisão esperada e recibo idempotente impedem sobrescrita concorrente e repetição após resposta perdida.
- O servidor valida contrato, geometria, referências, permissões e bloqueios fiscais. Novos serviços dependem de snapshot aprovado do aditivo. Snapshot fiscal é conferido contra o mesmo cálculo financeiro utilizado na interface.
- Arquivos permanecem no bucket privado existente; histórico e backup têm as mesmas permissões da obra. Exclusão de referência não remove arquivos originais.
- A recuperação local é separada por usuário e obra. Uma falha nunca gera confirmação de salvamento.

## Instalação

Aplicar as proteções de execução 20261009140000/141000 e a conciliação 20261010015000 antes da ativação. A última preserva as intenções novas de exclusão da versão atual do Lovable. A migração 20261010020000 cria a base independente sem ativar obras automaticamente.

Cada incorporação operacional conserva backup no servidor e fora dele e verifica contagens/checksums antes e depois da transação. Nenhum payload de obra ou backup privado pertence ao repositório.

## Validação

132 testes focados: tela e boletim, medição por período, histórico, concorrência, recuperação, cópia/referência, captura transacional, envio fiscal, integração das proteções e sincronização da obra. TypeScript, lint dos arquivos alterados e build aprovados. Testes de banco executados em PostgreSQL isolado com PGlite.
