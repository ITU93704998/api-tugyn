import { listarSaidasRegionaisCT } from "./saidasRegionaisCT";
import { exigirRegiaoTimes, ErroRegioesTimes } from "./regioesTimes";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { requireUser, getFirebaseApp } from "./auth";
import { verificarAppCheck } from "./appCheck";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { RecusaCT, exigirCT, objetoCT } from "./campeonatosTimesDominio";
import { patrocinadorCT, patrocinadoresPublicosCT } from "./campeonatosTimesMidia";
import { criarCT, listarCT, lerDetalheCT, gruposLiberadosCT, inscreverCT, responderCT, cancelarInscricaoCT, iniciarCT, resultadoCT, finalizarCT, administrarCT } from "./campeonatosTimesServico";

const ACOES = new Set(["saidasRegionais", "recursos", "listar", "detalhe", "criar", "inscrever", "responderInscricao", "cancelarInscricao", "iniciar", "finalizar", "resultado", "patrocinador", "removerPatrocinador", "marcarPagamento", "agendarJogo", "cancelar"]);
export async function handleCampeonatosTimes(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método não permitido." }); }
  const usuario = await requireUser(req, res, "campeonatos-times"); if (!usuario) return;
  if (!await verificarAppCheck(req, res, "campeonatos-times")) return;
  const b = objetoCT(req.body), acao = typeof b.acao === "string" ? b.acao : "";
  try {
    exigirCT(ACOES.has(acao), "Ação inválida.");
    exigirCT(Buffer.byteLength(JSON.stringify(b), "utf8") <= (acao === "patrocinador" ? 2_850_000 : 24_000), "Pedido muito grande.", 413);
    const leitura = acao === "saidasRegionais" || acao === "listar" || acao === "detalhe" || acao === "recursos";
    exigirCT(await dentroDoLimite(usuario.uid, `ct_${leitura ? "ler" : acao === "patrocinador" ? "midia" : "gravar"}`, leitura ? 300 : acao === "patrocinador" ? 15 : 120, 3600), "Muitas tentativas. Aguarde um pouco.", 429);
    const db = getFirestore(getFirebaseApp()), uid = usuario.uid;
    if (acao !== "saidasRegionais" && acao !== "cancelar" && acao !== "cancelarInscricao") await exigirRegiaoTimes(db, uid, "campeonatosTimes");
    if (acao === "saidasRegionais") return res.status(200).json({ ok: true, ...await listarSaidasRegionaisCT(db, uid, b) });
    // Liberações da conta: só o formulário de criação precisa; listar e detalhe não pagam essa leitura a cada abertura.
    if (acao === "recursos") return res.status(200).json({ ok: true, recursos: { gruposMataLiberado: await gruposLiberadosCT(db, uid) } });
    if (leitura || acao === "criar") {
      const dados = acao === "listar" ? await listarCT(db, uid, b) : acao === "detalhe" ? await lerDetalheCT(db, uid, b) : await criarCT(db, uid, b, await gruposLiberadosCT(db, uid));
      // Os public_ids são internos; a tela só recebe URLs públicas dos patrocinadores.
      if (dados.campeonato) { const c = dados.campeonato as Record<string, unknown>; c.patrocinadores = patrocinadoresPublicosCT(c); }
      return res.status(200).json({ ok: true, ...dados });
    }
    switch (acao) {
      case "inscrever": await inscreverCT(db, uid, b); break;
      case "responderInscricao": await responderCT(db, uid, b); break;
      case "cancelarInscricao": await cancelarInscricaoCT(db, uid, b); break;
      case "iniciar": await iniciarCT(db, uid, b); break;
      case "resultado": await resultadoCT(db, uid, b); break;
      case "finalizar": await finalizarCT(db, uid, b); break;
      case "patrocinador": case "removerPatrocinador": await patrocinadorCT(db, uid, b); break;
      default: await administrarCT(db, uid, b);
    }
    return res.status(200).json({ ok: true });
  } catch (erro) {
    if (erro instanceof ErroRegioesTimes) return res.status(erro.status).json({ error: erro.message, code: erro.code });
    if (erro instanceof RecusaCT) return res.status(erro.status).json({ error: erro.message, code: erro.code });
    console.error(JSON.stringify({ evt: "campeonatos_times_falhou", acao, code: typeof (erro as { code?: unknown })?.code === "string" ? (erro as { code: string }).code.slice(0, 60) : "interno" }));
    return res.status(503).json({ error: "Não foi possível concluir agora. Tente novamente.", code: "campeonato_indisponivel", retryable: true });
  }
}
