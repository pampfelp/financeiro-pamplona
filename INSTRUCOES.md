# Controle Financeiro Pamplona — Como colocar no ar

Este pacote tem estes arquivos:
- `firebase-init.js` → liga o sistema ao banco de dados (Firestore) e guarda a URL do proxy da Pluggy (`PLUGGY_PROXY_URL`, opcional — veja o Passo 5)
- `index.html`, `style.css`, `app.js` → o sistema que o Pamplona vai usar no navegador
- `firestore.rules` → regras de segurança, cola no console do Firebase
- `planilha.html` → uma página separada pra editar ou apagar dados direto, como se fosse uma planilha (veja o Passo 3 abaixo)
- `manifest.json`, `service-worker.js`, ícones (`.png`/`.ico`) → deixam o sistema instalável como aplicativo. **Precisam ficar na mesma pasta que o `index.html`**, sempre que for hospedar — não são opcionais.
- `Code.gs` → Apps Script mínimo, só usado se você configurar a integração bancária opcional (Passo 5) — guarda os segredos da Pluggy, nunca é hospedado junto com o site.

Este sistema **começa vazio** — não tem uma pasta de migração de dados
antigos, porque não existe uma base anterior pro Pamplona.

## Passo 1 — Criar o banco de dados (Firebase)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e crie um projeto novo (gratuito).
2. Ative o **Firestore Database** (modo produção).
3. Em **Regras**, cole o conteúdo de `firestore.rules` e publique.
4. Registre um "app Web" nas configurações do projeto e copie a configuração (`firebaseConfig`).
5. Abra `firebase-init.js` num editor de texto simples e cole essa configuração no lugar dos valores de exemplo (`COLE_AQUI_...`).

## Passo 2 — Colocar no ar

Este sistema **não funciona só abrindo o `index.html` no computador** (é
uma limitação de segurança do navegador). Ele precisa estar hospedado num
site com HTTPS. A forma mais simples e gratuita é o **GitHub Pages**:

1. Crie uma conta gratuita em [github.com](https://github.com), se ainda não tiver.
2. Crie um repositório novo.
3. Arraste todos os arquivos deste pacote pra dentro dele (soltos, sem pastas) — **exceto o `Code.gs`**, esse não vai pro GitHub, vai só pro Apps Script (veja o Passo 5).
4. Nas configurações do repositório, ative o **GitHub Pages** apontando pra branch principal.
5. Em alguns minutos, o link aparece — é esse link que o Pamplona vai usar.

## Passo 3 — Editar dados direto, como numa planilha

Se você quiser corrigir um dado, apagar um registro de teste, ou colar uma
lista inteira de uma vez, **não precisa entrar no site do Firebase**. Abra
o link do site com `/planilha.html` no final (ex:
`https://seusite.github.io/planilha.html`). Essa página pede uma senha (a
senha inicial é `pamplona2026` — troque assim que puder, veja o `README.md`)
e depois funciona como uma planilha: abas por tipo de dado, você edita a
célula e ela salva sozinha, seleciona várias linhas e apaga de uma vez, e
tem botões pra exportar em CSV/Excel ou importar um arquivo CSV/Excel de
uma vez.

**Guarde o link e a senha dessa página em um lugar seguro** — quem tiver
os dois consegue editar ou apagar qualquer dado do sistema.

## Passo 4 — Usar o sistema

Diferente do Financeiro Leonardo, este sistema **não tem dados antigos pra
trazer** — é só começar a usar: cadastre seus lançamentos (Salário,
Aluguel, Mercado...), seus cartões, e vá lançando as movimentações do dia a
dia.

## Passo 5 — (Opcional) Conectar bancos via Open Finance

A aba "🏦 Conexões Bancárias" importa automaticamente as transações do seu
banco pra dentro do sistema, usando a **Pluggy** (uma agregadora brasileira
de Open Finance). **Isso é totalmente opcional** — o resto do sistema
funciona sem configurar nada disso.

**Importante: essa integração só LÊ dados do banco.** Ela nunca faz
pagamento, transferência, Pix ou qualquer outra coisa que mexa no seu
dinheiro de verdade — só importa o extrato como movimentações, pra você não
precisar digitar tudo à mão.

Passo a passo resumido (detalhado no `README.md`, seção 4):

1. **Crie uma conta grátis na Pluggy**: [console.pluggy.ai](https://console.pluggy.ai) — não pede cartão de crédito no tier sandbox. Anote o **Client ID** e o **Client Secret**.
2. **Implante o `Code.gs` como Apps Script Web App**: cole o conteúdo dele numa planilha Google Sheets em branco (Extensões → Apps Script), implante como "Aplicativo da Web" (Executar como: Eu / Quem pode acessar: Qualquer pessoa), e copie a URL `/exec`.
3. **Configure os segredos**: no editor do Apps Script, vá em Configurações do projeto → Script Properties, e adicione `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` com os valores do passo 1. Nunca cole esses valores em nenhum arquivo do site.
4. **Cole a URL do Apps Script** em `firebase-init.js`, na constante `PLUGGY_PROXY_URL`.
5. Suba o `firebase-init.js` atualizado pra hospedagem e pronto — a aba "Conexões Bancárias" já consegue conectar um banco.

**Sobre o sandbox**: a conta gratuita da Pluggy só conecta a **bancos de
teste fictícios**, pra você experimentar o fluxo sem usar uma conta real.
Conectar um banco de verdade exige migrar pra uma conta de produção da
Pluggy (com custo) e passar pela certificação de Open Finance deles — isso
não vem incluído neste pacote; procure diretamente no site da Pluggy
quando for a hora de fazer essa migração.

## Estrutura de dados criada no Firestore

- **lancamentos**: nome, tipo (Entrada/Saída), categoria
- **movimentacoes**: lançamento, data, valor, se está pago, cartão (se for parcela), `pluggyTransactionId` (só em movimentações importadas do banco)
- **cartoes**: nome, limite, dia de fechamento e vencimento
- **comprasParceladas**: compra parcelada no cartão, com todas as parcelas já criadas em movimentacoes
- **recorrentes**: custos que se repetem todo mês (aluguel, assinatura...)
- **historico**: log de tudo que foi editado ou excluído — nunca é apagado
- **config**: renda mensal e saldo inicial
- **feriados**: usado pra calcular vencimento em dia útil (começa vazio — cadastre pela planilha administrativa se quiser)
- **planos**: metas de economia
- **pessoas**: quem cadastrou/comprou cada movimentação
- **conexoesBancarias**: um registro por banco conectado via Open Finance (Passo 5, opcional)
