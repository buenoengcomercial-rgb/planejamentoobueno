# Cronograma do Aditivo: linha de base de desempenho

## Medição operacional de 04/11/2026

Na obra Palácio Rio Madeira, a aba publicada foi aberta a partir do Dashboard em uma sessão Chrome autenticada, sem modificar dados. Três navegações sucessivas, no mesmo navegador, levaram **3.175 ms, 1.640 ms e 2.418 ms** entre o clique no menu e a disponibilidade do título do Cronograma do Aditivo. A grade estava presente ao conferir a tela após cada navegação.

Esses tempos incluem interação do navegador e montagem da interface. São uma referência de navegação com cache aquecido; não isolam rede, hidratação, cálculo ou renderização. Não houve edição de data nem gravação de teste nesta medição.

## Diagnósticos adicionados

O navegador mantém no máximo 100 eventos em `sessionStorage` sob `obraplanner:sync-diagnostics:v1`. Os eventos `area: "additiveSchedule"` registram somente tempos, contagens, tamanhos e resultado, sem ID, nome, data ou conteúdo da obra:

| Operação | Tempo medido |
| --- | --- |
| `load` | Conferência de versão, leitura e conciliação quando a aba precisa hidratar coleções |
| `settle` | Conciliação do rascunho com dependências ao receber o projeto |
| `preview` | Construção da prévia do planejamento |
| `rows` | Montagem das linhas de análise |
| `forecast` | Previsão financeira |
| `dependency` | Propagação de dependências após editar no Gantt |
| `merge` | Conversão da prévia editada para o rascunho do aditivo |
| `prepare` | Preparação e proteção local da transação, com tamanho do pedido |
| `rpc` | Espera pela resposta da nuvem, com tamanho da resposta |
| `receipt` | Validação e aplicação do recibo |
| `save` | Clique em “Salvar agora” até a conclusão da tentativa |

Para consultar os eventos na mesma aba, use o Console do navegador:

```js
JSON.parse(sessionStorage.getItem('obraplanner:sync-diagnostics:v1') || '[]')
  .filter(event => event.area === 'additiveSchedule')
```

## Próxima leitura

Após publicar esta instrumentação, medir uma alteração temporária e reversível de data, confirmar o recibo, restaurar a data e confirmar a restauração. Comparar `dependency`, `merge`, `preview`, `rows`, `prepare`, `rpc` e `receipt` para escolher o primeiro recálculo ou acesso ao banco a otimizar. Não comparar a soma dos eventos com o tempo total de tela: renderização, debounce e espera por interação são etapas separadas.
