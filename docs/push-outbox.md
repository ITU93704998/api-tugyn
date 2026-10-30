# NOT-01: reserva atômica e outbox de push

## Garantia e limite

`enviarAviso` agora reserva `pushDedupe/{dedupeKey}` em transação **antes** de consultar aparelhos e chamar o Expo. Cada ocorrência recebe `notificationId`, proprietário aleatório e lease de 60 segundos. O Expo é chamado fora da transação, pois o Firestore pode repetir o callback transacional.

Chamadas simultâneas com a mesma chave não ganham duas permissões de envio. O lease sozinho não resolve a janela após o envio: por isso o estado `sending` é persistido antes de chamar o transporte. Se a função cair nessa janela, um lease vencido em `sending` vira `uncertain`, sem reenvio automático. Um proprietário antigo que perdeu o lease enquanto preparava os tokens não pode iniciar o envio.

Isto não promete entrega exatamente uma vez. Um timeout pode significar que o Expo recebeu a mensagem, e o próprio provedor oferece semântica de pelo menos uma tentativa. A política escolhida prioriza evitar duplicação: casos ambíguos podem ficar sem notificação e exigem investigação. `accepted` e `enviados` significam aceitação inicial pelo Expo, não entrega no aparelho; o recibo é consultado depois (abaixo).

## NOT-03: recibos do Expo

Ticket `ok` só diz que o Expo aceitou a mensagem. O resultado da Apple/Google (token morto, credencial APNs/FCM inválida, mensagem grande demais) só aparece no **recibo**, consultado depois.

- Na mesma transação que confirma o lote, os ids dos tickets aceitos vão para `pushRecibos/{uuid}`: `{ tickets: { ticketId: hash do token }, outboxId (hash), enviadoEm, verificarApos, expiresAt }`. Sem token, UID, texto ou chave do aviso.
- `consultarRecibos` pega os lotes com `verificarApos` vencido (15 min após o envio, como a documentação do Expo sugere), reserva cada um por 5 min e chama `getReceipts`.
  - `DeviceNotRegistered`: apaga `pushTokens/{hash}`, a menos que o aparelho tenha se registrado de novo depois do envio (`updatedAt` maior que `enviadoEm`).
  - `InvalidCredentials` / `MismatchSenderId`: log `push_credenciais_invalidas` (nível erro). Exige ação humana: renovar a chave APNs ou a credencial FCM no Expo. O mesmo alerta sai quando o erro vem já no ticket.
  - Recibo ainda não pronto: volta para a fila em 15 min. Falha de transporte: idem.
  - Depois de 24 h do envio o Expo pode não ter mais o recibo: o lote é descartado e contado em `semRecibo`.
- Quem chama: `GET /api/push` (rotina protegida, junto com a recuperação da outbox) e o cron diário de desafios. **Como o recibo dura ~24 h, o cron diário alcança os avisos do dia anterior**, mas a limpeza de tokens fica até um dia atrasada; com um scheduler no `GET /api/push` a cada 15–30 min ela acontece no mesmo dia.
- Log `push_receipts`: contagens (`entregues`, `recusados`, `tokensRemovidos`, `aguardando`, `semRecibo`, `falhas`) e códigos de erro. Crie alerta para `push_credenciais_invalidas`.
- Recibo `ok` quer dizer que a Apple/Google aceitaram; não comprova que o aparelho exibiu nem que a pessoa leu.
- `pushRecibos` não tem regra nas regras do Firestore, então nenhum cliente lê ou escreve (só o Admin SDK). Ligue a política de TTL em `expiresAt` (3 dias) como em `pushDedupe`; a consulta usa o índice simples de `verificarApos`.

Referências: [transações do Firestore](https://firebase.google.com/docs/firestore/manage-data/transactions), [envio e tentativas no Expo](https://docs.expo.dev/push-notifications/sending-notifications/), [garantias do serviço Expo](https://docs.expo.dev/push-notifications/faq/).

## NOT-04: logout sem internet

Depois do logout não há login para autenticar o `remover`. Por isso:

- **Chave de revogação por cadastro.** `registrar` gera 32 bytes aleatórios, devolve ao app (`{ ok, revogacao }`) e guarda só o `revogacaoHash` em `pushTokens/{hash}`. Cada cadastro troca a chave: se o aparelho passou para outra conta, um pedido velho da conta anterior não apaga o cadastro novo.
- **`revogar { token, revogacao }` sem login** (com App Check e limite de 10/h por token). Apaga só se a chave confere (comparação em tempo constante) e sempre responde `{ ok: true }`, sem revelar se apagou.
- **Fila durável no app** (`@tugyn:push:revogar`, por aparelho e não por conta). O app grava o pedido ANTES de usar a rede ao sair da conta ou desligar os avisos. A fila é enviada quando o login fica conhecido, quando a internet volta e quando o app volta ao primeiro plano. Cadastros locais de contas que não estão mais logadas (sessão encerrada sem "Sair") também entram na fila.
- **Lease no servidor.** Token sem `updatedAt` renovado há 30 dias não recebe avisos (o app renova a cada 7 dias de uso). `expiresAt` = 60 dias: ligue a política de TTL nesse campo de `pushTokens`.
- **Limites:** a revogação offline não é instantânea; até a fila ser enviada (ou o lease vencer), avisos da conta anterior ainda podem chegar à tela bloqueada. Cadastros feitos por versões antigas do app não têm chave; eles ficam cobertos só pelo lease até o app novo renovar o cadastro (no próximo uso, o app novo recadastra para obter a chave).

## Estados e recuperação

| Estado | Conduta |
| --- | --- |
| `leased` | Preparação sem envio iniciado. Após 60 s, outro trabalhador pode assumir. |
| `sending` | O envio pode ter iniciado. Lease vencido vira `uncertain`; não reenvia às cegas. |
| `pending` | Falha anterior ao transporte ou rejeição explicitamente transitória. Aguarda nova tentativa. |
| `done` | Dispositivos processados; aceitos não são enviados novamente na janela. |
| `uncertain` | Resultado ambíguo. Fora da fila automática, mesmo após a janela de deduplicação. |
| `failed` | Rejeição definitiva ou limite de tentativas atingido. |
| `expired` | Prazo do evento vencido antes de uma tentativa segura. Não envia um aviso atrasado. |

Resultados por aparelho usam apenas IDs hash de tokens no documento. A lista de dispositivos fica congelada na primeira tentativa. Sucessos já confirmados não são reenviados ao recuperar falhas parciais; tokens removidos deixam de ser candidatos. O payload e os destinatários ficam armazenados no documento protegido para permitir recuperação, mas nunca são devolvidos pelo endpoint público ou escritos nos logs.

Rejeições HTTP 429/5xx e `MessageRateExceeded` permitem até três tentativas por aparelho, com backoff de 30 e 60 segundos. Timeout, exceção de transporte ou ausência de ticket são ambíguos. Uma falha durante consulta de tokens ocorre antes do transporte e pode ser repetida com segurança.

A validade da recuperação é o menor valor entre a janela de deduplicação do aviso e 24 horas. Os registros mantêm `expiresAt` por 30 dias, compatível com o TTL existente. Documentos antigos contendo somente `at` continuam respeitando sua janela. Não há migração em massa nem mudança nos formatos enviados pelo app.

## Operação

- `GET /api/push` recupera até dez registros vencidos em `nextAttemptAt`, com no máximo três trabalhos concorrentes e orçamento de 40 segundos.
- Exige `Authorization: Bearer <CRON_SECRET>` com segredo de pelo menos 16 caracteres. Token Firebase de usuário, inclusive administrador, não concede acesso a essa rotina.
- A consulta usa apenas o índice simples de `nextAttemptAt`; mantenha a indexação desse campo habilitada.
- O cron diário de desafios já existente também recupera até três registros, sem criar outra função Vercel ou um agendamento que exija outro plano.
- **O cron atual continua diário.** Para recuperação em poucos minutos, um scheduler deve chamar o GET protegido com frequência compatível com o plano de hospedagem. Sem isso, uma pendência curta pode expirar antes da execução diária. Não foi contratado ou configurado serviço externo nesta alteração.
- A resposta de recuperação contém somente contagens. A rota é `no-store` e não aceita destinatários ou payload fornecidos no GET.
- Regras Firestore devem impedir clientes de escrever/ler livremente `pushDedupe`. O Admin SDK opera pelo servidor. As regras publicadas não são alteradas por este patch.

## Monitoramento da janela de envio

`dispatchStartedAt`, `leaseUntil`, `updatedAt`, `notificationId`, `state` e resultados por hash permitem investigar cada ocorrência no Firestore. São registrados eventos JSON sem token, nome, corpo, UID ou chave composta:

- `push_outbox_dispatch`: quantidade, duração do lease e idade do evento antes do envio.
- `push_outbox_checkpoint`: aceitos, pendências, falhas definitivas, casos ambíguos e códigos conhecidos de erro.
- `push_outbox_confirmation_failed` / `push_outbox_confirmation_lost`: Expo pode ter aceitado sem confirmação durável.
- `push_outbox_uncertain`: exige investigação; pode representar ausência de entrega ou envio já aceito.
- `push_outbox_preparation_failed`, `push_outbox_recovery_failed` e `push_token_cleanup_failed`: falhas operacionais sem dados sensíveis.

Crie alertas na plataforma de logs para confirmações perdidas e casos ambíguos, e acompanhe idade das pendências e eventos expirados. O código emite os sinais; nenhum alerta externo foi provisionado nesta tarefa. Uma confirmação tardia do mesmo proprietário pode resolver `uncertain` se não houve substituição da ocorrência.

Não apague nem reenfileire automaticamente um registro `uncertain`. Primeiro investigue `notificationId` e horário de dispatch. Um reenvio manual assume explicitamente o risco de duplicação; não foi criado um endpoint público para isso.

## Validação e publicação

Testes de unidade cobrem concorrência, fencing de lease, falha na reserva, falha entre aceitação e checkpoint, recuperação, falha parcial, backoff, compatibilidade com registros antigos e autenticação da rotina. O teste `tests-emulador/push-outbox.emulador.cjs` usa transações reais em projeto `demo-push-outbox`, transporte Expo falso e exige emulador local. Nunca envia notificações reais nem acessa banco de produção.

Publique a API para ativar a correção. App e painel não precisam de atualização para essa mudança. Evite misturar trabalhadores antigos com novos durante a troca de versão: a implementação antiga não conhece o protocolo de reserva. Configure o `CRON_SECRET` e, para recuperação rápida, o scheduler protegido; verifique também regras, índice simples e TTL já existentes no ambiente de produção.

Esta outbox começa na entrada de `enviarAviso`. Ela não transforma em uma transação única a gravação de toda ação de negócio e a criação da notificação: uma queda entre essas duas etapas ainda pode perder o aviso. Vincular a criação da outbox às transações de negócio de cada ação é uma melhoria separada. Nenhum registro de produção foi alterado ou push real enviado durante os testes.
