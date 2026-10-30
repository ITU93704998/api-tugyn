# Rotina diária, reservas de imagem e exclusão de conta (INF-01 a INF-04)

## INF-01: rotina diária (`GET /api/desafios`)

A Vercel chama a rotina 1x por dia (`vercel.json`: `10 15 * * *`, 12:10 em Brasília) com `Authorization: Bearer <CRON_SECRET>`. Cada etapa tem um prazo contado do início da chamada (`maxDuration` = 60 s). O que não couber fica na fila para a rodada seguinte.

| Etapa | Prazo | O que faz |
| --- | --- | --- |
| apuração (cálculo) | 30 s | Busca desafios vencidos (`status in [pendente, aceito]`, `apurarEm <= hora da rotina`), dos mais atrasados para os mais novos. Processa em lotes de 20 com cursor. **Não envia aviso**: o fechamento grava `reavisarPara: [a, b]` e `reavisarTentativas: 0` na mesma transação (outbox). |
| avisos (notificação) | 38 s | Envia a fila `reavisarTentativas in [0, 1, 2]` com cursor pelo id. Cada desafio é tentado uma vez por rodada, com no máximo 3 envios por pessoa. |
| exclusões de conta | 46 s | Termina os jobs de `exclusoesConta` (INF-04). |
| reservas de imagem | 52 s | Resolve as reservas vencidas de `midiaReservas` (INF-03). |
| push / recibos / recálculos | — | Recuperação da outbox de push, recibos do Expo e recálculos pendentes (já existiam). |

A apuração pedida pelo app (`POST apurar`) continua enviando o aviso na hora, para o outro participante.

**Resposta.** Sucesso parcial **não** sai como 200. A rotina responde `500 { success: false, parcial: true, problemas, ... }` e registra `desafios_rotina_incompleta` (nível erro) quando houver qualquer um destes casos:

- apuração que falhou;
- desafio em reconciliação;
- fila de apuração ou de avisos restante;
- atraso máximo acima de 48 h (`atraso_max_h:N`);
- etapa que lançou erro (`etapa_falhou:*`);
- exclusão pendente;
- reserva de imagem pendente;
- conta do Cloudinary sem credencial (`credencial_ausente_<bucket>`).

Tudo certo → `200` e o log `desafios_rotina` com as contagens, `atrasoMaxMs` e `duracaoMs`.

**Alertas sugeridos (nos logs da Vercel):**

- `desafios_rotina_incompleta`
- `desafios_rotina_falhou`
- `rotina_sem_cron_secret`
- `desafio_reconciliacao_pendente`
- `account_delete_stuck`
- `rotina_etapa_falhou`

### Checklist de produção

- [ ] **Plano da Vercel.** O cron precisa estar disponível no plano. A duração máxima precisa aceitar `maxDuration: 60`; no Hobby, o cron roda 1x por dia e o horário pode variar dentro da hora.
- [ ] **`CRON_SECRET`** nas variáveis de ambiente de *Production*, com 16+ caracteres. Sem ele a rotina responde 401 e loga `rotina_sem_cron_secret`.
- [ ] **Cron publicado.** Em Project → Settings → Cron Jobs deve aparecer `/api/desafios` com o horário acima, depois do deploy de produção. Confira no histórico de execuções se o status é 200 (500 = parcial, veja `problemas`).
- [ ] **Índice composto** `desafios (status ASC, apurarEm ASC)`, que está em `firestore.indexes.json`. Publique com `firebase deploy --only firestore:indexes`. As outras consultas usam índices simples:
  - `reavisarTentativas` e `__name__`;
  - `midiaReservas.expiraEm` e `midiaReservas.chave`;
  - `exclusoesConta` por `__name__`.

  Não desligue a indexação simples desses campos.
- [ ] **Credenciais do Cloudinary** de **todas** as contas com imagens de usuários:
  - `CLOUDINARY_{NAME,KEY,SECRET}_USUARIOS`
  - `CLOUDINARY_{NAME,KEY,SECRET}_TIMES`
  - `CLOUDINARY_{NAME,KEY,SECRET}_ARENAS`
  - `CLOUDINARY_{NAME,KEY,SECRET}_ANUNCIOS` (conta das turmas)

## INF-02: apuração do desafio do dia sem truncar

As partidas da turma na janela do dia são lidas **em páginas** de 100, até 5, dentro da mesma transação. Cada página pede 1 a mais para saber se existe a próxima (`lerEmPaginas`).

Se ainda houver partidas depois da 5ª página, o desafio **não é fechado** com uma soma parcial:

- ganha `reconciliacao: { motivo: "partidas_acima_do_limite", lidas, tentativas, em }`;
- `apurarEm` vai para +1 dia (volta à fila);
- o log `desafio_reconciliacao_pendente` sai em nível erro.

A apuração devolve o status `reconciliar`; o app trata como "nada" e o desafio continua aberto. Quando a apuração conseguir ler tudo, `reconciliacao` é apagado junto com o resultado. Para resolver um caso real, aumente `MAX_PAGINAS_DO_DIA` ou investigue a turma (500+ partidas em um dia indicam envio anormal).

## INF-03: troca de foto e banner com reserva (`midiaReservas/{id}`)

1. **Reserva** (`POST /api/upload`, numa transação). A API confere o prazo de 7 dias e o organizador no próprio documento-alvo e grava a reserva `{ chave, uid, tipo, turmaId, bucket, publicId, estado: "reservada", anterior, expiraEm: +10 min }`. Se outra troca do mesmo alvo estiver em andamento, a resposta é **409**.
2. **Envio** para um `public_id` **novo** (`tmp_…` na foto, `b_…` no banner), sem `overwrite` e sem `invalidate`: a imagem publicada não muda. Sucesso → `estado: "enviada"` e a resposta traz `reserva_id`. Falha → `estado: "falhou"` (vence na hora).
3. **Confirmação da foto** (`POST /api/upload { action: "confirmar", reservaId }`). Numa transação, confere a reserva (dona, enviada, no prazo) e o prazo de 7 dias. Grava `profileImage`, `profileImagePublicId` e `profileImageChangedAt` **no servidor** e marca a reserva como `confirmada`.
4. **Promoção.** Só depois da confirmação, a foto é copiada para o id fixo `usuarios/<uid>/profile/profile`, agora sim com `overwrite` e `invalidate`. As cópias da URL em turmas, partidas e desafios continuam valendo. A referência e o `photoURL` do Auth passam para o id fixo. O temporário fica 24 h e a rotina apaga.
5. **Rotina diária**, para cada reserva vencida:
   - referência apontando para o envio → foto: promove; banner: apaga o banner anterior;
   - sem referência → apaga o envio órfão no Cloudinary;
   - em todos os casos a reserva some ao final.

O banner (e o cadastro) continuam gravando a referência pelo app: as regras conferem o prazo, e a rotina conclui. Apps antigos (sem `reserva_id`) também continuam funcionando, porque a rotina promove o que estiver referenciado.

## INF-04: exclusão de conta em job durável (`exclusoesConta/{uid}`)

- **Lápide.** Gravada depois da checagem de organizador e **antes** de qualquer remoção. Guarda:
  - `estado`;
  - `closeOwnedTurmas`;
  - `desafios`: os pares `{ desafioId: adversário }`, lidos das vagas e dos documentos antes de apagar;
  - `etapas`, `rodadas` e `pendencias`.

  Enquanto existir, a exclusão não terminou. É **apagada** quando a verificação final passa.
- **`excluindo`.** O fluxo principal é idempotente: turmas, perfil, coleções extras (inclusive `midiaReservas`) e, por último, a conta do Auth. Parou no meio? A pessoa tenta de novo, ou a rotina retoma depois de 1 h sem atualização.
- **`pos_exclusao`.** Cada etapa tem estado e tentativas próprios, e a falha fica gravada (não só no log):
  - `avaliacoesDadas`
  - `vagasAdversarios`
  - `imagens`: todas as contas do Cloudinary. Uma conta sem credencial deixa a etapa **pendente** (`bucket_<x>_sem_credenciais`), em vez de dar sucesso.
- **Verificação final.** Procura restos em perfil, Auth, usernames, avaliações dadas e recebidas, desafios, vagas (dela e dos adversários), tokens de push e reservas. Resto principal → volta para `excluindo`; resto de uma etapa → reabre a etapa. Depois de 3 rodadas sem concluir, o log vira `account_delete_stuck` (nível erro).
- **Apagado:**
  - perfil e subcoleções;
  - usernames;
  - tokens e registros de push;
  - desafios (os dois lados);
  - avaliações dadas, que saem do resumo do avaliado;
  - avaliações recebidas;
  - vagas;
  - reservas de imagem;
  - turmas só dela;
  - todas as imagens.
- **Anonimizado** (histórico de outras pessoas):
  - nome em partidas;
  - participante das turmas que continuam ("Usuário removido", sem foto);
  - organizador das turmas encerradas.

## Regras do Firestore

`midiaReservas` e `exclusoesConta` não têm `match` nas regras: o app não lê nem escreve, só o Admin SDK. Não é preciso publicar regras para estas mudanças.
