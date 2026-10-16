# Contratos cancelados e reativação parcial

## Escopo e dados

- Custos / Terceirizados: seção final recolhida, faixa vermelha, data, motivo e histórico consultável.
- Revisão seleciona somente atividades livres; valor começa vazio e deve cobrir o pagamento líquido anterior.
- Identificadores, quantidades contratadas, simulação, comprovantes, estornos e rateios anteriores são preservados. Pagamentos legados recebem o rateio congelado antes da mudança de escopo.
- `save_subcontract_reactivation` reutiliza `save_normalized_domain`, com versão esperada e bloqueio da obra. Altera um contrato, sua auditoria e sua cópia de segurança; mantém os demais metadados e contratos legados da cópia.
- A interface só confirma após resposta da RPC. Sem a migração, a reativação falha conservadoramente e mantém o formulário.
- A migração não atualiza registros existentes e não altera políticas RLS, papéis ou permissões existentes. A nova RPC é SECURITY INVOKER.
- Leitura: contratos, orçamento, analíticas e aditivos completos. Escrita: subcontracts, audit_logs e backup do contrato em projects.data_json. Nenhuma escrita em produção, quantitativos, Medição ou Almoxarifado.

## Validação automatizada

Arquivos focados: `subcontractReactivation.test.ts`, `subcontractReactivation.database.test.ts`, `SubcontractReactivationDialog.test.tsx`, `RealCost.subcontracts.test.tsx` e `projectSync.normalizedDomains.test.ts`.

Cobrem apresentação recolhida e expansão, perfis, liberação/reserva, seleção parcial/integral, vínculos ausentes/ambíguos/legados, valor vazio/insuficiente, pagamentos/estornos/comprovantes, histórico, conflito de versão/ocupação, rollback de contrato/versão/auditoria, backup legado, falha de gravação e confirmação assíncrona.

## Validação operacional / implantação

Aplicar `20261016140000_subcontract_reactivation.sql` e integrar a interface somente após o gate de regressão. Não reativar o YANKE nem usar o novo contrato do usuário como teste.

Na página operacional do Lovable, com uma obra temporária identificada:

1. Criar contrato temporário com duas atividades e cancelar; conferir liberação e seção recolhida.
2. Reservar uma atividade em rascunho temporário. Revisar o cancelado, conferir ocupante, valor vazio, motivo e cobertura de pagamentos.
3. Reativar a atividade livre, aguardar confirmação da nuvem e recarregar; conferir mesmo identificador, novo total e histórico dos dois escopos.
4. Cancelar novamente e conferir toda a sequência no histórico. Repetir expansão/revisão em viewport de celular.
5. Conciliar e restaurar os dados temporários pelo fluxo reversível da obra. Nunca executar limpeza de dados reais.

Testes locais e PostgreSQL isolado não comprovam implantação ou funcionamento no Lovable. Registrar separadamente a versão operacional verificada e a restauração dos dados temporários.
