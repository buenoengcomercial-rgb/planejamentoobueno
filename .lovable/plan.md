# Aperfeiçoar a confirmação de retiradas do Almoxarifado

## Diagnóstico confirmado

- **“A confirmação segura ainda não está disponível”**: o problema está solucionado no ambiente atual. As quatro funções necessárias existem no servidor e estão liberadas para usuários autenticados. Nesta obra já existem **94 retiradas confirmadas**, a mais recente em **30/09/2026 às 20:33 UTC**, e a versão do Almoxarifado chegou a **195**.
- **“O saldo mudou antes da confirmação”**: não é perda de dados; é a proteção contra saldo negativo funcionando. A transação bloqueia a retirada inteira quando outro usuário altera o mesmo material antes da confirmação. Nada é parcialmente gravado e nenhum PDF é liberado.
- Há, porém, um ponto que pode aumentar a frequência do segundo aviso: o registro recente mostra o canal de atualização em tempo real encerrado (`CLOSED`). Assim, a tela pode continuar exibindo um saldo antigo até a confirmação final recusá-lo.

## Melhorias propostas

### 1. Recuperação automática da atualização em tempo real
- Reconectar automaticamente o canal da obra quando ele for encerrado.
- Enquanto a conexão não voltar, fazer uma conferência periódica leve da versão do Almoxarifado.
- Ao detectar versão nova, atualizar apenas estoque, movimentos e requisições, sem recarregar a página inteira.
- Mostrar um indicador discreto: **Atualizado**, **Reconectando** ou **Dados podem estar desatualizados**.

### 2. Transformar conflito de saldo em correção guiada
- Preservar todo o formulário, assinatura e fotos quando o saldo mudar.
- Buscar imediatamente o saldo atual após a recusa.
- Destacar somente os materiais afetados, exibindo **solicitado**, **saldo anterior**, **saldo atual** e **quantidade máxima disponível**.
- Oferecer uma ação clara para ajustar as quantidades ao saldo atual e confirmar novamente.
- Não exigir atualização manual da página.

### 3. Verificação preventiva antes da entrega
- Manter a consulta antecipada já existente e reforçá-la ao retornar à aba ou após uma reconexão.
- Bloquear a confirmação enquanto a conferência estiver desatualizada ou em andamento.
- Diferenciar claramente falta real de estoque, falha de conexão e alteração feita por outro usuário.

### 4. Disponibilidade da confirmação segura
- Executar uma verificação leve das funções necessárias ao abrir o Almoxarifado.
- Se alguma função estiver ausente, desabilitar somente as ações críticas e mostrar indisponibilidade temporária antes do preenchimento.
- Incorporar o verificador já existente à validação de cada Preview, impedindo uma publicação incompatível entre tela e servidor.

### 5. Confirmação e PDF
- Manter o PDF disponível somente para retiradas devolvidas como confirmadas pelo servidor.
- Exibir número da requisição, horário e responsável logo após a confirmação.
- Em resposta incerta, reutilizar a mesma tentativa para consultar o servidor, evitando duplicidade; só liberar o PDF após localizar a confirmação.

### 6. Aperfeiçoar cancelamento de retirada
- Manter o cancelamento como **estorno auditado**, sem apagar a retirada, a assinatura, os movimentos ou o responsável original.
- Antes de cancelar, apresentar um resumo com requisição, materiais, quantidades retiradas, quantidades já devolvidas e saldo que retornará ao estoque.
- Exigir motivo e confirmação da situação física; deixar explícito que somente materiais realmente disponíveis voltam ao saldo.
- Separar os casos: **retirada não aconteceu**, **retirada parcial**, **lançamento duplicado** e **outro motivo**, mantendo campo complementar obrigatório quando necessário.
- Quando já houver devolução, calcular e devolver somente a quantidade ainda em campo; nunca recompor o que já retornou anteriormente.
- Bloquear o cancelamento se outro usuário tiver corrigido, devolvido ou cancelado a retirada enquanto a janela estava aberta; atualizar os dados e permitir nova revisão sem perder o motivo digitado.
- Após confirmar, retirar o registro da lista ativa, mantê-lo na aba **Canceladas** e mostrar quem cancelou, quando, por quê e quanto foi recomposto por material.
- Permitir gerar um comprovante de cancelamento somente após a confirmação do servidor, com referência à retirada original e ao histórico de devoluções.
- Não permitir “desfazer cancelamento” diretamente. Uma eventual reversão deverá ser uma nova operação auditada, nunca alteração silenciosa do histórico.
- Melhorar o texto da confirmação final para evitar que “cancelar registro” seja confundido com exclusão definitiva.

## Validação

- Simular dois usuários retirando simultaneamente o mesmo material: uma operação confirma e a outra recebe o novo saldo, sem baixa parcial.
- Interromper e restaurar a atualização em tempo real: a tela reconecta e recupera o saldo sem recarregar a página.
- Simular perda da resposta depois da gravação: a repetição encontra a confirmação existente e não duplica a retirada.
- Simular função indisponível: o usuário é avisado antes da entrega e nenhum PDF é gerado.
- Cancelar retirada integral, parcial e com devolução anterior: conferir recomposição exata do saldo e preservação do histórico.
- Simular dois usuários cancelando ou alterando a mesma retirada: somente a primeira versão é aceita e a segunda recebe os dados atuais para revisão.
- Confirmar que usuários sem permissão não veem nem executam o cancelamento.
- Validar o fluxo completo no computador e no celular, incluindo assinatura, fotos, conflito, nova confirmação e PDF.

## Limites

- Não alterar fórmulas de estoque, permissões, histórico, numeração ou regras de retirada.
- Não apagar nem corrigir dados existentes automaticamente.
- Trabalhar primeiro no Preview; publicação em produção somente após autorização.
