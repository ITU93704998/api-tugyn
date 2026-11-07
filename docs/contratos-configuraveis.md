# Contratos configuráveis — Tugyn ADS

## Onde configurar

Menu **Tugyn ADS → Configuração do contrato**, rota `/configuracao-contrato`.

1. Preencha a identificação da empresa, a data da versão e os horários de atendimento (Brasília).
2. Defina os prazos e as políticas comerciais. Os prazos são cláusulas do documento; não disparam reembolsos/cancelamentos automáticos nem substituem a antecedência e a validade dos links em **Preços e pagamento**.
3. Edite o modelo ou importe um arquivo `.txt` em UTF-8. Os campos `{{cnpj}}`, `{{razao_social}}`, `{{analise_horas}}` e demais campos listados na página são substituídos no servidor. Os dados do cliente e do pedido vêm do próprio pedido, nunca de valores enviados pelo navegador para gerar o PDF.
4. **Salvar rascunho** não altera a versão vista por clientes.
5. Use **Gerar prévia PDF**, abra o documento e confira as informações. A prévia contém um cliente fictício e não é publicada nem enviada ao Cloudinary.
6. Confirme a revisão e clique em **Publicar nova versão**. O servidor exige os dados completos, prazos válidos, HTTPS, data/horário válidos e campos conhecidos no modelo.

O modelo inicial é editável e deve ser revisado pela empresa antes da primeira publicação. Dados cadastrais e políticas comerciais ficam vazios de propósito. Não existe uma empresa fictícia publicada automaticamente.

## Arquivo PDF já finalizado

O bloco **PDF pronto — sem preenchimento automático** conserva o upload anterior de PDF. Um PDF comum não recebe os campos da configuração. Publicá-lo passa a usá-lo como documento fixo para novos documentos, mantendo os documentos congelados dos pedidos anteriores. Para preenchimento automático, use o modelo editável/TXT.

## Fluxo do cliente

Para o novo modelo configurável: confirmar pedido → preparar/abrir PDF preenchido → concordar → aceitar → acessar pagamento → enviar comprovante → pagamento confirmado → enviar material → análise/aprovação.

O aceite usa o hash exato do PDF preparado, sua versão e o registro de abertura. O servidor não aceita um hash de outro arquivo. O painel abre a cópia preenchida daquele cliente no botão **Ver contrato aceito (PDF)**. Mudar o pedido antes do pagamento arquiva o aceite anterior na subcoleção `aceites` do pedido e invalida o documento e o aceite desse pedido; o cliente precisa ler e aceitar o novo documento. Os contratos com PDF fixo mantêm o fluxo legado de aceite ao enviar o anúncio, e a API permite consultar o documento antes de pagar.

O PDF preenchido é gerado uma única vez por pedido aberto e fica privado no Cloudinary. Aberturas seguintes geram apenas um endereço temporário (5 minutos), sem nova geração ou upload. Se duas aberturas gerarem arquivos simultaneamente, só uma cópia é conservada; a perdedora é removida em melhor esforço. O modelo fica congelado na abertura, inclusive se uma versão nova for publicada antes do aceite. Depois do aceite, novas publicações não modificam o PDF, o hash nem as condições daquele pedido.

## Segurança e armazenamento

- Todas as operações administrativas usam `POST /api/contratos`, com Firebase ID token, claim `admin` e o rate limit existente. Não foi criada uma nova função Vercel.
- `adsConfig/contratoConfiguracao`: rascunho, revisão, autor e data de atualização/publicação. A revisão impede sobreposição silenciosa entre administradores.
- `adsConfig/contratoModelo`: versão atual, PDF de exemplo e fonte configurável.
- `adsContratoVersoes/{numero}`: arquivo das versões publicadas, sem limite rotativo de 20 versões. O histórico legado que ainda está disponível é migrado nas próximas publicações.
- Documento do pedido: `documentoContrato` contém a referência privada e o hash da cópia preenchida. `aceite` conserva a prova do aceite. Referências privadas e dados internos não entram na resposta pública de visualização.
- O navegador não grava essas configurações diretamente no Firestore. As novas coleções só são acessadas pela API. Não é necessário liberar leitura pública nas regras.
- Não excluir manualmente PDFs aceitos, arquivos das versões ou seus registros. Se uma versão legada já tinha saído do histórico antes desta implementação e não estava arquivada, esta mudança não recupera o arquivo automaticamente.
- O renderer não executa HTML/scripts, não acessa URLs dos campos e não baixa fontes. Suporta texto latino com acentos, até 40.000 caracteres no modelo e até 35 páginas. Emojis/caracteres incompatíveis são recusados explicitamente.

## Publicação do código

1. Na API: `npm ci`, `npm run check`, `vercel --prod`.
2. No painel: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `vercel --prod`.
3. Depois do deploy da API e do painel, configure e publique a primeira versão na página administrativa.

Dependência adicionada à API: `pdf-lib` 1.17.1 (versão fixada no package-lock). São usadas as mesmas credenciais Cloudinary dos contratos/comprovantes: `CLOUDINARY_NAME_ANUNCIOS`, `CLOUDINARY_KEY_ANUNCIOS`, `CLOUDINARY_SECRET_ANUNCIOS`. Nenhuma variável nova e nenhuma nova build do app são necessárias.

Nenhum deploy, configuração real, aceite real ou documento de cliente foi alterado durante a implementação/testes. Os testes usam Firestore/Cloudinary simulados.
