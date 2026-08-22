/** Incrementar sempre que um perfil de compactação mudar: anexos gravados com
 * versão menor voltam a ser elegíveis para reotimização retroativa.
 * Fica isolado para não arrastar jspdf/pdfjs para quem só precisa do número. */
export const ATTACHMENT_OPTIMIZATION_VERSION = 2;
