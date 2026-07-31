// Inicialização do Firebase — via CDN (ESM), sem bundler, sem etapa de build.
//
// Firestore é o banco de dados deste sistema. Além disso, este projeto usa
// um Apps Script mínimo (Code.gs) como proxy de segredos para a integração
// de Open Finance (Pluggy) — não como banco de dados, só pra nunca expor
// clientId/clientSecret no frontend público. Veja "Conexões Bancárias" no
// app.js e o README para o passo a passo de implantação do Code.gs.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// TROQUE pela config do SEU projeto (Firebase Console > Configurações do
// projeto > seus apps > app Web > "Config"). Essas chaves são públicas por
// design no Firebase Web — a segurança vem das regras (firestore.rules),
// não de esconder essa config.
const firebaseConfig = {
  apiKey: "AIzaSyDxeuN_pThgWj0NQHvWU21sPW9tI5DL-4o",
  authDomain: "financeiro-e88ac.firebaseapp.com",
  projectId: "financeiro-e88ac",
  storageBucket: "financeiro-e88ac.firebasestorage.app",
  messagingSenderId: "917932433349",
  appId: "1:917932433349:web:c5198138b96bc486e5f5ac"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);

// Por padrão, sempre conecta no projeto Firestore REAL (mesmo testando
// local ou pela hospedagem) — assim dá pra testar sem precisar rodar
// nenhum emulador. Só usa o emulador local se a página abrir com
// "?emulator=1" na URL (ex: http://localhost:8000/?emulator=1).
if (new URLSearchParams(location.search).has("emulator")) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.log("[firebase] usando emulador local do Firestore (:8080)");
}

// ══════════════ CONEXÕES BANCÁRIAS (Open Finance via Pluggy) ══════════════
// URL da implantação do Code.gs (Apps Script Web App) que atua como proxy
// de segredos entre o frontend e a API da Pluggy — nunca coloque
// clientId/clientSecret aqui, isso fica só nas Script Properties do Apps
// Script. TROQUE pela URL "/exec" que você copiar ao implantar o Code.gs
// (veja o README, seção "Conexões Bancárias").
export const PLUGGY_PROXY_URL = "https://script.google.com/macros/s/AKfycbxOeP_FQ_b7Gydus2vPiSNQd1IESXY4Kr66Csqu1SjE6LRa71DUNTQdCh8hR7btBWU/exec";
