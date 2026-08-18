# Matriz de auditoria dos botões do Almoxarifado

## Método

A interface publicada da `CPA OBRA` foi inspecionada em 17/08/2026. Foram abertas as abas e formulários sem confirmar, salvar, excluir, estornar, enviar arquivos ou alterar dados. Os comandos que produzem efeitos deverão ser testados em uma cópia controlada da obra.

Cada comando deve atender aos seguintes requisitos:

- nome descreve o resultado;
- permissão coerente com o perfil;
- campos obrigatórios identificados antes da execução;
- proteção contra clique duplo;
- retorno visual de sucesso ou erro;
- fechamento e cancelamento sem aprisionar o usuário;
- auditoria do usuário autenticado;
- funcionamento por teclado e celular;
- ícone com tooltip e nome acessível;
- alvo de toque mínimo de 44 px no celular.

## Navegação e administração

| Comando atual | Observação | Melhoria necessária | Validação futura |
|---|---|---|---|
| Painel | Abre por padrão e mistura operação, pagamentos e análise | Abrir o módulo em Notas fiscais e mover Painel para Gestão | Rota, recarga e retorno à última obra |
| Abas do Almoxarifado | Oito opções no mesmo nível e fora da ordem operacional | Reordenar e separar Operação de Gestão | Teclado, foco, celular e link direto |
| Administração | Contém ação destrutiva de limpeza | Manter ações destrutivas restritas e explicitar impacto | Permissão, confirmação digitada e auditoria |

## Notas fiscais

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Tirar fotos | Disponível no celular | Exibir orientações, miniaturas, ordem e exclusão antes do envio | Câmera traseira, quatro fotos e rotação |
| Escolher arquivo/PDF | Texto orientado ao formato, não à finalidade | Renomear para `Receber material — foto ou PDF` | PDF, imagem, arquivo inválido e falha de rede |
| Lançadas no estoque | Estado principal adequado | Abrir automaticamente após confirmação | Atualização única e sem recarregar a página |
| Arquivadas | Mistura descartados, cancelados e reconciliados | Mostrar motivo e efeito no estoque | Filtros e reconciliação idempotente |
| Ícone de olho | Ícone isolado e sem texto visível | Tooltip `Visualizar documento` e alternativa `Baixar` | PDF, imagem, permissão negada e arquivo ausente |
| Visualizar dados e grupos | Nome longo e função parcialmente administrativa | Usar `Detalhes da nota`; edição de grupo dentro do painel | Somente grupo editável após lançamento |
| Cancelar lançamento | Ação crítica | Exigir motivo, mostrar impacto e criar estorno | Bloqueio por uso posterior e clique repetido |

## Materiais

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Novo item avulso | Pode criar material fora do recebimento | Restringir e explicar quando usar | Duplicidade, unidade e permissão |
| Exibir arquivados | Adequado para auditoria | Mostrar motivo e quantidade de itens | Filtro preservado e retorno à lista |
| Histórico | Ícone sem descrição textual | Tooltip e painel com origem/destino | Abrir NF, retirada e documento original |
| Excluir | Exclusão conflitante com auditoria | Substituir por `Arquivar e ocultar` | Bloquear exclusão com histórico ou saldo |
| Estoque mínimo | Campo repetido por linha | Salvar explicitamente ou informar salvamento automático | Valor inválido, zero e concorrência |

## Retiradas — atual Requisições

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Nova requisição | Nome não corresponde à entrega direta escolhida | Renomear para `Nova retirada` | Abertura rápida no desktop e celular |
| Seletor de tarefa/EAP | Lista extensa, repetida e difícil de navegar | Pesquisa digitável, EAP agrupada e sem duplicidades | Busca parcial, teclado e `Sem vínculo` |
| Almoxarife | Preenchimento manual duplica identidade do login | Remover; usar usuário autenticado | Usuário com nome e fallback para e-mail |
| Adicionar item | Precisa mostrar informação operacional suficiente | Exibir código, unidade e saldo disponível | Vários itens, repetição e remoção |
| Limpar assinatura do almoxarife | Assinatura redundante com o login | Remover assinatura do almoxarife | Identidade registrada automaticamente |
| Limpar assinatura de quem retirou | Função válida | Manter junto da confirmação do recebedor | Toque, orientação e limpeza correta |
| Salvar rascunho | Conflita com a entrega direta escolhida | Remover do fluxo principal | Garantir ausência de retiradas invisíveis |
| Entregar e baixar estoque | Ação principal correta | Exibir resumo e bloquear saldo insuficiente | Clique duplo, falha de rede e idempotência |
| Cancelar | Deve abandonar a tela sem criar saída | Manter e confirmar apenas se houver dados preenchidos | Cancelar vazio e preenchido |

## Movimentações

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Nova movimentação | Permite Entrada, Devolução e Retirada, duplicando outros fluxos | Manter apenas exceções permitidas | Permissões e impacto no saldo |
| Campo Usuário | Preenchimento manual não comprova autoria | Remover; obter do login | Criador e último alterador |
| Registrar | Pode criar entrada ou retirada sem documento de origem | Exigir tipo de exceção, motivo e resumo | Clique duplo e campos obrigatórios |
| Estornar | Correção auditável adequada | Exigir motivo, usuário e impacto | Estorno único e bloqueios dependentes |
| Excluir movimento | Destrói o histórico | Remover completamente | Confirmar inexistência em todos os perfis |
| Linha do movimento | Um item por linha fragmenta a operação | Agrupar por NF, retirada, inventário ou exceção | Expandir e abrir origem |

## Inventário

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Nome do responsável | Campo manual conflita com auditoria por login | Remover e registrar usuário autenticado | Nome, e-mail e registro antigo |
| Aplicar contagem como ajustes | Ajusta diretamente sem revisão intermediária visível | Criar resumo, recontagem e confirmação administrativa | Diferenças positivas, negativas e execução repetida |

## Equipamentos

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Cadastrar equipamento | Formulário aparece junto da listagem | Usar painel dedicado e validar patrimônio/série | Duplicidade e campos obrigatórios |
| Novo termo | Ação adequada ao controle patrimonial | Mostrar equipamento, recebedor, prazo e condição | Assinatura, PDF, devolução e vencimento |
| Colunas sem título | Ações e informações ficam sem referência | Nomear ou fornecer rótulo acessível | Leitor de tela e tooltip |

## Painel e Relatórios

| Comando atual | Observação | Comportamento recomendado | Teste obrigatório |
|---|---|---|---|
| Status de pagamento no Painel | Permite alteração no meio de uma tela analítica | Abrir a nota/fatura correspondente para editar | Permissão e confirmação |
| Exportar CSV | Sete botões com o mesmo nome | Informar o relatório no botão | Nome do arquivo, colunas, período e acentuação |

## Cenários transversais

1. Clicar duas vezes rapidamente na ação principal.
2. Perder conexão antes, durante e depois da confirmação.
3. Fechar pelo `X`, voltar e cancelar com dados preenchidos.
4. Executar como proprietário, administrador, engenheiro, campo e visualizador.
5. Repetir em 1440×900, 768×1024 e 390×844.
6. Navegar somente pelo teclado.
7. Confirmar foco visível, labels, tooltips e mensagens de erro.
8. Verificar que nenhum movimento, saldo ou material foi alterado durante testes cancelados.

