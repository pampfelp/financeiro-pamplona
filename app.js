// Financeiro Pamplona — lógica do app. Firestore no lugar do Apps Script:
// onSnapshot mantém tudo em tempo real, sem precisar recarregar a página.
// Regras de negócio (vencimento em dia útil, cálculo do dashboard, limite do
// cartão) foram trazidas do Code.gs original e agora rodam aqui no navegador.
//
// A única exceção é a integração de Open Finance (Pluggy, aba "Conexões
// Bancárias") — o clientId/clientSecret da Pluggy NUNCA podem aparecer aqui
// (este arquivo é público, visível por "ver código-fonte"), então o app.js
// só fala com um Apps Script mínimo (Code.gs) que guarda esses segredos nas
// Script Properties e repassa as chamadas pra API da Pluggy. Veja
// PLUGGY_PROXY_URL em firebase-init.js e a seção "CONEXÕES BANCÁRIAS" abaixo.

import { db, PLUGGY_PROXY_URL } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, setDoc, doc, increment,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STATE = {
  lancamentos: [],
  movimentacoes: [],
  cartoes: [],
  comprasParceladas: [],
  recorrentes: [],
  historico: [],
  feriados: [],
  planos: [],
  pessoas: [],
  conexoesBancarias: [],
  config: { rendaMensal: 0, saldoInicial: 0 },
  filtroMovMesDe: "",
  filtroMovMesAte: "",
  filtroMovPessoa: "",
  filtroMovBanco: "",
  filtroMovTipoConta: "",
  filtroMovRevisado: ""
};

// Evita sincronizar a mesma conexão bancária mais de uma vez por sessão —
// o listener de conexoesBancarias dispara de novo a cada escrita (inclusive
// as que a própria sincronização faz), então sem essa guarda viraria loop.
const conexoesAutoSincronizadasNestaSessao = new Set();

let recorrentesCarregados = false;
let jaVerificouRecorrentesPendentes = false;
let lancamentosCarregados = false;

// Quando o modal "Novo lançamento" é aberto a partir de um campo específico
// (ex: o select de Movimentações), guardamos aqui pra, depois de salvar,
// selecionar automaticamente o lançamento recém-criado nesse campo.
let selectAlvoNovoLancamento = null;
let pendingSelecaoLancamento = null; // { selectId, lancamentoId }

// Mesma ideia, só que pro modal "Nova pessoa" (campo "Quem comprou").
let selectAlvoNovaPessoa = null;
let pendingSelecaoPessoa = null; // { selectId, nome }

/* ══════════════ HELPERS ══════════════ */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function arredondar2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

// Converte "yyyy-MM-dd" pra "dd/MM/yyyy" só por texto — evita o bug clássico
// de fuso horário de criar um Date() a partir de uma string ISO.
function dataBR(iso) {
  if (!iso) return "—";
  const [a, m, d] = String(iso).split("-");
  return `${d}/${m}/${a}`;
}

// "yyyy-MM-dd" -> Date local (meia-noite no fuso do navegador), sem o
// deslocamento de um dia que "new Date('yyyy-MM-dd')" causa (ele interpreta
// como UTC).
function parseDataLocal(str) {
  const [ano, mes, dia] = String(str).split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

function formatarDataISO(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function tsParaMillis(ts) {
  if (!ts) return Date.now();
  if (ts.toMillis) return ts.toMillis();
  return Number(ts) || 0;
}

function fmtDataHora(ts) {
  if (!ts || !ts.toDate) return "agora mesmo";
  const d = ts.toDate();
  return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function mostrarToast(msg, erro) {
  const el = document.getElementById("toast");
  document.getElementById("toast-title").textContent = erro ? "Erro" : "Aviso";
  document.getElementById("toast-msg").textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("erro", !!erro);
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => el.classList.add("hidden"), erro ? 7000 : 3500);
}

function mapaLancamentos() {
  const m = {};
  STATE.lancamentos.forEach((l) => (m[l.id] = l));
  return m;
}

// "Filtro mestre" das conexões bancárias: cada conexão tem um interruptor
// "Incluir no uso pessoal" (aba Conexões Bancárias). Uma conexão desligada
// some do Dashboard e de Movimentações em todo o app — só volta a aparecer
// religando o interruptor lá, não tem um jeito de "espiar" só numa tela.
// Serve pra separar conta PJ compartilhada de uso pessoal, por exemplo.
function conexoesAtivasParaPessoal() {
  const set = new Set();
  STATE.conexoesBancarias.forEach((c) => { if (c.ativoParaPessoal !== false) set.add(c.id); });
  return set;
}

// Dado antigo do Open Finance sem "conexaoId" (importado antes desse campo
// existir) fica visível por padrão — não escondemos algo sem saber de qual
// banco veio, pra não sumir dado sem explicação.
function movimentacaoVisivel(m, conexoesAtivas) {
  if (m.origem !== "Open Finance") return true;
  if (!m.conexaoId) return true;
  return conexoesAtivas.has(m.conexaoId);
}

/* ══════════════ REGRAS DE NEGÓCIO (vindas do Code.gs original) ══════════════ */

function ehDiaUtil(date, feriadosSet) {
  const diaSemana = date.getDay(); // 0=domingo, 6=sábado
  if (diaSemana === 0 || diaSemana === 6) return false;
  if (feriadosSet.has(formatarDataISO(date))) return false;
  return true;
}

// Vencimento cai no dia configurado (ou no último dia do mês, se o mês for
// mais curto). Se cair em fim de semana/feriado: empurra pro próximo dia
// útil, a menos que seja o último dia do mês — aí antecipa pro dia útil
// anterior. "referencia" pode ser um Date ou undefined (usa hoje).
function calcularProximoVencimento(diaVencimento, referencia) {
  const feriadosSet = new Set(STATE.feriados.map((f) => f.data));
  const hoje = referencia ? new Date(referencia) : new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
  const dia = Math.min(Number(diaVencimento), ultimoDiaMes);
  const ehUltimoDia = dia === ultimoDiaMes;
  let venc = new Date(ano, mes, dia);

  if (!ehDiaUtil(venc, feriadosSet)) {
    const passo = ehUltimoDia ? -1 : 1;
    while (!ehDiaUtil(venc, feriadosSet)) {
      venc.setDate(venc.getDate() + passo);
    }
  }
  return formatarDataISO(venc);
}

// Em qual mês cai a primeira fatura de uma compra (parcelada ou à vista): se
// foi feita antes do dia de fechamento, ela soma na fatura que está fechando
// agora (mesmo mês da compra); se foi feita no dia do fechamento ou depois,
// o fechamento deste mês já passou, então ela cai na fatura do mês seguinte.
function calcularCicloInicial(dataCompraStr, diaFechamento) {
  const d = parseDataLocal(dataCompraStr);
  const mes = d.getMonth() + (d.getDate() < diaFechamento ? 0 : 1);
  const normalizado = new Date(d.getFullYear(), mes, 1);
  return { ano: normalizado.getFullYear(), mes: normalizado.getMonth() };
}

// "Limite utilizado" = soma das parcelas desse cartão ainda não pagas —
// volta a subir sozinho conforme as parcelas são marcadas como pagas.
function calcularLimiteUtilizado(cartaoId) {
  let total = 0;
  STATE.movimentacoes.forEach((m) => {
    if (m.cartaoId && String(m.cartaoId) === String(cartaoId) && m.pago !== true) {
      total += Number(m.valor) || 0;
    }
  });
  return total;
}

// Valor total das parcelas de cartão ainda não pagas cujo vencimento cai no
// mês atual — é o que você precisa separar do salário pra pagar a fatura.
// Sem cartaoId, soma todos os cartões; com cartaoId, soma só aquele cartão.
function calcularFaturaMesAtual(cartaoId) {
  const hoje = new Date();
  const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  STATE.movimentacoes.forEach((m) => {
    if (!m.cartaoId) return;
    if (cartaoId && String(m.cartaoId) !== String(cartaoId)) return;
    if (m.pago === true) return;
    if (String(m.data || "").slice(0, 7) !== anoMesAtual) return;
    total += Number(m.valor) || 0;
  });
  return total;
}

function calcularDashboard() {
  const mapaLanc = mapaLancamentos();
  const rendaMensal = Number(STATE.config.rendaMensal) || 0;
  const saldoInicial = Number(STATE.config.saldoInicial) || 0;

  const hoje = new Date();
  const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;

  let saldoAtual = saldoInicial;
  let saidasNaoPagas = 0;
  let entradasNaoPagas = 0;
  let saidasPagasMes = 0;
  let parcelasCartaoFuturas = 0;

  const conexoesAtivas = conexoesAtivasParaPessoal();
  STATE.movimentacoes.forEach((m) => {
    if (!movimentacaoVisivel(m, conexoesAtivas)) return;
    const l = mapaLanc[m.lancamentoId] || {};
    const valor = Number(m.valor) || 0;
    const ehSaida = l.tipo === "Saida";
    const dataAnoMes = String(m.data || "").slice(0, 7);

    if (m.pago === true) {
      saldoAtual += ehSaida ? -valor : valor;
      if (ehSaida && dataAnoMes === anoMes) saidasPagasMes += valor;
    } else {
      if (ehSaida) saidasNaoPagas += valor;
      else entradasNaoPagas += valor;
      if (m.cartaoId) parcelasCartaoFuturas += valor;
    }
  });

  const saldoPrevisto = saldoAtual - saidasNaoPagas + entradasNaoPagas;

  const diaAtual = hoje.getDate();
  const ultimoDiaMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const diasRestantes = ultimoDiaMes - diaAtual + 1;
  const gastoSugerido = diasRestantes > 0 ? saldoAtual / diasRestantes : 0;

  const percentualRendaGasta = rendaMensal > 0 ? (saidasPagasMes / rendaMensal) * 100 : 0;
  const gastoPermitidoAteHoje = rendaMensal > 0 ? (rendaMensal / ultimoDiaMes) * diaAtual : 0;

  return { saldoAtual, saldoPrevisto, gastoSugerido, percentualRendaGasta, gastoPermitidoAteHoje, diasRestantes, parcelasCartaoFuturas };
}

/* ══════════════ NAVEGAÇÃO ══════════════ */

document.querySelectorAll(".sidebar a[data-view]").forEach((a) => {
  a.addEventListener("click", () => trocarView(a.dataset.view));
});

function trocarView(nome) {
  document.querySelectorAll(".sidebar a[data-view]").forEach((x) => x.classList.remove("active"));
  document.querySelector(`.sidebar a[data-view="${nome}"]`).classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + nome).classList.add("active");
  fecharMenuMobile();
}

function fecharMenuMobile() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebar-backdrop").classList.remove("active");
}
document.getElementById("btn-abrir-menu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.add("mobile-open");
  document.getElementById("sidebar-backdrop").classList.add("active");
});
document.getElementById("sidebar-backdrop").addEventListener("click", fecharMenuMobile);

/* ══════════════ RENDERIZAÇÃO ══════════════ */

function renderAll() {
  renderLancamentos();
  renderMovimentacoes();
  renderCartoes();
  renderComprasParceladas();
  renderParcelasCartao();
  renderRecorrentes();
  renderHistorico();
  renderDashboard();
}

function renderLancamentos() {
  const body = document.getElementById("lancs-body");
  if (!STATE.lancamentos.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nenhum lançamento cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.lancamentos.map((l) => (
      `<tr><td>${esc(l.nome)}</td><td><span class="badge-tipo ${l.tipo}">${l.tipo === "Entrada" ? "Entrada" : "Saída"}</span></td>` +
      `<td>${esc(l.categoria)}</td><td><button class="btn-small" data-editar-lanc="${l.id}">Editar</button></td></tr>`
    )).join("");
    document.querySelectorAll("[data-editar-lanc]").forEach((btn) => {
      btn.addEventListener("click", () => abrirModalEdicaoLancamento(btn.dataset.editarLanc));
    });
  }
  preencherCategorias();
  preencherSelectsLancamento();
}

function preencherCategorias() {
  const categorias = [...new Set(STATE.lancamentos.map((l) => l.categoria).filter(Boolean))].sort();
  document.getElementById("lista-categorias").innerHTML = categorias.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

const CAMPOS_BUSCA_LANCAMENTO = [
  "mov-lancamento", "rec-lancamento", "compra-lancamento", "edit-mov-lancamento", "edit-rec-lancamento", "edit-compra-lancamento",
  "qa-mov-lancamento", "qa-compra-lancamento", "qa-rec-lancamento"
];

function rotuloLancamento(l) {
  return `${l.nome} (${l.tipo === "Entrada" ? "Entrada" : "Saída"} — ${l.categoria})`;
}

// Cada campo "Lançamento" é, por baixo dos panos, um <input type="hidden">
// com o MESMO id que o <select> antigo tinha — todo o resto do código
// (leituras de .value, validações) continua funcionando sem mudar nada.
// O que aparece pra digitar é um <input type="text"> com sufixo "-busca",
// filtrado por um <datalist>. Esta função escreve nos dois: o hidden (ID)
// e o texto visível (rótulo), a partir de um lancamentoId.
function definirComboLancamento(id, lancamentoId) {
  const hidden = document.getElementById(id);
  const busca = document.getElementById(id + "-busca");
  const l = STATE.lancamentos.find((x) => x.id === lancamentoId);
  hidden.value = l ? l.id : "";
  if (busca) busca.value = l ? rotuloLancamento(l) : "";
}

// Liga cada campo de busca ao hidden correspondente — só precisa rodar uma
// vez (não a cada render), senão os listeners se acumulariam.
function iniciarBuscaLancamento() {
  CAMPOS_BUSCA_LANCAMENTO.forEach((id) => {
    const busca = document.getElementById(id + "-busca");
    if (!busca) return;
    busca.addEventListener("input", () => {
      const alvo = STATE.lancamentos.find((l) => rotuloLancamento(l) === busca.value);
      document.getElementById(id).value = alvo ? alvo.id : "";
    });
  });
}

function preencherSelectsLancamento() {
  const datalistHtml = STATE.lancamentos.map((l) => `<option value="${esc(rotuloLancamento(l))}">`).join("");
  const mapaPorId = mapaLancamentos();

  CAMPOS_BUSCA_LANCAMENTO.forEach((id) => {
    const hidden = document.getElementById(id);
    const busca = document.getElementById(id + "-busca");
    const datalist = document.getElementById("dl-" + id);
    if (datalist) datalist.innerHTML = datalistHtml;

    if (pendingSelecaoLancamento && pendingSelecaoLancamento.selectId === id && mapaPorId[pendingSelecaoLancamento.lancamentoId]) {
      definirComboLancamento(id, pendingSelecaoLancamento.lancamentoId);
      pendingSelecaoLancamento = null;
    } else if (hidden.value && !mapaPorId[hidden.value]) {
      // O lançamento selecionado foi excluído — limpa em vez de deixar um
      // ID morto guardado.
      hidden.value = "";
      if (busca) busca.value = "";
    } else if (hidden.value && busca && document.activeElement !== busca) {
      // Mantém o texto visível sincronizado (ex: se o nome do lançamento
      // mudou), mas nunca sobrescreve enquanto a pessoa está digitando.
      busca.value = rotuloLancamento(mapaPorId[hidden.value]);
    }
  });
}

/* ══════════════ MODAL: NOVO LANÇAMENTO (reutilizado em várias telas) ══════════════ */

function abrirModalNovoLancamento(selectAlvoId) {
  selectAlvoNovoLancamento = selectAlvoId || null;
  document.getElementById("novo-lanc-nome").value = "";
  document.getElementById("novo-lanc-tipo").value = "Entrada";
  document.getElementById("novo-lanc-categoria").value = "";
  document.getElementById("modal-novo-lancamento").classList.add("active");
  document.getElementById("novo-lanc-nome").focus();
}
function fecharModalNovoLancamento() {
  document.getElementById("modal-novo-lancamento").classList.remove("active");
  selectAlvoNovoLancamento = null;
}
document.querySelectorAll("[data-abrir-novo-lancamento]").forEach((btn) => {
  btn.addEventListener("click", () => abrirModalNovoLancamento(btn.dataset.abrirNovoLancamento));
});
document.getElementById("btn-cancelar-novo-lancamento").addEventListener("click", fecharModalNovoLancamento);
document.getElementById("modal-novo-lancamento").addEventListener("click", (e) => {
  if (e.target.id === "modal-novo-lancamento") fecharModalNovoLancamento();
});
document.getElementById("btn-salvar-novo-lancamento").addEventListener("click", async () => {
  const nome = document.getElementById("novo-lanc-nome").value.trim();
  const tipo = document.getElementById("novo-lanc-tipo").value;
  const categoria = document.getElementById("novo-lanc-categoria").value.trim();
  if (!nome || !categoria) return mostrarToast("Preencha nome e categoria.", true);
  try {
    const ref = await addDoc(collection(db, "lancamentos"), { nome, tipo, categoria, createdAt: serverTimestamp() });
    if (selectAlvoNovoLancamento) {
      pendingSelecaoLancamento = { selectId: selectAlvoNovoLancamento, lancamentoId: ref.id };
    }
    mostrarToast("Lançamento cadastrado!");
    fecharModalNovoLancamento();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ MODAL: NOVA PESSOA (reutilizado em "Quem comprou") ══════════════ */

function preencherSelectsPessoa() {
  const opcoes = '<option value="">— Não informado —</option>' +
    STATE.pessoas.map((p) => `<option value="${esc(p.nome)}">${esc(p.nome)}</option>`).join("");
  ["mov-responsavel", "compra-responsavel", "edit-mov-responsavel", "edit-compra-responsavel", "qa-mov-responsavel", "qa-compra-responsavel"].forEach((id) => {
    const sel = document.getElementById(id);
    const valorAtual = sel.value;
    sel.innerHTML = opcoes;
    if (pendingSelecaoPessoa && pendingSelecaoPessoa.selectId === id && STATE.pessoas.some((p) => p.nome === pendingSelecaoPessoa.nome)) {
      sel.value = pendingSelecaoPessoa.nome;
      pendingSelecaoPessoa = null;
    } else if (valorAtual) {
      sel.value = valorAtual;
    }
  });
}

// Registros antigos podem ter "responsavel" como texto livre que não bate
// com nenhuma pessoa cadastrada — garante que o valor apareça mesmo assim
// (marcado como "não cadastrado"), em vez de sumir silenciosamente do select.
function garantirOpcaoPessoa(selectId, nome) {
  if (!nome) return;
  const sel = document.getElementById(selectId);
  if (![...sel.options].some((o) => o.value === nome)) {
    sel.insertAdjacentHTML("beforeend", `<option value="${esc(nome)}">${esc(nome)} (não cadastrado)</option>`);
  }
  sel.value = nome;
}

function abrirModalNovaPessoa(selectAlvoId) {
  selectAlvoNovaPessoa = selectAlvoId || null;
  document.getElementById("nova-pessoa-nome").value = "";
  document.getElementById("modal-nova-pessoa").classList.add("active");
  document.getElementById("nova-pessoa-nome").focus();
}
function fecharModalNovaPessoa() {
  document.getElementById("modal-nova-pessoa").classList.remove("active");
  selectAlvoNovaPessoa = null;
}
document.querySelectorAll("[data-abrir-nova-pessoa]").forEach((btn) => {
  btn.addEventListener("click", () => abrirModalNovaPessoa(btn.dataset.abrirNovaPessoa));
});
document.getElementById("btn-cancelar-nova-pessoa").addEventListener("click", fecharModalNovaPessoa);
document.getElementById("modal-nova-pessoa").addEventListener("click", (e) => {
  if (e.target.id === "modal-nova-pessoa") fecharModalNovaPessoa();
});
document.getElementById("btn-salvar-nova-pessoa").addEventListener("click", async () => {
  const nome = document.getElementById("nova-pessoa-nome").value.trim();
  if (!nome) return mostrarToast("Digite um nome.", true);
  if (STATE.pessoas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
    return mostrarToast("Já existe uma pessoa com esse nome.", true);
  }
  try {
    await addDoc(collection(db, "pessoas"), { nome, createdAt: serverTimestamp() });
    if (selectAlvoNovaPessoa) pendingSelecaoPessoa = { selectId: selectAlvoNovaPessoa, nome };
    mostrarToast("Pessoa cadastrada!");
    fecharModalNovaPessoa();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

function filtrarPorMes(lista) {
  if (!STATE.filtroMovMesDe && !STATE.filtroMovMesAte) return lista;
  return lista.filter((m) => {
    const anoMes = String(m.data || "").slice(0, 7);
    if (STATE.filtroMovMesDe && anoMes < STATE.filtroMovMesDe) return false;
    if (STATE.filtroMovMesAte && anoMes > STATE.filtroMovMesAte) return false;
    return true;
  });
}

function filtrarPorPessoa(lista) {
  if (!STATE.filtroMovPessoa) return lista;
  return lista.filter((m) => (m.responsavel || "") === STATE.filtroMovPessoa);
}

function filtrarPorBanco(lista) {
  if (!STATE.filtroMovBanco) return lista;
  return lista.filter((m) => (m.instituicao || "") === STATE.filtroMovBanco);
}

function filtrarPorTipoConta(lista) {
  if (!STATE.filtroMovTipoConta) return lista;
  return lista.filter((m) => (m.contaTipo || "") === STATE.filtroMovTipoConta);
}

function filtrarNaoRevisadas(lista) {
  if (STATE.filtroMovRevisado !== "nao") return lista;
  return lista.filter((m) => m.origem === "Open Finance" && m.revisado !== true);
}

// Opções do filtro vêm da união de "pessoas" cadastradas + qualquer nome
// já usado em movimentações (cobre registros antigos com texto livre) —
// assim ninguém some do filtro só porque não foi formalmente cadastrado.
function preencherFiltroPessoa(enriquecidas) {
  const nomes = new Set();
  STATE.pessoas.forEach((p) => nomes.add(p.nome));
  enriquecidas.forEach((m) => { if (m.responsavel) nomes.add(m.responsavel); });
  const sel = document.getElementById("mov-filtro-pessoa");
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todas as pessoas</option>' +
    [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR")).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (valorAtual) sel.value = valorAtual;
}

// Mesma ideia do filtro de pessoa: união das conexões bancárias cadastradas
// + qualquer nome de banco já usado em movimentações importadas.
function preencherFiltroBanco(enriquecidas) {
  const nomes = new Set();
  STATE.conexoesBancarias.forEach((c) => { if (c.instituicao) nomes.add(c.instituicao); });
  enriquecidas.forEach((m) => { if (m.instituicao) nomes.add(m.instituicao); });
  const sel = document.getElementById("mov-filtro-banco");
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todos os bancos</option>' +
    [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR")).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (valorAtual) sel.value = valorAtual;
}

document.getElementById("mov-filtro-pessoa").addEventListener("change", (e) => {
  STATE.filtroMovPessoa = e.target.value;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-banco").addEventListener("change", (e) => {
  STATE.filtroMovBanco = e.target.value;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-tipo-conta").addEventListener("change", (e) => {
  STATE.filtroMovTipoConta = e.target.value;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-revisado").addEventListener("change", (e) => {
  STATE.filtroMovRevisado = e.target.value;
  renderMovimentacoes();
});

// Separa por tipo (Entrada/Saída) ANTES de separar por pago/não pago — uma
// entrada não paga é dinheiro a RECEBER, não a pagar (são fluxos opostos,
// misturar os dois num "a pagar" só não fazia sentido). Segue a mesma regra
// do calcularDashboard(): só conta como saída quando o tipo é
// exatamente "Saida"; qualquer outra coisa (Entrada, ou lançamento
// excluído) cai do lado de "receber".
function renderMovKpis(filtradas) {
  let totalPago = 0, qtdPago = 0, totalRecebido = 0, qtdRecebido = 0;
  let totalAPagar = 0, qtdAPagar = 0, totalAReceber = 0, qtdAReceber = 0;
  filtradas.forEach((m) => {
    const valor = Number(m.valor) || 0;
    const ehSaida = m.tipo === "Saida";
    if (m.pago) {
      if (ehSaida) { totalPago += valor; qtdPago++; } else { totalRecebido += valor; qtdRecebido++; }
    } else {
      if (ehSaida) { totalAPagar += valor; qtdAPagar++; } else { totalAReceber += valor; qtdAReceber++; }
    }
  });
  document.getElementById("mov-kpi-grid").innerHTML =
    kpiCard("Pago no período", moeda(totalPago) + ` <small>(${qtdPago})</small>`, true) +
    kpiCard("Recebido no período", moeda(totalRecebido) + ` <small>(${qtdRecebido})</small>`, true) +
    kpiCard("A pagar no período", moeda(totalAPagar) + ` <small>(${qtdAPagar})</small>`, totalAPagar === 0) +
    kpiCard("A receber no período", moeda(totalAReceber) + ` <small>(${qtdAReceber})</small>`, totalAReceber === 0);
}

function renderMovimentacoes() {
  const mapaLanc = mapaLancamentos();
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));
  const conexoesAtivas = conexoesAtivasParaPessoal();
  const enriquecidas = STATE.movimentacoes
    .filter((m) => movimentacaoVisivel(m, conexoesAtivas))
    .map((m) => {
      const l = mapaLanc[m.lancamentoId] || {};
      const compra = m.compraParceladaId ? mapaCompra[m.compraParceladaId] : null;
      return {
        ...m, nomeLancamento: l.nome || "(excluído)", tipo: l.tipo || "", categoria: l.categoria || "",
        descricaoCompra: compra ? compra.descricao : ""
      };
    });

  preencherFiltroPessoa(enriquecidas);
  preencherFiltroBanco(enriquecidas);
  const filtradas = filtrarNaoRevisadas(filtrarPorTipoConta(filtrarPorBanco(filtrarPorPessoa(filtrarPorMes(enriquecidas)))));

  const body = document.getElementById("movs-body");
  if (!filtradas.length) {
    const temFiltro = STATE.filtroMovMesDe || STATE.filtroMovMesAte || STATE.filtroMovPessoa
      || STATE.filtroMovBanco || STATE.filtroMovTipoConta || STATE.filtroMovRevisado;
    body.innerHTML = `<tr><td colspan="7" class="empty">${temFiltro ? "Nenhuma movimentação com esse filtro." : "Nenhuma movimentação registrada ainda."}</td></tr>`;
  } else {
    body.innerHTML = filtradas.map((m) => {
      const aRevisar = m.origem === "Open Finance" && m.revisado !== true;
      const rotuloBanco = m.instituicao
        ? `🏦 ${m.instituicao}${m.contaTipo === "cartao" ? " (cartão)" : ""}`
        : (m.origem === "Open Finance" ? "🏦 Banco não identificado (sincronizado antes do rastreamento por banco)" : "");
      const sublabels = [
        m.descricaoCompra,
        rotuloBanco,
        m.descricaoOrigem
      ].filter(Boolean).map((s) => `<span class="sublabel">${esc(s)}</span>`).join("");
      return (
        `<tr class="linha-clicavel" data-abrir-mov="${m.id}">` +
        `<td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}${aRevisar ? ' <span class="stamp revisar">A REVISAR</span>' : ""}${sublabels}</td>` +
        `<td><span class="badge-tipo ${m.tipo}">${m.tipo === "Entrada" ? "Entrada" : (m.tipo ? "Saída" : "")}</span></td>` +
        `<td>${esc(m.categoria)}</td><td>${esc(m.responsavel || "")}</td><td class="num">${moeda(m.valor)}</td>` +
        `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
      );
    }).join("");
    document.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalMovimentacao(tr.dataset.abrirMov));
    });
    document.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
      });
    });
  }

  renderMovKpis(filtradas);
  renderDashMovs(enriquecidas.slice(0, 8));
}

document.getElementById("mov-filtro-mes-de").addEventListener("change", (e) => {
  STATE.filtroMovMesDe = e.target.value;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-mes-ate").addEventListener("change", (e) => {
  STATE.filtroMovMesAte = e.target.value;
  renderMovimentacoes();
});
document.getElementById("btn-mov-todos-meses").addEventListener("click", () => {
  STATE.filtroMovMesDe = "";
  STATE.filtroMovMesAte = "";
  document.getElementById("mov-filtro-mes-de").value = "";
  document.getElementById("mov-filtro-mes-ate").value = "";
  renderMovimentacoes();
});

function renderDashMovs(movs) {
  const body = document.getElementById("dash-movs-body");
  if (!movs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma movimentação registrada ainda.</td></tr>';
    return;
  }
  body.innerHTML = movs.map((m) => (
    `<tr><td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}${m.descricaoCompra ? `<span class="sublabel">${esc(m.descricaoCompra)}</span>` : ""}</td>` +
    `<td><span class="badge-tipo ${m.tipo}">${m.tipo === "Entrada" ? "Entrada" : (m.tipo ? "Saída" : "")}</span></td>` +
    `<td class="num">${moeda(m.valor)}</td>` +
    `<td><span class="stamp ${m.pago ? "pago" : "pendente"}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
  )).join("");
}

function renderCartaoKpis() {
  let totalLimite = 0, totalUtilizado = 0;
  STATE.cartoes.forEach((c) => {
    totalLimite += Number(c.limiteTotal) || 0;
    totalUtilizado += calcularLimiteUtilizado(c.id);
  });
  const totalDisponivel = totalLimite - totalUtilizado;
  const faturaMesAtual = calcularFaturaMesAtual();
  document.getElementById("cartao-kpi-grid").innerHTML =
    kpiCard("Total a pagar este mês (todos os cartões)", moeda(faturaMesAtual), faturaMesAtual === 0) +
    kpiCard("Limite total (todos os cartões)", moeda(totalLimite), true) +
    kpiCard("Soma de parcelas ativas (todos os meses)", moeda(totalUtilizado), totalUtilizado === 0) +
    kpiCard("Disponível (todos os cartões)", moeda(totalDisponivel), totalDisponivel >= 0);
}

function renderCartoes() {
  const body = document.getElementById("cartoes-body");
  if (!STATE.cartoes.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">Nenhum cartão cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.cartoes.map((c) => {
      const utilizado = calcularLimiteUtilizado(c.id);
      const disponivel = (Number(c.limiteTotal) || 0) - utilizado;
      const faturaMes = calcularFaturaMesAtual(c.id);
      const ativo = c.ativo !== false;
      return (
        `<tr class="linha-clicavel" data-abrir-cartao="${c.id}"><td>${esc(c.nome)}</td><td class="num">${moeda(c.limiteTotal)}</td>` +
        `<td class="num">${moeda(utilizado)}</td><td class="num">${moeda(disponivel)}</td><td class="num">${moeda(faturaMes)}</td>` +
        `<td>dia ${c.diaFechamento}</td><td>dia ${c.diaVencimento}</td>` +
        `<td><span class="stamp ${ativo ? "ativo" : "inativo"}" data-alternar-cartao-ativo="${c.id}" data-novo-ativo="${!ativo}">${ativo ? "ATIVO" : "INATIVO"}</span></td></tr>`
      );
    }).join("");
    document.querySelectorAll("[data-abrir-cartao]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalEditarCartao(tr.dataset.abrirCartao));
    });
    document.querySelectorAll("[data-alternar-cartao-ativo]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarAtivoCartao(stamp.dataset.alternarCartaoAtivo, stamp.dataset.novoAtivo === "true");
      });
    });
  }
  preencherSelectCartoes();
  renderCartaoKpis();
}

async function alternarAtivoCartao(id, novoAtivo) {
  try {
    await updateDoc(doc(db, "cartoes", id), { ativo: novoAtivo });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

function abrirModalEditarCartao(id) {
  const c = STATE.cartoes.find((x) => x.id === id);
  if (!c) return mostrarToast("Cartão não encontrado.", true);
  document.getElementById("edit-cartao-id").value = c.id;
  document.getElementById("edit-cartao-nome").value = c.nome;
  document.getElementById("edit-cartao-limite").value = c.limiteTotal;
  document.getElementById("edit-cartao-fechamento").value = c.diaFechamento;
  document.getElementById("edit-cartao-vencimento").value = c.diaVencimento;
  document.getElementById("edit-cartao-ativo").value = c.ativo !== false ? "true" : "false";
  document.getElementById("modal-editar-cartao").classList.add("active");
}
function fecharModalEditarCartao() {
  document.getElementById("modal-editar-cartao").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-cartao").addEventListener("click", fecharModalEditarCartao);
document.getElementById("modal-editar-cartao").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-cartao") fecharModalEditarCartao();
});

document.getElementById("btn-salvar-edicao-cartao").addEventListener("click", async () => {
  const id = document.getElementById("edit-cartao-id").value;
  const nome = document.getElementById("edit-cartao-nome").value.trim();
  const limiteTotal = Number(document.getElementById("edit-cartao-limite").value);
  const diaFechamento = Number(document.getElementById("edit-cartao-fechamento").value);
  const diaVencimento = Number(document.getElementById("edit-cartao-vencimento").value);
  const ativo = document.getElementById("edit-cartao-ativo").value === "true";
  if (!nome || !limiteTotal || !diaFechamento || !diaVencimento) return mostrarToast("Preencha todos os campos.", true);
  if (diaFechamento < 1 || diaFechamento > 31 || diaVencimento < 1 || diaVencimento > 31) {
    return mostrarToast("Dia de fechamento/vencimento inválido (1 a 31).", true);
  }
  try {
    await updateDoc(doc(db, "cartoes", id), { nome, limiteTotal, diaFechamento, diaVencimento, ativo });
    mostrarToast("Cartão atualizado!");
    fecharModalEditarCartao();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-cartao").addEventListener("click", async () => {
  const id = document.getElementById("edit-cartao-id").value;
  if (!confirm("Excluir este cartão? Movimentações e compras já lançadas continuam existindo, só deixam de referenciar um cartão válido.")) return;
  try {
    await deleteDoc(doc(db, "cartoes", id));
    mostrarToast("Cartão excluído.");
    fecharModalEditarCartao();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function preencherSelectCartoes() {
  const opcoes = STATE.cartoes.map((c) => {
    const disponivel = (Number(c.limiteTotal) || 0) - calcularLimiteUtilizado(c.id);
    return `<option value="${c.id}">${esc(c.nome)} (disponível ${moeda(disponivel)})</option>`;
  }).join("");
  ["compra-cartao", "edit-compra-cartao", "qa-compra-cartao"].forEach((id) => {
    const sel = document.getElementById(id);
    if (!STATE.cartoes.length) {
      sel.innerHTML = '<option value="">Cadastre um cartão primeiro</option>';
      return;
    }
    const valorAtual = sel.value;
    sel.innerHTML = opcoes;
    if (valorAtual) sel.value = valorAtual;
  });
}

// Lista "achatada" de todo gasto já lançado no cartão (cada parcela de cada
// compra), pra corrigir rapidinho um erro de valor/data/responsável sem
// precisar ir até Movimentações e procurar. Reaproveita o mesmo modal de
// edição de movimentação (com o mesmo registro em Histórico).
function renderParcelasCartao() {
  const body = document.getElementById("parcelas-cartao-body");
  if (!body) return;
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));

  const parcelas = STATE.movimentacoes.filter((m) => m.cartaoId);
  if (!parcelas.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum gasto lançado no cartão ainda.</td></tr>';
    return;
  }
  const ordenadas = [...parcelas].sort((a, b) => (a.data < b.data ? 1 : -1));
  body.innerHTML = ordenadas.map((m) => {
    const compra = mapaCompra[m.compraParceladaId];
    const descricao = compra ? compra.descricao : "(compra excluída)";
    const cartaoNome = (mapaCartao[m.cartaoId] || {}).nome || "(excluído)";
    return (
      `<tr class="linha-clicavel" data-abrir-mov="${m.id}"><td>${dataBR(m.data)}</td><td>${esc(descricao)}</td>` +
      `<td>${esc(cartaoNome)}</td><td>${esc(m.responsavel || "")}</td><td class="num">${moeda(m.valor)}</td>` +
      `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
    );
  }).join("");
  body.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-alternar-pagamento]")) return;
      abrirModalMovimentacao(tr.dataset.abrirMov);
    });
  });
  body.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
    stamp.addEventListener("click", (e) => {
      e.stopPropagation();
      alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
    });
  });
}

function renderComprasParceladas() {
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));

  const body = document.getElementById("compras-body");
  if (!STATE.comprasParceladas.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma compra parcelada registrada ainda.</td></tr>';
    return;
  }
  // Data da compra manda (mais recente primeiro); no empate (mesma data),
  // desempata por ordem de cadastro (mais recém-lançada primeiro).
  const ordenadas = [...STATE.comprasParceladas].sort((a, b) => {
    if (a.dataCompra !== b.dataCompra) return a.dataCompra < b.dataCompra ? 1 : -1;
    return tsParaMillis(b.dataRegistro) - tsParaMillis(a.dataRegistro);
  });
  body.innerHTML = ordenadas.map((c) => {
    const numParcelas = Number(c.numParcelas) || 1;
    const valorTotal = Number(c.valorTotal) || 0;
    const valorParcela = arredondar2(valorTotal / numParcelas);
    return (
      `<tr class="linha-clicavel" data-abrir-compra="${c.id}"><td>${esc(c.descricao)}</td><td>${esc((mapaCartao[c.cartaoId] || {}).nome || "(excluído)")}</td><td>${esc(c.responsavel || "")}</td>` +
      `<td class="num">${moeda(valorTotal)}</td><td>${numParcelas}x</td>` +
      `<td class="num">${moeda(valorParcela)}</td><td>${dataBR(c.dataCompra)}</td></tr>`
    );
  }).join("");
  document.querySelectorAll("[data-abrir-compra]").forEach((tr) => {
    tr.addEventListener("click", () => abrirModalEditarCompra(tr.dataset.abrirCompra));
  });
}

function abrirModalEditarCompra(id) {
  const c = STATE.comprasParceladas.find((x) => x.id === id);
  if (!c) return mostrarToast("Compra não encontrada.", true);
  preencherSelectsLancamento();
  preencherSelectCartoes();
  preencherSelectsPessoa();
  document.getElementById("edit-compra-id").value = c.id;
  document.getElementById("edit-compra-cartao").value = c.cartaoId;
  definirComboLancamento("edit-compra-lancamento", c.lancamentoId);
  document.getElementById("edit-compra-descricao").value = c.descricao;
  garantirOpcaoPessoa("edit-compra-responsavel", c.responsavel || "");
  document.getElementById("edit-compra-valor").value = c.valorTotal;
  document.getElementById("edit-compra-parcelas").value = c.numParcelas;
  document.getElementById("edit-compra-data").value = c.dataCompra;

  const numParcelas = Number(c.numParcelas) || 1;
  const naoPagas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id && m.pago !== true);
  const paidCount = numParcelas - naoPagas.length;
  const travar = !naoPagas.length;
  ["edit-compra-cartao", "edit-compra-valor", "edit-compra-parcelas", "edit-compra-data"].forEach((elId) => {
    document.getElementById(elId).disabled = travar;
  });
  document.getElementById("edit-compra-info").textContent = travar
    ? "Todas as parcelas dessa compra já foram pagas — só descrição, lançamento e responsável ainda podem ser alterados."
    : `${paidCount} de ${numParcelas} parcela(s) já paga(s). Mudar cartão, valor, nº de parcelas ou data recalcula automaticamente só as ${naoPagas.length} parcela(s) ainda não paga(s) — as pagas não são tocadas.`;
  document.getElementById("modal-editar-compra").classList.add("active");
}
function fecharModalEditarCompra() {
  document.getElementById("modal-editar-compra").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-compra").addEventListener("click", fecharModalEditarCompra);
document.getElementById("modal-editar-compra").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-compra") fecharModalEditarCompra();
});

async function salvarEdicaoCompra(forcarRecalculo) {
  const id = document.getElementById("edit-compra-id").value;
  const cartaoId = document.getElementById("edit-compra-cartao").value;
  const lancamentoId = document.getElementById("edit-compra-lancamento").value;
  const descricao = document.getElementById("edit-compra-descricao").value.trim();
  const responsavel = document.getElementById("edit-compra-responsavel").value.trim();
  const valorTotal = Number(document.getElementById("edit-compra-valor").value);
  const numParcelas = Number(document.getElementById("edit-compra-parcelas").value);
  const dataCompra = document.getElementById("edit-compra-data").value;

  if (!descricao) return mostrarToast("A descrição não pode ficar em branco.", true);
  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!cartaoId) return mostrarToast("Selecione um cartão.", true);
  if (!valorTotal || valorTotal <= 0) return mostrarToast("Informe um valor total válido.", true);
  if (!numParcelas || numParcelas < 1 || numParcelas > 60) return mostrarToast("Número de parcelas inválido (1 a 60).", true);
  if (!dataCompra) return mostrarToast("Informe a data da compra.", true);

  const atual = STATE.comprasParceladas.find((x) => x.id === id);
  if (!atual) return mostrarToast("Compra não encontrada.", true);
  const cartao = STATE.cartoes.find((c) => c.id === cartaoId);
  if (!cartao) return mostrarToast("Cartão não encontrado.", true);

  const parcelas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id);
  const pagas = [...parcelas.filter((m) => m.pago === true)].sort((a, b) => (a.data < b.data ? -1 : 1));
  const naoPagas = [...parcelas.filter((m) => m.pago !== true)].sort((a, b) => (a.data < b.data ? -1 : 1));
  const paidCount = pagas.length;
  const somaPagas = arredondar2(pagas.reduce((s, m) => s + (Number(m.valor) || 0), 0));

  const valorTotalAtual = arredondar2(Number(atual.valorTotal) || 0);
  const numParcelasAtual = Number(atual.numParcelas) || 1;
  const afetaCronograma =
    forcarRecalculo ||
    cartaoId !== atual.cartaoId ||
    dataCompra !== atual.dataCompra ||
    numParcelas !== numParcelasAtual ||
    arredondar2(valorTotal) !== valorTotalAtual;

  if (afetaCronograma) {
    if (!naoPagas.length) {
      return mostrarToast(
        forcarRecalculo
          ? "Todas as parcelas dessa compra já foram pagas — não há mais nada pra recalcular."
          : "Todas as parcelas já foram pagas — cartão, valor, parcelas e data não podem mais ser ajustados.",
        true
      );
    }
    if (numParcelas < paidCount) {
      return mostrarToast(`Já foram pagas ${paidCount} parcela(s) — o número de parcelas não pode ser menor que isso.`, true);
    }
    if (arredondar2(valorTotal - somaPagas) < 0) {
      return mostrarToast(`O valor total não pode ser menor que o já pago (${moeda(somaPagas)}).`, true);
    }
  }

  const alteracoes = [];
  if (atual.descricao !== descricao) alteracoes.push({ campo: "Descrição", antes: atual.descricao, depois: descricao });
  if ((atual.responsavel || "") !== responsavel) alteracoes.push({ campo: "Responsável", antes: atual.responsavel || "—", depois: responsavel || "—" });
  if (arredondar2(valorTotal) !== valorTotalAtual) alteracoes.push({ campo: "Valor total", antes: moeda(valorTotalAtual), depois: moeda(valorTotal) });
  if (numParcelas !== numParcelasAtual) alteracoes.push({ campo: "Nº de parcelas", antes: String(numParcelasAtual), depois: String(numParcelas) });
  if (atual.dataCompra !== dataCompra) alteracoes.push({ campo: "Data da compra", antes: dataBR(atual.dataCompra), depois: dataBR(dataCompra) });
  const mapaLanc = mapaLancamentos();
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));
  if (atual.cartaoId !== cartaoId) {
    alteracoes.push({ campo: "Cartão", antes: (mapaCartao[atual.cartaoId] || {}).nome || "(excluído)", depois: cartao.nome });
  }
  if (atual.lancamentoId !== lancamentoId) {
    alteracoes.push({ campo: "Lançamento", antes: (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)", depois: (mapaLanc[lancamentoId] || {}).nome || "(excluído)" });
  }

  if (!alteracoes.length && !forcarRecalculo) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalEditarCompra();
    return;
  }
  if (!alteracoes.length && forcarRecalculo) {
    alteracoes.push({ campo: "Parcelas", antes: "—", depois: "Recalculadas manualmente com os dados atuais" });
  }

  // Se algo que afeta o cronograma mudou (cartão, valor, nº de parcelas ou
  // data), checa se o novo valor restante cabe no limite do cartão de
  // destino — descontando as parcelas não pagas desta própria compra, que
  // serão substituídas (senão o limite delas contaria em dobro).
  if (afetaCronograma) {
    const valorRestante = arredondar2(valorTotal - somaPagas);
    const naoPagasNoCartaoDestino = naoPagas
      .filter((m) => String(m.cartaoId) === String(cartaoId))
      .reduce((s, m) => s + (Number(m.valor) || 0), 0);
    const limiteDisponivel = (Number(cartao.limiteTotal) || 0) - (calcularLimiteUtilizado(cartaoId) - naoPagasNoCartaoDestino);
    if (valorRestante > limiteDisponivel) {
      return mostrarToast("Limite insuficiente nesse cartão. Disponível: " + moeda(limiteDisponivel), true);
    }
  }

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "comprasParceladas", id), { cartaoId, lancamentoId, descricao, responsavel, valorTotal, numParcelas, dataCompra });

    if (afetaCronograma) {
      // Apaga só as parcelas ainda não pagas e recria a partir da posição
      // seguinte à última já paga, usando a mesma regra de fechamento da
      // criação (calcularCicloInicial + calcularProximoVencimento).
      naoPagas.forEach((m) => batch.delete(doc(db, "movimentacoes", m.id)));

      const parcelasRestantes = numParcelas - paidCount;
      const valorRestante = arredondar2(valorTotal - somaPagas);
      const valorPorParcela = arredondar2(valorRestante / parcelasRestantes);
      const ciclo = calcularCicloInicial(dataCompra, Number(cartao.diaFechamento));

      for (let i = paidCount; i < numParcelas; i++) {
        const mesRef = new Date(ciclo.ano, ciclo.mes + i, 1);
        const vencimento = calcularProximoVencimento(cartao.diaVencimento, mesRef);
        const idxRestante = i - paidCount;
        const valorDaParcela = idxRestante === parcelasRestantes - 1
          ? arredondar2(valorRestante - valorPorParcela * (parcelasRestantes - 1))
          : valorPorParcela;
        const movRef = doc(collection(db, "movimentacoes"));
        batch.set(movRef, {
          lancamentoId, data: vencimento, valor: valorDaParcela, pago: false, responsavel,
          origem: `Cartao ${i + 1}/${numParcelas}`, cartaoId, compraParceladaId: id, createdAt: serverTimestamp()
        });
      }
      // Parcelas já pagas continuam com data/valor intactos (viraram
      // histórico) — só atualiza responsável e o rótulo "i/numParcelas",
      // já que o total de parcelas pode ter mudado.
      pagas.forEach((m, idx) => {
        const dadosMov = { origem: `Cartao ${idx + 1}/${numParcelas}` };
        if ((m.responsavel || "") !== responsavel) dadosMov.responsavel = responsavel;
        batch.update(doc(db, "movimentacoes", m.id), dadosMov);
      });
    } else {
      // Nada que afete o cronograma mudou — só propaga responsável.
      parcelas.forEach((m) => {
        if ((m.responsavel || "") !== responsavel) {
          batch.update(doc(db, "movimentacoes", m.id), { responsavel });
        }
      });
    }

    const nomeLanc = (mapaLanc[lancamentoId] || {}).nome || "(excluído)";
    alteracoes.forEach((a) => {
      const histRef = doc(collection(db, "historico"));
      batch.set(histRef, {
        lancamentoId, nomeLancamento: `${nomeLanc} (compra: ${descricao})`, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de compra no cartão", dataHora: serverTimestamp()
      });
    });

    await batch.commit();
    mostrarToast(
      forcarRecalculo
        ? "Parcelas recalculadas com os dados atuais."
        : `Compra atualizada (${alteracoes.length} campo(s) alterado(s))${afetaCronograma ? " — parcelas recalculadas" : ""}.`
    );
    fecharModalEditarCompra();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
}

document.getElementById("btn-salvar-edicao-compra").addEventListener("click", () => salvarEdicaoCompra(false));
document.getElementById("btn-recalcular-compra").addEventListener("click", () => {
  if (!confirm("Recalcular as parcelas ainda não pagas desta compra com os dados atuais? Útil se elas foram criadas antes de algum ajuste na regra do sistema.")) return;
  salvarEdicaoCompra(true);
});

document.getElementById("btn-excluir-compra").addEventListener("click", async () => {
  const id = document.getElementById("edit-compra-id").value;
  if (!confirm("Excluir esta compra? As parcelas ainda não pagas serão removidas de Movimentações. Parcelas já pagas continuam registradas.")) return;
  try {
    const parcelasNaoPagas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id && m.pago !== true);
    for (const p of parcelasNaoPagas) {
      await deleteDoc(doc(db, "movimentacoes", p.id));
    }
    await deleteDoc(doc(db, "comprasParceladas", id));
    mostrarToast(`Compra excluída (${parcelasNaoPagas.length} parcela(s) pendente(s) removida(s)).`);
    fecharModalEditarCompra();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

/* ══════════════ CONEXÕES BANCÁRIAS (Open Finance via Pluggy — só leitura) ══════════════
 *
 * Escopo desta integração: importar transações/saldos do banco PRA DENTRO
 * do app, como movimentações normais. Não existe (e não deve ser criado)
 * nenhum caminho de código aqui que iniciе pagamento, transferência, PIX ou
 * qualquer outra ação que mexa em dinheiro de verdade — é leitura, ponto.
 *
 * O app.js nunca guarda nem vê clientId/clientSecret da Pluggy: ele só
 * conversa com o Code.gs (Apps Script Web App, URL em PLUGGY_PROXY_URL),
 * que é quem tem as credenciais (Script Properties) e fala com a API da
 * Pluggy. O widget "Pluggy Connect" (carregado no index.html) é quem
 * mostra a tela de login do banco — dentro do iframe controlado pela
 * própria Pluggy, este app nunca vê usuário/senha do banco.
 */

// Chama o proxy (Code.gs) com uma ação e devolve a resposta já validada.
async function chamarProxyPluggy(body) {
  if (!PLUGGY_PROXY_URL || PLUGGY_PROXY_URL.startsWith("COLE_AQUI")) {
    throw new Error("Configure PLUGGY_PROXY_URL em firebase-init.js primeiro (veja o README).");
  }
  const resp = await fetch(PLUGGY_PROXY_URL, {
    method: "POST",
    body: JSON.stringify(body)
  }).then((r) => r.json());
  if (!resp || resp.ok === false) {
    throw new Error((resp && resp.erro) || "Erro na integração bancária.");
  }
  return resp;
}

function renderConexoes() {
  const grid = document.getElementById("conexoes-grid");
  if (!grid) return;
  if (!STATE.conexoesBancarias.length) {
    grid.innerHTML = '<div class="empty">Nenhum banco conectado ainda. Clique em "+ Conectar novo banco" pra começar.</div>';
    return;
  }
  const ordenadas = [...STATE.conexoesBancarias].sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));
  grid.innerHTML = ordenadas.map((c) => {
    const statusClasse = c.status === "conectado" ? "conectado" : (c.status === "reconexao_necessaria" ? "reconexao" : "erro");
    const statusTexto = c.status === "conectado" ? "CONECTADO" : (c.status === "reconexao_necessaria" ? "RECONEXÃO NECESSÁRIA" : "ERRO");
    const ultimaSinc = c.ultimaSincronizacao ? fmtDataHora(c.ultimaSincronizacao) : "nunca sincronizado";
    const incluido = c.ativoParaPessoal !== false;
    return (
      `<div class="conexao-card${incluido ? "" : " conexao-oculta"}">` +
      `<div class="conexao-topo"><h3>${esc(c.instituicao || "Banco")}</h3><span class="stamp ${statusClasse}">${statusTexto}</span></div>` +
      `<div class="conexao-info">Última sincronização: ${esc(ultimaSinc)}</div>` +
      `<label class="conexao-toggle"><input type="checkbox" data-alternar-inclusao-pessoal="${c.id}" data-novo-valor="${!incluido}" ${incluido ? "checked" : ""}> Incluir no uso pessoal (Dashboard e Movimentações)</label>` +
      `<button class="btn btn-primary" data-sincronizar-conexao="${c.id}">🔄 Sincronizar agora</button>` +
      `</div>`
    );
  }).join("");
  grid.querySelectorAll("[data-sincronizar-conexao]").forEach((btn) => {
    btn.addEventListener("click", () => sincronizarConexao(btn.dataset.sincronizarConexao));
  });
  grid.querySelectorAll("[data-alternar-inclusao-pessoal]").forEach((chk) => {
    chk.addEventListener("change", async () => {
      try {
        await updateDoc(doc(db, "conexoesBancarias", chk.dataset.alternarInclusaoPessoal), { ativoParaPessoal: chk.dataset.novoValor === "true" });
      } catch (err) {
        mostrarToast("Não foi possível salvar: " + err.message, true);
      }
    });
  });
}

// Garante que existe um lançamento genérico "Importado do banco" pro tipo
// pedido (Entrada ou Saída) — reaproveita se já existe um com esse nome E
// esse tipo, senão cria. É pra onde vão transações importadas sem categoria
// própria; o usuário edita a movimentação normalmente depois pra recategorizar.
async function garantirLancamentoImportado(tipo) {
  const nome = "Importado do banco";
  const existente = STATE.lancamentos.find((l) => l.nome === nome && l.tipo === tipo);
  if (existente) return existente.id;
  const ref = await addDoc(collection(db, "lancamentos"), {
    nome, tipo, categoria: "Open Finance (a revisar)", createdAt: serverTimestamp()
  });
  return ref.id;
}

// Busca contas + transações (últimos 90 dias) de uma conexão, ignora o que
// já foi importado antes (dedupe por pluggyTransactionId) e grava o resto
// em lote como movimentações normais.
async function sincronizarConexao(conexaoId) {
  const conexao = STATE.conexoesBancarias.find((c) => c.id === conexaoId);
  if (!conexao) return mostrarToast("Conexão não encontrada.", true);
  try {
    mostrarToast(`Sincronizando ${conexao.instituicao || "banco"}...`);

    const respContas = await chamarProxyPluggy({ action: "listAccounts", itemId: conexao.itemId });
    const contas = respContas.accounts || [];
    if (!contas.length) {
      await updateDoc(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
      mostrarToast("Nenhuma conta encontrada nesta conexão.");
      return;
    }

    const hoje = new Date();
    const de = new Date(hoje);
    de.setDate(de.getDate() - 90);
    const dataDe = formatarDataISO(de);
    const dataAte = formatarDataISO(hoje);

    // "cartao" vem do type "CREDIT" que a Pluggy devolve pra cartão de
    // crédito — é só uma etiqueta pra filtrar em Movimentações, não tem
    // nenhuma relação com o cadastro manual de cartões (fatura, parcelas
    // etc.) — são dois jeitos independentes de registrar gasto no cartão.
    let todasTransacoes = [];
    for (const conta of contas) {
      const contaTipo = conta.type === "CREDIT" ? "cartao" : "banco";
      const respTrans = await chamarProxyPluggy({ action: "listTransactions", accountId: conta.id, from: dataDe, to: dataAte });
      (respTrans.transactions || []).forEach((t) => { t._contaTipo = contaTipo; });
      todasTransacoes = todasTransacoes.concat(respTrans.transactions || []);
    }

    const jaImportadas = new Set(STATE.movimentacoes.map((m) => m.pluggyTransactionId).filter(Boolean));
    const novas = todasTransacoes.filter((t) => t.id && !jaImportadas.has(t.id));

    if (!novas.length) {
      await updateDoc(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
      mostrarToast("Tudo em dia — nenhuma transação nova.");
      return;
    }

    // Cria (ou reaproveita) os lançamentos genéricos ANTES do lote, pra já
    // ter o ID deles na hora de gravar as movimentações.
    const lancEntradaId = await garantirLancamentoImportado("Entrada");
    const lancSaidaId = await garantirLancamentoImportado("Saida");

    const batch = writeBatch(db);
    novas.forEach((t) => {
      const valor = Number(t.amount) || 0;
      const tipo = valor < 0 ? "Saida" : "Entrada";
      const lancamentoId = tipo === "Saida" ? lancSaidaId : lancEntradaId;
      const movRef = doc(collection(db, "movimentacoes"));
      // Transação já aconteceu no extrato do banco, então entra como "paga"
      // — é histórico, não uma previsão.
      batch.set(movRef, {
        lancamentoId, data: String(t.date || dataAte).slice(0, 10), valor: Math.abs(arredondar2(valor)), pago: true,
        responsavel: "", origem: "Open Finance", cartaoId: null, compraParceladaId: null,
        pluggyTransactionId: t.id, conexaoId: conexaoId, instituicao: conexao.instituicao || "Banco",
        contaTipo: t._contaTipo || "banco", revisado: false, descricaoOrigem: t.description || t.descriptionRaw || "",
        createdAt: serverTimestamp()
      });
    });
    batch.update(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
    await batch.commit();
    mostrarToast(`${novas.length} transação(ões) importada(s) de ${conexao.instituicao || "banco"}. Recategorize em Movimentações se quiser.`);
  } catch (err) {
    mostrarToast("Não foi possível sincronizar: " + err.message, true);
    try { await updateDoc(doc(db, "conexoesBancarias", conexaoId), { status: "erro" }); } catch (err2) { /* ignora falha secundária */ }
  }
}

const btnConectarBanco = document.getElementById("btn-conectar-banco");
if (btnConectarBanco) {
  btnConectarBanco.addEventListener("click", async () => {
    try {
      const resp = await chamarProxyPluggy({ action: "connectToken" });
      if (!resp.connectToken) throw new Error("Token de conexão não recebido.");
      if (typeof window.PluggyConnect === "undefined") {
        throw new Error("Widget da Pluggy Connect não carregou — confira o <script> no index.html.");
      }
      const pluggyConnect = new window.PluggyConnect({
        connectToken: resp.connectToken,
        // Sandbox da Pluggy (plano gratuito) só conecta a bancos de teste —
        // troque pra false só depois de migrar pra uma conta de produção
        // (veja o README, seção "Conexões Bancárias").
        includeSandbox: true,
        onSuccess: async (itemData) => {
          try {
            const item = (itemData && itemData.item) || {};
            const instituicao = (item.connector && item.connector.name) || "Banco conectado";
            const ref = await addDoc(collection(db, "conexoesBancarias"), {
              itemId: item.id, instituicao, status: "conectado", ultimaSincronizacao: null,
              ativoParaPessoal: true, createdAt: serverTimestamp()
            });
            mostrarToast("Banco conectado! Importando as transações...");
            await sincronizarConexao(ref.id);
          } catch (err) {
            mostrarToast("Banco conectado, mas não foi possível salvar a conexão: " + err.message, true);
          }
        },
        onError: () => mostrarToast("Não foi possível conectar o banco. Tente novamente.", true)
      });
      pluggyConnect.init();
    } catch (err) {
      mostrarToast("Não foi possível iniciar a conexão bancária: " + err.message, true);
    }
  });
}

/* ══════════════ CUSTOS RECORRENTES ══════════════ */

function renderRecKpis() {
  const ativos = STATE.recorrentes.filter((r) => r.ativo === true);
  const inativos = STATE.recorrentes.filter((r) => r.ativo !== true);
  const totalMensalAtivos = ativos.reduce((s, r) => s + (Number(r.valor) || 0), 0);
  document.getElementById("rec-kpi-grid").innerHTML =
    kpiCard("Recorrentes ativos", String(ativos.length), true) +
    kpiCard("Recorrentes inativos", String(inativos.length), inativos.length === 0) +
    kpiCard("Total mensal (ativos)", moeda(totalMensalAtivos), true);
}

function renderRecorrentes() {
  const mapaLanc = mapaLancamentos();
  const body = document.getElementById("recs-body");
  if (!STATE.recorrentes.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhum custo recorrente cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.recorrentes.map((r) => {
      const nomeLanc = (mapaLanc[r.lancamentoId] || {}).nome || "(excluído)";
      const prox = calcularProximoVencimento(r.diaVencimento);
      return (
        `<tr class="linha-clicavel" data-abrir-recorrente="${r.id}"><td>${esc(nomeLanc)}</td><td class="num">${moeda(r.valor)}</td><td>${r.diaVencimento}</td>` +
        `<td>${dataBR(prox)}</td><td><span class="stamp ${r.ativo ? "ativo" : "inativo"}" data-alternar-ativo="${r.id}" data-novo-ativo="${!r.ativo}">${r.ativo ? "ATIVO" : "INATIVO"}</span></td></tr>`
      );
    }).join("");
    document.querySelectorAll("[data-abrir-recorrente]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalEditarRecorrente(tr.dataset.abrirRecorrente));
    });
    document.querySelectorAll("[data-alternar-ativo]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarAtivoRecorrente(stamp.dataset.alternarAtivo, stamp.dataset.novoAtivo === "true");
      });
    });
  }
  renderRecKpis();
}

function abrirModalEditarRecorrente(id) {
  const r = STATE.recorrentes.find((x) => x.id === id);
  if (!r) return mostrarToast("Custo recorrente não encontrado.", true);
  preencherSelectsLancamento();
  document.getElementById("edit-rec-id").value = r.id;
  definirComboLancamento("edit-rec-lancamento", r.lancamentoId);
  document.getElementById("edit-rec-valor").value = r.valor;
  document.getElementById("edit-rec-inicio").value = r.dataInicio;
  document.getElementById("edit-rec-dia").value = r.diaVencimento;
  document.getElementById("edit-rec-ativo").value = r.ativo ? "true" : "false";
  document.getElementById("modal-editar-recorrente").classList.add("active");
}
function fecharModalEditarRecorrente() {
  document.getElementById("modal-editar-recorrente").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-rec").addEventListener("click", fecharModalEditarRecorrente);
document.getElementById("modal-editar-recorrente").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-recorrente") fecharModalEditarRecorrente();
});

document.getElementById("btn-salvar-edicao-rec").addEventListener("click", async () => {
  const id = document.getElementById("edit-rec-id").value;
  const lancamentoId = document.getElementById("edit-rec-lancamento").value;
  const valor = Number(document.getElementById("edit-rec-valor").value);
  const dataInicio = document.getElementById("edit-rec-inicio").value;
  const diaVencimento = Number(document.getElementById("edit-rec-dia").value);
  const ativo = document.getElementById("edit-rec-ativo").value === "true";
  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!valor || !dataInicio || !diaVencimento) return mostrarToast("Preencha valor, data de início e dia de vencimento.", true);
  try {
    await updateDoc(doc(db, "recorrentes", id), { lancamentoId, valor, dataInicio, diaVencimento, ativo });
    mostrarToast("Custo recorrente atualizado!");
    fecharModalEditarRecorrente();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-recorrente").addEventListener("click", async () => {
  const id = document.getElementById("edit-rec-id").value;
  if (!confirm("Excluir este custo recorrente? Movimentações já lançadas por ele não são afetadas.")) return;
  try {
    await deleteDoc(doc(db, "recorrentes", id));
    mostrarToast("Custo recorrente excluído.");
    fecharModalEditarRecorrente();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function renderHistorico() {
  const body = document.getElementById("historico-body");
  if (!STATE.historico.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Nenhuma alteração registrada ainda.</td></tr>';
    return;
  }
  const ordenado = [...STATE.historico].sort((a, b) => tsParaMillis(b.dataHora) - tsParaMillis(a.dataHora));
  body.innerHTML = ordenado.map((h) => (
    `<tr><td>${fmtDataHora(h.dataHora)}</td><td>${esc(h.nomeLancamento || "")}</td>` +
    `<td><span class="campo-alterado">${esc(h.campo)}</span></td>` +
    `<td>${esc(h.valorAnterior)}</td><td>${esc(h.valorNovo)}</td><td>${esc(h.tipoAlteracao)}</td></tr>`
  )).join("");
}

function kpiCard(label, value, positivo) {
  return (
    `<div class="kpi-card ${positivo ? "positive" : "negative"}">` +
    `<div class="label">${label}</div>` +
    `<div class="value num">${value}</div></div>`
  );
}

function renderDashboard() {
  const d = calcularDashboard();
  document.getElementById("kpi-grid").innerHTML =
    kpiCard("Saldo atual", moeda(d.saldoAtual), d.saldoAtual >= 0) +
    kpiCard("Saldo previsto", moeda(d.saldoPrevisto), d.saldoPrevisto >= 0) +
    kpiCard("Gasto sugerido / dia", moeda(d.gastoSugerido) + ` <small>(${d.diasRestantes} dias)</small>`, d.gastoSugerido >= 0) +
    kpiCard("% da renda gasta no mês", d.percentualRendaGasta.toFixed(1) + "%", d.percentualRendaGasta <= 100) +
    kpiCard("Gasto permitido até hoje", moeda(d.gastoPermitidoAteHoje), true) +
    kpiCard("Parcelas futuras no cartão", moeda(d.parcelasCartaoFuturas), true);
}

/* ══════════════ LANÇAMENTOS ══════════════ */

document.getElementById("btn-add-lancamento").addEventListener("click", async () => {
  const nome = document.getElementById("lanc-nome").value.trim();
  const tipo = document.getElementById("lanc-tipo").value;
  const categoria = document.getElementById("lanc-categoria").value.trim();
  if (!nome || !categoria) return mostrarToast("Preencha nome e categoria.", true);
  try {
    await addDoc(collection(db, "lancamentos"), { nome, tipo, categoria, createdAt: serverTimestamp() });
    mostrarToast("Lançamento cadastrado!");
    document.getElementById("lanc-nome").value = "";
    document.getElementById("lanc-categoria").value = "";
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

function abrirModalEdicaoLancamento(id) {
  const lanc = STATE.lancamentos.find((l) => l.id === id);
  if (!lanc) return mostrarToast("Lançamento não encontrado.", true);
  document.getElementById("edit-lanc-id").value = lanc.id;
  document.getElementById("edit-lanc-nome").value = lanc.nome;
  document.getElementById("edit-lanc-tipo").value = lanc.tipo;
  document.getElementById("edit-lanc-categoria").value = lanc.categoria;
  document.getElementById("modal-editar").classList.add("active");
}
function fecharModalEdicaoLancamento() {
  document.getElementById("modal-editar").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-lanc").addEventListener("click", fecharModalEdicaoLancamento);
document.getElementById("modal-editar").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar") fecharModalEdicaoLancamento();
});

document.getElementById("btn-salvar-edicao-lanc").addEventListener("click", async () => {
  const id = document.getElementById("edit-lanc-id").value;
  const nome = document.getElementById("edit-lanc-nome").value.trim();
  const tipo = document.getElementById("edit-lanc-tipo").value;
  const categoria = document.getElementById("edit-lanc-categoria").value.trim();
  if (!nome) return mostrarToast("O nome não pode ficar em branco.", true);
  if (!categoria) return mostrarToast("A categoria não pode ficar em branco.", true);

  const atual = STATE.lancamentos.find((l) => l.id === id);
  if (!atual) return mostrarToast("Lançamento não encontrado.", true);

  const alteracoes = [];
  if (atual.nome !== nome) alteracoes.push({ campo: "Nome", antes: atual.nome, depois: nome });
  if (atual.tipo !== tipo) alteracoes.push({ campo: "Tipo", antes: atual.tipo, depois: tipo });
  if (atual.categoria !== categoria) alteracoes.push({ campo: "Categoria", antes: atual.categoria, depois: categoria });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalEdicaoLancamento();
    return;
  }

  try {
    await updateDoc(doc(db, "lancamentos", id), { nome, tipo, categoria });
    for (const a of alteracoes) {
      await addDoc(collection(db, "historico"), {
        lancamentoId: id, nomeLancamento: nome, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição", dataHora: serverTimestamp()
      });
    }
    mostrarToast(`Lançamento atualizado (${alteracoes.length} campo(s) alterado(s)).`);
    fecharModalEdicaoLancamento();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ MOVIMENTAÇÕES ══════════════ */

// Lógica central de criar movimentação — usada tanto pelo formulário da
// aba Movimentações quanto pelo modal de Ação Rápida.
async function criarMovimentacao({ lancamentoId, data, valor, pago, responsavel }) {
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!data || !valor) { mostrarToast("Preencha data e valor.", true); return false; }
  try {
    await addDoc(collection(db, "movimentacoes"), {
      lancamentoId, data, valor, pago, responsavel, origem: "Manual", cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
    });
    mostrarToast("Movimentação adicionada!");
    return true;
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-movimentacao").addEventListener("click", async () => {
  const ok = await criarMovimentacao({
    lancamentoId: document.getElementById("mov-lancamento").value,
    data: document.getElementById("mov-data").value,
    valor: Number(document.getElementById("mov-valor").value),
    pago: document.getElementById("mov-pago").value === "true",
    responsavel: document.getElementById("mov-responsavel").value.trim()
  });
  if (ok) {
    document.getElementById("mov-valor").value = "";
    document.getElementById("mov-responsavel").value = "";
  }
});

async function alternarPagamento(id, novoPago) {
  try {
    await updateDoc(doc(db, "movimentacoes", id), { pago: novoPago });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

function abrirModalMovimentacao(id) {
  const mov = STATE.movimentacoes.find((m) => m.id === id);
  if (!mov) return mostrarToast("Movimentação não encontrada.", true);
  preencherSelectsLancamento();
  preencherSelectsPessoa();
  document.getElementById("edit-mov-id").value = mov.id;
  definirComboLancamento("edit-mov-lancamento", mov.lancamentoId);
  document.getElementById("edit-mov-data").value = mov.data;
  document.getElementById("edit-mov-valor").value = mov.valor;
  document.getElementById("edit-mov-pago").value = mov.pago ? "true" : "false";
  garantirOpcaoPessoa("edit-mov-responsavel", mov.responsavel || "");

  const infoEl = document.getElementById("edit-mov-info");
  if (mov.origem === "Open Finance") {
    const partes = [`Importada do banco ${mov.instituicao || ""}`.trim()];
    if (mov.descricaoOrigem) partes.push(`descrição original: "${mov.descricaoOrigem}"`);
    partes.push(mov.revisado === true ? "já revisada." : "escolha o lançamento certo abaixo pra dizer do que se trata.");
    infoEl.textContent = partes.join(" — ");
    infoEl.classList.remove("hidden");
  } else {
    infoEl.textContent = "";
    infoEl.classList.add("hidden");
  }

  document.getElementById("modal-editar-mov").classList.add("active");
}
function fecharModalMovimentacao() {
  document.getElementById("modal-editar-mov").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-mov").addEventListener("click", fecharModalMovimentacao);
document.getElementById("modal-editar-mov").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-mov") fecharModalMovimentacao();
});

document.getElementById("btn-salvar-edicao-mov").addEventListener("click", async () => {
  const id = document.getElementById("edit-mov-id").value;
  const lancamentoId = document.getElementById("edit-mov-lancamento").value;
  const data = document.getElementById("edit-mov-data").value;
  const valor = Number(document.getElementById("edit-mov-valor").value);
  const pago = document.getElementById("edit-mov-pago").value === "true";
  const responsavel = document.getElementById("edit-mov-responsavel").value.trim();

  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!data || !valor) return mostrarToast("Preencha data e valor.", true);

  const atual = STATE.movimentacoes.find((m) => m.id === id);
  if (!atual) return mostrarToast("Movimentação não encontrada.", true);
  const mapaLanc = mapaLancamentos();

  const nomeAntes = (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)";
  const nomeDepois = (mapaLanc[lancamentoId] || {}).nome || "(excluído)";
  const situacaoAntes = atual.pago ? "Pago" : "Não pago";
  const situacaoDepois = pago ? "Pago" : "Não pago";

  const alteracoes = [];
  if (nomeAntes !== nomeDepois) alteracoes.push({ campo: "Lançamento", antes: nomeAntes, depois: nomeDepois });
  if (atual.data !== data) alteracoes.push({ campo: "Data", antes: dataBR(atual.data), depois: dataBR(data) });
  if (Number(atual.valor) !== valor) alteracoes.push({ campo: "Valor", antes: moeda(atual.valor), depois: moeda(valor) });
  if (situacaoAntes !== situacaoDepois) alteracoes.push({ campo: "Situação", antes: situacaoAntes, depois: situacaoDepois });
  if ((atual.responsavel || "") !== responsavel) alteracoes.push({ campo: "Responsável", antes: atual.responsavel || "—", depois: responsavel || "—" });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalMovimentacao();
    return;
  }

  const dadosAtualizar = { lancamentoId, data, valor, pago, responsavel };
  // Abrir o modal e salvar já conta como "revisado" pra transações vindas
  // do Open Finance — é o gesto de "olhei e disse do que se trata".
  if (atual.origem === "Open Finance" && atual.revisado !== true) {
    dadosAtualizar.revisado = true;
  }

  try {
    await updateDoc(doc(db, "movimentacoes", id), dadosAtualizar);
    for (const a of alteracoes) {
      await addDoc(collection(db, "historico"), {
        lancamentoId, nomeLancamento: nomeDepois, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de movimentação", dataHora: serverTimestamp()
      });
    }
    mostrarToast(`Movimentação atualizada (${alteracoes.length} campo(s) alterado(s)).`);
    fecharModalMovimentacao();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-mov").addEventListener("click", async () => {
  const id = document.getElementById("edit-mov-id").value;
  if (!confirm("Excluir esta movimentação? Isso fica registrado no Histórico de Alterações.")) return;
  const atual = STATE.movimentacoes.find((m) => m.id === id);
  if (!atual) return;
  const mapaLanc = mapaLancamentos();
  const nomeLanc = (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)";
  const resumo = `${dataBR(atual.data)} — ${moeda(atual.valor)}`;
  try {
    await addDoc(collection(db, "historico"), {
      lancamentoId: atual.lancamentoId, nomeLancamento: nomeLanc, campo: "Movimentação",
      valorAnterior: resumo, valorNovo: "(excluída)", tipoAlteracao: "Exclusão", dataHora: serverTimestamp()
    });
    await deleteDoc(doc(db, "movimentacoes", id));
    mostrarToast("Movimentação excluída.");
    fecharModalMovimentacao();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

/* ══════════════ CARTÃO DE CRÉDITO ══════════════ */

document.getElementById("btn-add-cartao").addEventListener("click", async () => {
  const nome = document.getElementById("cartao-nome").value.trim();
  const limiteTotal = Number(document.getElementById("cartao-limite").value);
  const diaFechamento = Number(document.getElementById("cartao-fechamento").value);
  const diaVencimento = Number(document.getElementById("cartao-vencimento").value);
  if (!nome || !limiteTotal || !diaFechamento || !diaVencimento) return mostrarToast("Preencha todos os campos do cartão.", true);
  if (diaFechamento < 1 || diaFechamento > 31 || diaVencimento < 1 || diaVencimento > 31) {
    return mostrarToast("Dia de fechamento/vencimento inválido (1 a 31).", true);
  }
  try {
    await addDoc(collection(db, "cartoes"), { nome, limiteTotal, diaFechamento, diaVencimento, ativo: true, createdAt: serverTimestamp() });
    mostrarToast("Cartão cadastrado!");
    ["cartao-nome", "cartao-limite", "cartao-fechamento", "cartao-vencimento"].forEach((id) => (document.getElementById(id).value = ""));
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

// Escrita em lote (compra + todas as parcelas de uma vez): não depende de
// runTransaction porque não há dois usuários disputando o mesmo limite ao
// mesmo tempo neste sistema pessoal — a checagem de limite é informativa,
// não uma trava contra corrida. Usada tanto pelo formulário da aba Cartão
// de Crédito quanto pelo modal de Ação Rápida.
async function criarCompraParcelada({ cartaoId, lancamentoId, descricao, responsavel, valorTotal, numParcelas, dataCompra }) {
  if (!cartaoId) { mostrarToast("Cadastre um cartão primeiro.", true); return false; }
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!descricao) { mostrarToast("Descreva a compra.", true); return false; }
  if (!valorTotal || !numParcelas || !dataCompra) { mostrarToast("Preencha valor, parcelas e data da compra.", true); return false; }
  if (numParcelas < 1 || numParcelas > 60) { mostrarToast("Número de parcelas inválido (1 a 60).", true); return false; }

  const cartao = STATE.cartoes.find((c) => c.id === cartaoId);
  if (!cartao) { mostrarToast("Cartão não encontrado.", true); return false; }

  const limiteDisponivel = (Number(cartao.limiteTotal) || 0) - calcularLimiteUtilizado(cartaoId);
  if (valorTotal > limiteDisponivel) {
    mostrarToast("Limite insuficiente nesse cartão. Disponível: " + moeda(limiteDisponivel), true);
    return false;
  }

  try {
    const batch = writeBatch(db);
    const compraRef = doc(collection(db, "comprasParceladas"));
    batch.set(compraRef, { cartaoId, lancamentoId, descricao, responsavel, valorTotal, numParcelas, dataCompra, dataRegistro: serverTimestamp() });

    const valorParcela = arredondar2(valorTotal / numParcelas);
    const ciclo = calcularCicloInicial(dataCompra, Number(cartao.diaFechamento));

    for (let i = 0; i < numParcelas; i++) {
      const mesRef = new Date(ciclo.ano, ciclo.mes + i, 1);
      const vencimento = calcularProximoVencimento(cartao.diaVencimento, mesRef);
      const valorDaParcela = i === numParcelas - 1
        ? arredondar2(valorTotal - valorParcela * (numParcelas - 1))
        : valorParcela;
      const movRef = doc(collection(db, "movimentacoes"));
      batch.set(movRef, {
        lancamentoId, data: vencimento, valor: valorDaParcela, pago: false, responsavel,
        origem: `Cartao ${i + 1}/${numParcelas}`, cartaoId, compraParceladaId: compraRef.id, createdAt: serverTimestamp()
      });
    }

    await batch.commit();
    mostrarToast(`${numParcelas} parcela(s) de ${moeda(valorParcela)} lançada(s) em Movimentações.`);
    return true;
  } catch (err) {
    mostrarToast("Não foi possível lançar a compra: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-compra").addEventListener("click", async () => {
  const ok = await criarCompraParcelada({
    cartaoId: document.getElementById("compra-cartao").value,
    lancamentoId: document.getElementById("compra-lancamento").value,
    descricao: document.getElementById("compra-descricao").value.trim(),
    responsavel: document.getElementById("compra-responsavel").value.trim(),
    valorTotal: Number(document.getElementById("compra-valor").value),
    numParcelas: Number(document.getElementById("compra-parcelas").value),
    dataCompra: document.getElementById("compra-data").value
  });
  if (ok) {
    document.getElementById("compra-descricao").value = "";
    document.getElementById("compra-responsavel").value = "";
    document.getElementById("compra-valor").value = "";
    document.getElementById("compra-parcelas").value = "1";
  }
});

/* ══════════════ AÇÃO RÁPIDA (botão + na barra inferior) ══════════════ */

document.querySelectorAll("#qa-tabs .qa-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#qa-tabs .qa-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".qa-form").forEach((f) => f.classList.add("hidden"));
    document.getElementById(`qa-form-${btn.dataset.qaTipo}`).classList.remove("hidden");
  });
});

function abrirModalAcaoRapida() {
  preencherSelectsLancamento();
  preencherSelectsPessoa();
  preencherSelectCartoes();

  document.querySelectorAll("#qa-tabs .qa-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
  document.querySelectorAll(".qa-form").forEach((f, i) => f.classList.toggle("hidden", i !== 0));

  document.getElementById("qa-mov-data").valueAsDate = new Date();
  document.getElementById("qa-mov-valor").value = "";
  document.getElementById("qa-mov-pago").value = "false";
  document.getElementById("qa-mov-responsavel").value = "";

  document.getElementById("qa-compra-data").valueAsDate = new Date();
  document.getElementById("qa-compra-descricao").value = "";
  document.getElementById("qa-compra-responsavel").value = "";
  document.getElementById("qa-compra-valor").value = "";
  document.getElementById("qa-compra-parcelas").value = "1";

  document.getElementById("qa-rec-inicio").valueAsDate = new Date();
  document.getElementById("qa-rec-valor").value = "";
  document.getElementById("qa-rec-dia").value = "";

  document.getElementById("modal-acao-rapida").classList.add("active");
}
function fecharModalAcaoRapida() {
  document.getElementById("modal-acao-rapida").classList.remove("active");
}
document.getElementById("btn-acao-rapida").addEventListener("click", abrirModalAcaoRapida);
document.getElementById("btn-cancelar-acao-rapida").addEventListener("click", fecharModalAcaoRapida);
document.getElementById("modal-acao-rapida").addEventListener("click", (e) => {
  if (e.target.id === "modal-acao-rapida") fecharModalAcaoRapida();
});

document.getElementById("btn-salvar-acao-rapida").addEventListener("click", async () => {
  const tipoAtivo = document.querySelector("#qa-tabs .qa-tab.active").dataset.qaTipo;
  let ok = false;

  if (tipoAtivo === "movimentacao") {
    ok = await criarMovimentacao({
      lancamentoId: document.getElementById("qa-mov-lancamento").value,
      data: document.getElementById("qa-mov-data").value,
      valor: Number(document.getElementById("qa-mov-valor").value),
      pago: document.getElementById("qa-mov-pago").value === "true",
      responsavel: document.getElementById("qa-mov-responsavel").value
    });
  } else if (tipoAtivo === "compra") {
    ok = await criarCompraParcelada({
      cartaoId: document.getElementById("qa-compra-cartao").value,
      lancamentoId: document.getElementById("qa-compra-lancamento").value,
      descricao: document.getElementById("qa-compra-descricao").value.trim(),
      responsavel: document.getElementById("qa-compra-responsavel").value,
      valorTotal: Number(document.getElementById("qa-compra-valor").value),
      numParcelas: Number(document.getElementById("qa-compra-parcelas").value),
      dataCompra: document.getElementById("qa-compra-data").value
    });
  } else if (tipoAtivo === "recorrente") {
    ok = await criarRecorrente({
      lancamentoId: document.getElementById("qa-rec-lancamento").value,
      valor: Number(document.getElementById("qa-rec-valor").value),
      dataInicio: document.getElementById("qa-rec-inicio").value,
      diaVencimento: Number(document.getElementById("qa-rec-dia").value),
      ativo: true
    });
  }

  if (ok) fecharModalAcaoRapida();
});

// Abre sozinho na primeira vez que o app carrega NESTA sessão (aba/janela
// aberta agora) — sessionStorage sobrevive a um F5 ou "puxar pra
// atualizar" na mesma aba, mas começa vazio de novo numa aba/sessão nova,
// que é exatamente o que "só ao entrar, não ao atualizar" pede. Só dispara
// depois que os lançamentos carregarem pelo menos uma vez, senão o modal
// abriria com os selects vazios.
const CHAVE_SESSAO_ACAO_RAPIDA = "finpamplona_acao_rapida_sessao";
function tentarAbrirAcaoRapidaAutomatica() {
  if (!lancamentosCarregados) return;
  if (sessionStorage.getItem(CHAVE_SESSAO_ACAO_RAPIDA)) return;
  sessionStorage.setItem(CHAVE_SESSAO_ACAO_RAPIDA, "1");
  abrirModalAcaoRapida();
}

/* ══════════════ CUSTOS RECORRENTES: criação e checagem automática ══════════════ */

// Usada tanto pelo formulário da aba Custos Recorrentes quanto pelo modal
// de Ação Rápida.
async function criarRecorrente({ lancamentoId, valor, dataInicio, diaVencimento, ativo }) {
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!valor || !dataInicio || !diaVencimento) { mostrarToast("Preencha valor, data de início e dia de vencimento.", true); return false; }
  try {
    await addDoc(collection(db, "recorrentes"), { lancamentoId, valor, dataInicio, diaVencimento, ativo, ultimoMesLancado: "", createdAt: serverTimestamp() });
    mostrarToast("Custo recorrente cadastrado!");
    return true;
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-recorrente").addEventListener("click", () => {
  criarRecorrente({
    lancamentoId: document.getElementById("rec-lancamento").value,
    valor: Number(document.getElementById("rec-valor").value),
    dataInicio: document.getElementById("rec-inicio").value,
    diaVencimento: Number(document.getElementById("rec-dia").value),
    ativo: document.getElementById("rec-ativo").value === "true"
  });
});

async function alternarAtivoRecorrente(id, novoAtivo) {
  try {
    await updateDoc(doc(db, "recorrentes", id), { ativo: novoAtivo });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

// Substitui o gatilho mensal do Apps Script (não existe "servidor" sem Cloud
// Functions): qualquer pessoa que abrir o app já dispara essa checagem uma
// vez, e lança os recorrentes que ainda não saíram este mês.
async function lancarRecorrentesPendentes(silencioso) {
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const pendentes = STATE.recorrentes.filter((r) => r.ativo === true && r.ultimoMesLancado !== mesAtual);

  if (!pendentes.length) {
    if (!silencioso) mostrarToast("Nenhum custo recorrente pendente este mês.");
    return;
  }

  let lancados = 0;
  for (const r of pendentes) {
    try {
      const vencimento = calcularProximoVencimento(r.diaVencimento, hoje);
      await addDoc(collection(db, "movimentacoes"), {
        lancamentoId: r.lancamentoId, data: vencimento, valor: Number(r.valor),
        pago: false, origem: "Recorrente", cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "recorrentes", r.id), { ultimoMesLancado: mesAtual });
      lancados++;
    } catch (err) {
      mostrarToast("Erro ao lançar recorrente: " + err.message, true);
    }
  }
  if (lancados > 0) {
    mostrarToast(`${lancados} custo(s) recorrente(s) lançado(s)${silencioso ? " automaticamente" : ""} em Movimentações.`);
  }
}

document.getElementById("btn-lancar-pendentes").addEventListener("click", () => lancarRecorrentesPendentes(false));

function tentarAutoLancarRecorrentes() {
  if (jaVerificouRecorrentesPendentes || !recorrentesCarregados) return;
  jaVerificouRecorrentesPendentes = true;
  lancarRecorrentesPendentes(true).catch(() => {});
}

/* ══════════════ PLANOS (metas de economia) ══════════════ */

function calcularPlanoInfo(p) {
  const valorAlvo = Number(p.valorAlvo) || 0;
  const valorAcumulado = Number(p.valorAcumulado) || 0;
  const falta = arredondar2(Math.max(valorAlvo - valorAcumulado, 0));
  const pct = valorAlvo > 0 ? Math.min(100, (valorAcumulado / valorAlvo) * 100) : 0;
  const concluido = valorAlvo > 0 && valorAcumulado >= valorAlvo;
  const aporteMensal = Number(p.aportePlanejadoMensal) || 0;

  let previsaoTexto = "Defina uma meta mensal ou use o simulador abaixo.";
  if (concluido) {
    previsaoTexto = "Meta alcançada! 🎉";
  } else if (aporteMensal > 0) {
    const meses = Math.ceil(falta / aporteMensal);
    const dataPrevista = new Date();
    dataPrevista.setMonth(dataPrevista.getMonth() + meses);
    previsaoTexto = `≈ ${meses} ${meses === 1 ? "mês" : "meses"} (${dataPrevista.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })})`;
  }
  return { valorAlvo, valorAcumulado, falta, pct, concluido, aporteMensal, previsaoTexto };
}

function renderPlanosKpis() {
  let totalAlvo = 0, totalAcumulado = 0;
  STATE.planos.forEach((p) => {
    totalAlvo += Number(p.valorAlvo) || 0;
    totalAcumulado += Number(p.valorAcumulado) || 0;
  });
  const totalFalta = Math.max(arredondar2(totalAlvo - totalAcumulado), 0);
  document.getElementById("planos-kpi-grid").innerHTML =
    kpiCard("Total das metas", moeda(totalAlvo), true) +
    kpiCard("Já guardado", moeda(totalAcumulado), true) +
    kpiCard("Falta guardar", moeda(totalFalta), totalFalta === 0);
}

function renderPlanos() {
  const grid = document.getElementById("planos-grid");
  renderPlanosKpis();
  if (!STATE.planos.length) {
    grid.innerHTML = '<div class="empty">Nenhum plano cadastrado ainda. Clique em "+ Novo plano" pra começar.</div>';
    return;
  }
  const ordenados = [...STATE.planos].sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));
  grid.innerHTML = ordenados.map((p) => {
    const info = calcularPlanoInfo(p);
    return (
      `<div class="plano-card">` +
      `<div class="plano-header">` +
      `<div class="plano-icone">${esc(p.icone || "🎯")}</div>` +
      `<div class="plano-titulo"><h3>${esc(p.nome)}</h3>` +
      `<span class="stamp ${info.concluido ? "pago" : "andamento"}">${info.concluido ? "CONCLUÍDO" : "EM ANDAMENTO"}</span></div>` +
      `<button class="btn-small" data-editar-plano="${p.id}">Editar</button>` +
      `</div>` +
      (p.descricao ? `<p class="plano-descricao">${esc(p.descricao)}</p>` : "") +
      `<div class="plano-progresso">` +
      `<div class="plano-progresso-barra"><div class="plano-progresso-fill" style="width:${info.pct}%"></div></div>` +
      `<div class="plano-progresso-legenda"><span class="pct">${info.pct.toFixed(0)}%</span><span>${moeda(info.valorAcumulado)} de ${moeda(info.valorAlvo)}</span></div>` +
      `</div>` +
      `<div class="plano-stats">` +
      `<div><span class="label">Falta</span><span class="valor">${moeda(info.falta)}</span></div>` +
      `<div><span class="label">Meta/mês</span><span class="valor">${info.aporteMensal > 0 ? moeda(info.aporteMensal) : "—"}</span></div>` +
      `<div><span class="label">Previsão</span><span class="valor" style="font-size:11px;">${info.previsaoTexto}</span></div>` +
      `</div>` +
      `<div class="plano-simulador">` +
      `<div class="sim-titulo">Simulador — quero investir mais</div>` +
      `<div class="field"><label>Guardando por mês (R$)</label>` +
      `<input type="number" step="0.01" class="sim-mensal" data-plano="${p.id}" data-falta="${info.falta}" value="${info.aporteMensal || ""}" placeholder="Ex: 200"></div>` +
      `<div class="sim-resultado" data-sim-tempo="${p.id}"></div>` +
      `<div class="field"><label>Quero conseguir em quantos meses</label>` +
      `<input type="number" step="1" min="1" class="sim-meses" data-plano="${p.id}" data-falta="${info.falta}" placeholder="Ex: 6"></div>` +
      `<div class="sim-resultado" data-sim-valor="${p.id}"></div>` +
      `</div>` +
      `<div class="plano-footer"><button class="btn btn-primary" data-abrir-aporte="${p.id}">Registrar aporte / retirada</button></div>` +
      `</div>`
    );
  }).join("");

  grid.querySelectorAll("[data-editar-plano]").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalPlano(btn.dataset.editarPlano));
  });
  grid.querySelectorAll("[data-abrir-aporte]").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalAporte(btn.dataset.abrirAporte));
  });
  grid.querySelectorAll(".sim-mensal").forEach((input) => {
    input.addEventListener("input", () => atualizarSimuladorTempo(input));
    atualizarSimuladorTempo(input);
  });
  grid.querySelectorAll(".sim-meses").forEach((input) => {
    input.addEventListener("input", () => atualizarSimuladorValor(input));
  });
}

function atualizarSimuladorTempo(input) {
  const falta = Number(input.dataset.falta) || 0;
  const valorMensal = Number(input.value);
  const out = document.querySelector(`[data-sim-tempo="${input.dataset.plano}"]`);
  if (!out) return;
  if (falta <= 0) { out.innerHTML = "Meta já alcançada."; return; }
  if (!valorMensal || valorMensal <= 0) { out.innerHTML = ""; return; }
  const meses = Math.ceil(falta / valorMensal);
  const dataPrevista = new Date();
  dataPrevista.setMonth(dataPrevista.getMonth() + meses);
  out.innerHTML =
    `Nesse ritmo: <strong>≈ ${meses} ${meses === 1 ? "mês" : "meses"}</strong> ` +
    `(previsão: ${dataPrevista.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}) — ` +
    `<button type="button" class="sim-usar" data-usar-mensal="${input.dataset.plano}" data-valor="${valorMensal}">usar como minha meta mensal</button>`;
  const btn = out.querySelector("[data-usar-mensal]");
  if (btn) btn.addEventListener("click", () => salvarMetaMensalPlano(btn.dataset.usarMensal, Number(btn.dataset.valor)));
}

function atualizarSimuladorValor(input) {
  const falta = Number(input.dataset.falta) || 0;
  const meses = Number(input.value);
  const out = document.querySelector(`[data-sim-valor="${input.dataset.plano}"]`);
  if (!out) return;
  if (falta <= 0) { out.innerHTML = "Meta já alcançada."; return; }
  if (!meses || meses <= 0) { out.innerHTML = ""; return; }
  const valorNecessario = arredondar2(falta / meses);
  out.innerHTML =
    `Você precisa guardar <strong>${moeda(valorNecessario)}/mês</strong> — ` +
    `<button type="button" class="sim-usar" data-usar-mensal="${input.dataset.plano}" data-valor="${valorNecessario}">usar como minha meta mensal</button>`;
  const btn = out.querySelector("[data-usar-mensal]");
  if (btn) btn.addEventListener("click", () => salvarMetaMensalPlano(btn.dataset.usarMensal, Number(btn.dataset.valor)));
}

async function salvarMetaMensalPlano(planoId, valor) {
  try {
    await updateDoc(doc(db, "planos", planoId), { aportePlanejadoMensal: valor });
    mostrarToast("Meta mensal atualizada!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
}

function abrirModalPlano(id) {
  const editando = !!id;
  document.getElementById("modal-plano-titulo").textContent = editando ? "Editar plano" : "Novo plano";
  document.getElementById("btn-excluir-plano").classList.toggle("hidden", !editando);
  if (editando) {
    const p = STATE.planos.find((x) => x.id === id);
    if (!p) return mostrarToast("Plano não encontrado.", true);
    document.getElementById("plano-id").value = p.id;
    document.getElementById("plano-icone").value = p.icone || "🎯";
    document.getElementById("plano-nome").value = p.nome;
    document.getElementById("plano-descricao").value = p.descricao || "";
    document.getElementById("plano-valor-alvo").value = p.valorAlvo;
    document.getElementById("plano-aporte-mensal").value = p.aportePlanejadoMensal || "";
  } else {
    document.getElementById("plano-id").value = "";
    document.getElementById("plano-icone").value = "🎯";
    document.getElementById("plano-nome").value = "";
    document.getElementById("plano-descricao").value = "";
    document.getElementById("plano-valor-alvo").value = "";
    document.getElementById("plano-aporte-mensal").value = "";
  }
  document.getElementById("modal-plano").classList.add("active");
}
function fecharModalPlano() {
  document.getElementById("modal-plano").classList.remove("active");
}
document.getElementById("btn-novo-plano").addEventListener("click", () => abrirModalPlano(null));
document.getElementById("btn-cancelar-plano").addEventListener("click", fecharModalPlano);
document.getElementById("modal-plano").addEventListener("click", (e) => {
  if (e.target.id === "modal-plano") fecharModalPlano();
});

document.getElementById("btn-salvar-plano").addEventListener("click", async () => {
  const id = document.getElementById("plano-id").value;
  const icone = document.getElementById("plano-icone").value;
  const nome = document.getElementById("plano-nome").value.trim();
  const descricao = document.getElementById("plano-descricao").value.trim();
  const valorAlvo = Number(document.getElementById("plano-valor-alvo").value);
  const aportePlanejadoMensal = Number(document.getElementById("plano-aporte-mensal").value) || 0;
  if (!nome) return mostrarToast("Dê um nome pro plano.", true);
  if (!valorAlvo || valorAlvo <= 0) return mostrarToast("Informe quanto o plano vai custar.", true);
  try {
    if (id) {
      await updateDoc(doc(db, "planos", id), { icone, nome, descricao, valorAlvo, aportePlanejadoMensal });
      mostrarToast("Plano atualizado!");
    } else {
      await addDoc(collection(db, "planos"), {
        icone, nome, descricao, valorAlvo, aportePlanejadoMensal, valorAcumulado: 0, createdAt: serverTimestamp()
      });
      mostrarToast("Plano criado!");
    }
    fecharModalPlano();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-plano").addEventListener("click", async () => {
  const id = document.getElementById("plano-id").value;
  if (!id) return;
  if (!confirm("Excluir este plano? O histórico de aportes dele também será perdido.")) return;
  try {
    await deleteDoc(doc(db, "planos", id));
    mostrarToast("Plano excluído.");
    fecharModalPlano();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function abrirModalAporte(planoId) {
  const p = STATE.planos.find((x) => x.id === planoId);
  if (!p) return mostrarToast("Plano não encontrado.", true);
  document.getElementById("aporte-plano-id").value = planoId;
  document.getElementById("aporte-plano-nome").textContent = `${p.icone || "🎯"} ${p.nome}`;
  document.getElementById("aporte-tipo").value = "Aporte";
  document.getElementById("aporte-valor").value = "";
  document.getElementById("aporte-data").valueAsDate = new Date();
  document.getElementById("modal-aporte-plano").classList.add("active");
}
function fecharModalAporte() {
  document.getElementById("modal-aporte-plano").classList.remove("active");
}
document.getElementById("btn-cancelar-aporte").addEventListener("click", fecharModalAporte);
document.getElementById("modal-aporte-plano").addEventListener("click", (e) => {
  if (e.target.id === "modal-aporte-plano") fecharModalAporte();
});

document.getElementById("btn-salvar-aporte").addEventListener("click", async () => {
  const planoId = document.getElementById("aporte-plano-id").value;
  const tipo = document.getElementById("aporte-tipo").value;
  const valor = Number(document.getElementById("aporte-valor").value);
  const data = document.getElementById("aporte-data").value;
  if (!valor || valor <= 0) return mostrarToast("Informe um valor válido.", true);
  if (!data) return mostrarToast("Informe a data.", true);

  const p = STATE.planos.find((x) => x.id === planoId);
  if (!p) return mostrarToast("Plano não encontrado.", true);
  if (tipo === "Retirada" && valor > (Number(p.valorAcumulado) || 0)) {
    return mostrarToast(`Não dá pra retirar mais do que já foi guardado (${moeda(p.valorAcumulado)}).`, true);
  }

  try {
    const batch = writeBatch(db);
    const delta = tipo === "Aporte" ? valor : -valor;
    batch.update(doc(db, "planos", planoId), { valorAcumulado: increment(delta) });
    const aporteRef = doc(collection(db, "planos", planoId, "aportes"));
    batch.set(aporteRef, { tipo, valor, data, timestamp: serverTimestamp() });
    await batch.commit();
    mostrarToast(tipo === "Aporte" ? "Aporte registrado!" : "Retirada registrada!");
    fecharModalAporte();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ CONFIGURAÇÕES ══════════════ */

document.getElementById("btn-salvar-config").addEventListener("click", async () => {
  const rendaMensal = Number(document.getElementById("cfg-renda").value) || 0;
  const saldoInicial = Number(document.getElementById("cfg-saldo").value) || 0;
  try {
    await setDoc(doc(db, "config", "geral"), { rendaMensal, saldoInicial }, { merge: true });
    mostrarToast("Configurações salvas!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ LISTENERS EM TEMPO REAL ══════════════ */

function iniciarListeners() {
  onSnapshot(query(collection(db, "lancamentos"), orderBy("nome")), (snap) => {
    STATE.lancamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
    lancamentosCarregados = true;
    tentarAbrirAcaoRapidaAutomatica();
  }, (err) => mostrarToast("Erro ao carregar lançamentos: " + err.message, true));

  onSnapshot(query(collection(db, "movimentacoes"), orderBy("data", "desc")), (snap) => {
    STATE.movimentacoes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => mostrarToast("Erro ao carregar movimentações: " + err.message, true));

  onSnapshot(collection(db, "cartoes"), (snap) => {
    STATE.cartoes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCartoes();
    renderComprasParceladas();
    renderParcelasCartao();
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar cartões: " + err.message, true));

  onSnapshot(collection(db, "comprasParceladas"), (snap) => {
    STATE.comprasParceladas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderComprasParceladas();
    renderParcelasCartao();
    renderMovimentacoes();
  }, (err) => mostrarToast("Erro ao carregar compras parceladas: " + err.message, true));

  onSnapshot(collection(db, "recorrentes"), (snap) => {
    STATE.recorrentes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    recorrentesCarregados = true;
    renderRecorrentes();
    tentarAutoLancarRecorrentes();
  }, (err) => mostrarToast("Erro ao carregar recorrentes: " + err.message, true));

  onSnapshot(collection(db, "historico"), (snap) => {
    STATE.historico = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHistorico();
  }, (err) => mostrarToast("Erro ao carregar histórico: " + err.message, true));

  onSnapshot(query(collection(db, "pessoas"), orderBy("nome")), (snap) => {
    STATE.pessoas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    preencherSelectsPessoa();
  }, (err) => mostrarToast("Erro ao carregar pessoas: " + err.message, true));

  onSnapshot(collection(db, "planos"), (snap) => {
    STATE.planos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlanos();
  }, (err) => mostrarToast("Erro ao carregar planos: " + err.message, true));

  onSnapshot(collection(db, "conexoesBancarias"), (snap) => {
    STATE.conexoesBancarias = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderConexoes();
    renderMovimentacoes();
    renderDashboard();
    // Sincroniza cada conexão automaticamente uma vez por sessão (assim que
    // o app abre), sem precisar clicar em "Sincronizar agora" — a guarda
    // por Set evita loop, já que a própria sincronização reescreve o
    // documento e dispara este listener de novo.
    STATE.conexoesBancarias.forEach((c) => {
      if (!conexoesAutoSincronizadasNestaSessao.has(c.id)) {
        conexoesAutoSincronizadasNestaSessao.add(c.id);
        sincronizarConexao(c.id);
      }
    });
  }, (err) => mostrarToast("Erro ao carregar conexões bancárias: " + err.message, true));

  onSnapshot(collection(db, "feriados"), (snap) => {
    STATE.feriados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRecorrentes();
  }, (err) => mostrarToast("Erro ao carregar feriados: " + err.message, true));

  onSnapshot(doc(db, "config", "geral"), (snap) => {
    STATE.config = snap.exists() ? snap.data() : { rendaMensal: 0, saldoInicial: 0 };
    document.getElementById("cfg-renda").value = STATE.config.rendaMensal || 0;
    document.getElementById("cfg-saldo").value = STATE.config.saldoInicial || 0;
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar configurações: " + err.message, true));
}

/* ══════════════ INÍCIO ══════════════ */

document.getElementById("mov-data").valueAsDate = new Date();
document.getElementById("rec-inicio").valueAsDate = new Date();
document.getElementById("compra-data").valueAsDate = new Date();

// "De"/"Até" começam vazios de propósito (mostra tudo por padrão) — se um
// deles viesse pré-preenchido com o mês atual, usar só o outro campo
// filtraria sem querer num intervalo de dois lados em vez de um só.

iniciarBuscaLancamento();
iniciarListeners();
