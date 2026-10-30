# Limitador de requisições (FIR-03)

`api/_lib/rateLimit.ts` → `dentroDoLimite(chave, acao, maximo, janelaSegundos)`.

## Ordem de decisão

1. **Memória da instância**: chave (ação + usuário + janela) já negada nesta instância e a janela não acabou → nega sem
   nenhuma chamada. Só economiza: quem decide continua sendo o contador (outra instância consulta normalmente).
2. **Upstash Redis** (`INCR` + `EXPIRE`), com timeout de **800 ms** (`UPSTASH_TIMEOUT_MS`). Redis lento ou fora → passo 3.
3. **Fallback Firestore** (`apiRateLimits/{hash}`, transação). Quem já estourou a janela é negado **só com a leitura**,
   sem escrita.
4. Upstash e Firestore falhando → **nega** (fail-closed, como antes).

Testes: `tests/rate-limit.test.cjs` (negado sem escrita, negado em memória sem leitura, Redis lento cai no fallback,
tudo fora nega).

## Limite de borda (configurar no painel da Vercel)

O limitador acima roda **dentro** da função: cada tentativa ainda abre uma invocação. Para abuso em volume, configure
em *Vercel → projeto → Firewall*:

- **Rate limiting** por IP nas rotas `/api/*` (ex.: 120 requisições/min por IP; `/api/push` e `/api/turma-gestao` podem
  ter regra própria mais baixa). Ação: *Deny* ou *Challenge* (o app não resolve desafio de navegador: prefira *Deny*
  com 429 para as rotas do app).
- **Attack Challenge Mode** para ligar durante um ataque.
- As rotinas (`GET /api/desafios`, `GET /api/push`, `GET /api/turma-gestao`) usam `CRON_SECRET`; deixe-as fora da regra
  por IP ou com limite alto.

Nada disso foi configurado por este código; disponibilidade e limites dependem do plano da Vercel.
