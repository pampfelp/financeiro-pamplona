/**
 * Financeiro Pamplona — Apps Script mínimo, usado SÓ como proxy de segredos
 * pra integração de Open Finance (Pluggy). NÃO é o banco de dados deste
 * sistema (isso é o Firestore) e NÃO guarda nenhum dado de negócio — só
 * repassa 3 chamadas de LEITURA pra API da Pluggy, usando credenciais que
 * ficam nas Script Properties (nunca em texto puro neste arquivo).
 *
 * Por que este arquivo existe: o clientId/clientSecret da Pluggy nunca
 * podem aparecer no app.js/index.html, porque esses arquivos são públicos
 * (qualquer um vê o código-fonte pelo navegador). O Apps Script roda no
 * servidor do Google, então é o único lugar seguro pra guardar esse segredo
 * neste projeto (mesma ideia do upload de fotos pro Drive noutros projetos
 * do padrão, só que aqui é só um proxy de API, não grava nada em disco).
 *
 * ESCOPO — SÓ LEITURA: as 3 ações abaixo (connectToken, listAccounts,
 * listTransactions) só LEEM dados da Pluggy. Não existe, e não deve ser
 * adicionada, nenhuma ação que inicie pagamento, transferência, PIX ou
 * qualquer outra escrita que mexa em dinheiro de verdade.
 *
 * WEBHOOK: existe um recebedor mínimo (acaoWebhook_) só pra satisfazer a
 * exigência da Pluggy de ter um endpoint registrado pra liberar acesso de
 * produção (bancos reais). Ele só confirma o recebimento rapidinho — não
 * processa nem grava nada, porque a sincronização deste app já acontece
 * sozinha quando alguém abre a tela (mais o botão manual "Sincronizar
 * agora"). Registre esta MESMA URL do "/exec" como webhook no painel da
 * Pluggy, cobrindo os eventos: item/created, item/updated,
 * transactions/created, transactions/updated, transactions/deleted (ou
 * "all").
 *
 * COMO USAR:
 * 1. Crie uma planilha Google Sheets em branco, só para servir de "casa"
 *    pro script (o conteúdo dela não importa).
 * 2. Menu Extensões > Apps Script.
 * 3. Apague o conteúdo padrão e cole TODO este arquivo.
 * 4. Menu ⚙️ Configurações do projeto (ou Project Settings) > Script
 *    Properties > "Add script property" > adicione duas:
 *      PLUGGY_CLIENT_ID     = (Client ID copiado do console.pluggy.ai)
 *      PLUGGY_CLIENT_SECRET = (Client Secret copiado do console.pluggy.ai)
 *    NUNCA escreva esses valores direto neste arquivo.
 * 5. Menu Implantar > Nova implantação > tipo "Aplicativo da Web".
 *    - Executar como: Eu (seu e-mail)
 *    - Quem pode acessar: Qualquer pessoa
 *    Copie a URL "/exec" gerada.
 * 6. Cole essa URL na constante PLUGGY_PROXY_URL, em firebase-init.js.
 * 7. Toda vez que editar este arquivo, é preciso fazer uma NOVA implantação
 *    (ou "Gerenciar implantações > editar > Nova versão") pra que a URL
 *    publicada reflita o código novo — só salvar não é suficiente.
 */

var PLUGGY_API_BASE = "https://api.pluggy.ai";

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return json_(rotear_(body));
}

function rotear_(body) {
  try {
    // Notificação de webhook da Pluggy vem com "event" (ex: "item/updated"),
    // nunca com "action" — trata antes do switch pra não cair no "ação
    // desconhecida" quando a Pluggy testar/disparar o webhook.
    if (body.event) return acaoWebhook_(body);
    switch (body.action) {
      case "connectToken": return acaoConnectToken_();
      case "listAccounts": return acaoListAccounts_(body.itemId);
      case "listTransactions": return acaoListTransactions_(body.accountId, body.from, body.to);
      default: return { ok: false, erro: "Ação desconhecida: " + body.action };
    }
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

// Recebedor mínimo de webhook — só confirma recebimento (a Pluggy exige
// resposta 2XX em até 5s). De propósito não faz mais nada: nenhuma escrita
// no Firestore, nenhum processamento de evento. Ver o comentário no topo
// do arquivo pro porquê.
function acaoWebhook_(body) {
  return { received: true };
}

// ══════════════ AÇÕES (todas só-leitura) ══════════════

// Gera um connectToken de curta duração pro widget "Pluggy Connect" no
// frontend — é esse token (não o apiKey, não o clientSecret) que o
// navegador do usuário recebe. O widget cuida da tela de login do banco
// dentro do iframe da própria Pluggy; este script nunca vê usuário/senha
// de banco nenhum.
function acaoConnectToken_() {
  var apiKey = obterApiKeyPluggy_();
  var resp = UrlFetchApp.fetch(PLUGGY_API_BASE + "/connect_token", {
    method: "post",
    contentType: "application/json",
    headers: { "X-API-KEY": apiKey },
    payload: JSON.stringify({}),
    muteHttpExceptions: true
  });
  var dados = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() >= 300) {
    return { ok: false, erro: dados.message || "Falha ao gerar connectToken." };
  }
  return { ok: true, connectToken: dados.accessToken };
}

// Lista as contas de um "item" (uma instituição já conectada pelo usuário
// via widget). Só leitura — nunca movimenta nada.
function acaoListAccounts_(itemId) {
  if (!itemId) return { ok: false, erro: "itemId é obrigatório." };
  var apiKey = obterApiKeyPluggy_();
  var resp = UrlFetchApp.fetch(PLUGGY_API_BASE + "/accounts?itemId=" + encodeURIComponent(itemId), {
    method: "get",
    headers: { "X-API-KEY": apiKey },
    muteHttpExceptions: true
  });
  var dados = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() >= 300) {
    return { ok: false, erro: dados.message || "Falha ao listar contas." };
  }
  return { ok: true, accounts: dados.results || [] };
}

// Lista transações de uma conta num período usando /v2/transactions —
// o endpoint antigo (/transactions, paginação por número de página) foi
// descontinuado pela Pluggy em favor de paginação por cursor: cada resposta
// devolve "next" (uma URL com um parâmetro "after") em vez de "totalPages";
// a página seguinte é pedida repassando esse "after" até "next" vir null.
// Só leitura — importar essas transações pro Firestore é feito pelo
// app.js, nunca por este script.
function acaoListTransactions_(accountId, from, to) {
  if (!accountId) return { ok: false, erro: "accountId é obrigatório." };
  var apiKey = obterApiKeyPluggy_();
  var todas = [];
  var after = null;

  do {
    var url = PLUGGY_API_BASE + "/v2/transactions"
      + "?accountId=" + encodeURIComponent(accountId)
      + (from ? "&dateFrom=" + encodeURIComponent(from) : "")
      + (to ? "&dateTo=" + encodeURIComponent(to) : "")
      + (after ? "&after=" + encodeURIComponent(after) : "");
    var resp = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "X-API-KEY": apiKey },
      muteHttpExceptions: true
    });
    var dados = JSON.parse(resp.getContentText());
    if (resp.getResponseCode() >= 300) {
      return { ok: false, erro: dados.message || "Falha ao listar transações." };
    }
    todas = todas.concat(dados.results || []);
    after = dados.next ? extrairParametroUrl_(dados.next, "after") : null;
  } while (after);

  return { ok: true, transactions: todas };
}

// Apps Script não tem a API URL/URLSearchParams do navegador — extrai o
// valor de um parâmetro de query string na mão (usado pra pegar o "after"
// de dentro da URL "next" que a Pluggy devolve).
function extrairParametroUrl_(url, nome) {
  var m = new RegExp("[?&]" + nome + "=([^&]+)").exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

// ══════════════ AUTENTICAÇÃO COM A PLUGGY ══════════════

// Troca clientId/clientSecret (guardados nas Script Properties, nunca
// hardcoded) por um apiKey de curta duração — chamado de novo a cada
// requisição, igual ao passo a passo oficial da Pluggy.
function obterApiKeyPluggy_() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty("PLUGGY_CLIENT_ID");
  var clientSecret = props.getProperty("PLUGGY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("Configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET em Project Settings > Script Properties.");
  }
  var resp = UrlFetchApp.fetch(PLUGGY_API_BASE + "/auth", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ clientId: clientId, clientSecret: clientSecret }),
    muteHttpExceptions: true
  });
  var dados = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() >= 300) {
    throw new Error(dados.message || "Falha ao autenticar com a Pluggy — confira PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET.");
  }
  return dados.apiKey;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
