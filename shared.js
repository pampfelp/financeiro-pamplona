// Funções pequenas usadas tanto pelo app.js quanto pelo planilha.html — só o
// que realmente se repete igual nos dois lugares vai pra cá (padrão do
// segundo cérebro: código compartilhado é módulo importado, não copiado).
// Não é o lugar pra colocar tudo que é "helper" — só duplicação de verdade.

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
