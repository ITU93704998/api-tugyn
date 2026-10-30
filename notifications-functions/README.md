# NOT-02 e NOT-05 — notificações de turma no servidor

Este módulo fica inteiramente em uma pasta nova, `notifications-functions/`. Nenhum arquivo existente do app, API, regras, configuração Vercel ou testes compartilhados foi editado por esta correção. O código atual de `api/_lib/pushEnvio.ts`, incluindo recibos e revogação de tokens, é importado como dependência de leitura e compilado junto das funções.

## Comportamento

| Gravação observada | Notificação |
| --- | --- |
| Participante entra em `pendente` | Organizador recebe pedido de entrada. |
| Participante passa de `pendente` para `aprovado` | Participante aprovado é avisado. |
| Documento da partida de hoje é criado aberto | Membros recebem; organizador é excluído. |
| Nova confirmação é adicionada à partida aberta | Organizador recebe; sua própria confirmação é excluída. |

Alterações de nome, foto e estatísticas não geram avisos. Reabertura de um documento já existente, retirada de presença, turma encerrada e eventos de dias anteriores são ignorados. O estado atual é consultado antes de preparar o aviso; uma solicitação já processada ou presença já retirada pode tornar o evento antigo obsoleto.

O app mantém suas chamadas antigas por compatibilidade, mas elas deixam de ser necessárias para criar esses avisos **depois da implantação dos gatilhos**. O fluxo é:

1. A gravação original no Firestore gera um evento de plataforma, independentemente de o aplicativo continuar aberto.
2. O gatilho analisa a transição e cria, na mesma transação, o registro `turmaPushEvents/{hash}` e a reserva na outbox `pushDedupe/{chaveExistente}`.
3. O gatilho de criação da fila chama o consumidor existente da API. O registro fica pendente enquanto houver falhas transitórias.
4. Um worker a cada minuto retoma registros pendentes. Ele também recupera até três reservas vencidas da outbox geral da API, incluindo avisos de desafios que não têm um registro de evento de turma. Cada registro de turma está vinculado ao `notificationId` original: uma repetição antiga não inicia uma nova ocorrência depois da janela de deduplicação.

Os gatilhos usam `retry: true`. O hash inclui origem, ID do evento, tipo e pessoa; entregas repetidas não criam outra fila. As chaves de negócio são as mesmas da API atual, evitando duplicação entre gatilho e chamada antiga do cliente. Uma reserva já criada pelo cliente é reaproveitada, nunca zerada. O adaptador de esquema 1 está em `src/outbox.ts`; os testes exercitam o consumidor real da API e protegem essa compatibilidade.

## NOT-02: falhas parciais

O consumidor compartilhado já mantém `outcomes` e `tries` por hash de token. Os testes novos comprovam que um aparelho aceito não é reenviado enquanto outro aguarda retry, inclusive em aviso para vários membros. `DeviceNotRegistered` remove o token; falhas permanentes e casos ambíguos não são repetidos automaticamente. O worker novo torna a recuperação desses eventos independente de uma nova ação do cliente.

As tentativas e o backoff seguem a implementação existente da API, sem alterar o trabalho paralelo: até três tentativas, espera de 30/60 segundos e prazo de recuperação limitado pela janela de cada aviso. Se a reserva estiver em envio ou aguardando backoff, o registro de evento permanece na fila. Sucesso de parte dos aparelhos nunca é interpretado como conclusão de todo o registro.

## Ativação

O código foi preparado e testado localmente. **Nenhuma função, segredo, plano de cobrança ou dado de produção foi alterado.** Para ativar no ambiente real, este módulo precisa ser implantado no mesmo projeto Firebase do Firestore. Cloud Functions requer plano Blaze; o worker utiliza também Cloud Scheduler. Não é necessário publicar uma atualização do app para começar a capturar as gravações feitas por versões existentes.

Na pasta `notifications-functions`:

```powershell
npm ci
npm test
npm run build
```

Configure `TUGYN_PUSH_REGION` no `.env.<ID_DO_PROJETO>` conforme a região do Firestore (padrão do código: `southamerica-east1`). Configure `EXPO_ACCESS_TOKEN` no Secret Manager do projeto, usando o mesmo valor do projeto Expo utilizado pela API:

```powershell
firebase functions:secrets:set EXPO_ACCESS_TOKEN --project ID_DO_PROJETO
firebase deploy --config firebase.json --only functions:turma-notifications --project ID_DO_PROJETO
```

Os comandos acima são instruções; não foram executados nesta tarefa. O segredo é solicitado pelo CLI e não deve ser colocado no app nem no Git. O `firebase.json` próprio usa um codebase separado, `turma-notifications`; não contém regras, hosting ou a configuração do projeto da outra IA. Verifique que esse nome ainda não identifica outro codebase no ambiente de destino antes de implantar.

O build local gera, dentro de `lib/`, o módulo e as dependências compartilhadas da API. O ambiente de deploy recebe esses artefatos compilados; `gcp-build` apenas verifica sua presença, sem depender de arquivos externos à pasta enviada. `node_modules` e `lib` ficam fora do Git e são reconstruídos pelo fluxo de instalação/build. O runtime declarado é Node.js 22.

## Regras, retenção e custos

`turmaPushEvents` deve ser inacessível a clientes; apenas Admin SDK escreve e lê a fila. Existe um fragmento de regra nesta pasta para revisão, mas nenhuma regra existente foi modificada ou publicada. Um `allow` amplo em outro `match` pode conceder acesso mesmo com um bloqueio específico. Confirme também a proteção já existente de `pushDedupe`, `pushTokens` e `pushRecibos`.

Ative TTL em `turmaPushEvents.expiresAt`, com retenção de 30 dias. A fila usa consulta por um único campo, `state == queued`, limitada a 30 registros por ciclo e três trabalhos concorrentes. A recuperação geral consulta até três reservas por `nextAttemptAt`, usando o consumidor existente e respeitando seu lease. São duas consultas por ciclo, além das execuções de funções, scheduler e transações necessárias aos registros encontrados. A limitação de instâncias reduz concorrência; ela não é um limite financeiro. Os índices simples padrão são suficientes para a consulta nova.

Eventos entregues fora de ordem são filtrados pelo estado atual. Em indisponibilidade prolongada, o prazo da plataforma ou o prazo da outbox pode expirar. A implantação não reconstitui transições antigas já concluídas antes dos gatilhos existirem. Timeout depois de um possível envio continua sujeito à política `uncertain` do NOT-01: não existe promessa de entrega exatamente uma vez.

## Testes e isolamento

`npm test` usa banco e transporte simulados. Cobre dois aparelhos, vários destinatários, limpeza de token inválido, chamadas concorrentes, compatibilidade com o cliente antigo, atomicidade de fila/reserva, falha antes do reconhecimento e repetição posterior à janela de deduplicação.

`tests/emulator.cjs` exige `FIRESTORE_EMULATOR_HOST` local e usa exclusivamente `demo-turma-notifications`. Exercita os callbacks reais exportados pelas Cloud Functions com snapshots e transações reais do emulador; a entrega Eventarc é simulada pela chamada aos callbacks. Todas as chamadas Expo são interceptadas por um transporte falso. Não testa entrega real de push, configuração IAM/Secret Manager nem o serviço Eventarc publicado. Usa dados próprios com nomes aleatórios e remove apenas seus registros e recibos.

Exemplo com emulador Firestore local iniciado na porta 8797:

```powershell
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8797"
npm run test:emulator
```

Não use esse script sem o emulador; ele bloqueia endpoints remotos. As alterações feitas pela outra IA nos arquivos compartilhados são consumidas na próxima compilação, sem sobrescrevê-las. Rode os testes antes de cada deploy; o predeploy também os executa.

Referências oficiais: [gatilhos Firestore e entrega repetida](https://firebase.google.com/docs/functions/firestore-events), [retry de eventos](https://firebase.google.com/docs/functions/retries), [worker agendado](https://firebase.google.com/docs/functions/schedule-functions), [requisitos de implantação e Blaze](https://firebase.google.com/docs/functions/get-started?gen=2nd).
