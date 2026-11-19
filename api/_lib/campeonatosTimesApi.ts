import { listarTitulosTime } from "./galeriaTimes";
import { listarSaidasRegionaisCT } from "./saidasRegionaisCT";
import { exigirRegiaoTimes, ErroRegioesTimes } from "./regioesTimes";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { requireUser, getFirebaseApp } from "./auth";
import { verificarAppCheck } from "./appCheck";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { RecusaCT, exigirCT, objetoCT } from "./campeonatosTimesDominio";
import { excluirCT, patrocinadorCT, patrocinadoresPublicosCT } from "./campeonatosTimesMidia";
import { linkRegulamentoPdfCT, MAX_CORPO_REGULAMENTO, regulamentoPdfCT, regulamentoPublicoCT } from "./campeonatosTimesRegulamento";
import { alterarModelosTrofeuCT, lerModelosTrofeuCT } from "./campeonatosTimesServico";
import { contatoCT } from "./campeonatosTimesServico";
import { creditosDisponiveisCT, sincronizarCreditosCT } from "./campeonatosTimesPremium";
import { criarCT, listarCT, lerDetalheCT, gruposLiberadosCT, inscreverCT, responderCT, cancelarInscricaoCT, iniciarCT, resultadoCT, finalizarCT, administrarCT, transferirAtletaCT, mesarioCT, proximosJogosCT, estatisticasAtletaCT, timeDoCardEscolherCT } from "./campeonatosTimesServico";
import { dispararAvisosCT } from "./campeonatosTimesAvisos";
import type { Aviso } from "./pushEnvio";

const ACOES = new Set(["titulosTime", "saidasRegionais", "recursos", "listar", "detalhe", "criar", "inscrever", "responderInscricao", "cancelarInscricao", "iniciar", "finalizar", "resultado", "patrocinador", "removerPatrocinador", "marcarPagamento", "agendarJogo", "cancelar", "excluir", "transferirAtleta", "mesario", "proximosJogos", "estatisticasAtleta", "modelosTrofeu", "alterarModelosTrofeu", "alterarDatas", "editarInfo", "pagamentoContato", "contatoDono", "avisarPagamento", "pedirContato", "sincronizarCreditos", "regulamentoPdf", "linkRegulamentoPdf", "timeDoCard"]);
export async function handleCampeonatosTimes(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método não permitido." }); }
  const usuario = await requireUser(req, res, "campeonatos-times"); if (!usuario) return;
  if (!await verificarAppCheck(req, res, "campeonatos-times")) return;
  const b = objetoCT(req.body), acao = typeof b.acao === "string" ? b.acao : "";
  try {
    exigirCT(ACOES.has(acao), "Ação inválida.");
    exigirCT(Buffer.byteLength(JSON.stringify(b), "utf8") <= (acao === "patrocinador" ? 2_850_000 : acao === "regulamentoPdf" ? MAX_CORPO_REGULAMENTO : 24_000), "Pedido muito grande.", 413);
    const midia = acao === "patrocinador" || acao === "regulamentoPdf";
    const leitura = acao === "linkRegulamentoPdf" || acao === "titulosTime" || acao === "saidasRegionais" || acao === "listar" || acao === "detalhe" || acao === "recursos" || acao === "proximosJogos" || acao === "estatisticasAtleta" || acao === "modelosTrofeu";
    exigirCT(await dentroDoLimite(usuario.uid, `ct_${leitura ? "ler" : midia ? "midia" : "gravar"}`, leitura ? 300 : midia ? 15 : 120, 3600), "Muitas tentativas. Aguarde um pouco.", 429);
    const db = getFirestore(getFirebaseApp()), uid = usuario.uid;
    if (acao === "titulosTime") {
      await exigirRegiaoTimes(db, uid, "times");
      return res.status(200).json({ ok: true, ...await listarTitulosTime(db, uid, b) });
    }
    // Campeonato premium: depois da compra na loja, confere no RevenueCat e credita (vale em qualquer região).
    if (acao === "sincronizarCreditos") return res.status(200).json({ ok: true, ...await sincronizarCreditosCT(db, uid) });
    if (acao !== "saidasRegionais" && acao !== "estatisticasAtleta" && acao !== "timeDoCard" && acao !== "proximosJogos" && acao !== "cancelar" && acao !== "excluir" && acao !== "cancelarInscricao") await exigirRegiaoTimes(db, uid, "campeonatosTimes");
    // Perfil e hub: leituras próprias, sem a liberação regional (estatística antiga continua visível).
    if (acao === "estatisticasAtleta") return res.status(200).json({ ok: true, ...await estatisticasAtletaCT(db, uid, b) });
    // Perfil: escolha do time do card Times (vale em qualquer região, como as estatísticas).
    if (acao === "timeDoCard") return res.status(200).json({ ok: true, ...await timeDoCardEscolherCT(db, uid, b) });
    if (acao === "proximosJogos") return res.status(200).json({ ok: true, ...await proximosJogosCT(db, uid) });
    // Editor de troféu: modelos salvos da conta.
    if (acao === "modelosTrofeu") return res.status(200).json({ ok: true, ...await lerModelosTrofeuCT(db, uid) });
    if (acao === "alterarModelosTrofeu") return res.status(200).json({ ok: true, ...await alterarModelosTrofeuCT(db, uid, b) });
    if (acao === "saidasRegionais") return res.status(200).json({ ok: true, ...await listarSaidasRegionaisCT(db, uid, b) });
    // Liberações da conta: só o formulário de criação precisa; listar e detalhe não pagam essa leitura a cada abertura.
    if (acao === "recursos") {
      const [gruposMataLiberado, creditosPremium] = await Promise.all([gruposLiberadosCT(db, uid), creditosDisponiveisCT(db, uid)]);
      return res.status(200).json({ ok: true, recursos: { gruposMataLiberado, creditosPremium } });
    }
    // Regulamento em PDF: link assinado só para organizador, mesários e donos de time.
    if (acao === "linkRegulamentoPdf") return res.status(200).json({ ok: true, ...await linkRegulamentoPdfCT(db, uid, b) });
    if (leitura || acao === "criar") {
      const dados = acao === "listar" ? await listarCT(db, uid, b) : acao === "detalhe" ? await lerDetalheCT(db, uid, b) : await criarCT(db, uid, b, await gruposLiberadosCT(db, uid));
      // Os public_ids são internos; a tela só recebe URLs públicas dos patrocinadores.
      if (dados.campeonato) { const c = dados.campeonato as Record<string, unknown>; c.patrocinadores = patrocinadoresPublicosCT(c); c.regulamentoPdf = regulamentoPublicoCT(c); }
      return res.status(200).json({ ok: true, ...dados });
    }
    let avisos: Aviso[] = [];
    switch (acao) {
      case "inscrever": avisos = await inscreverCT(db, uid, b); break;
      case "responderInscricao": avisos = await responderCT(db, uid, b); break;
      case "cancelarInscricao": avisos = await cancelarInscricaoCT(db, uid, b); break;
      case "iniciar": avisos = await iniciarCT(db, uid, b); break;
      case "resultado": avisos = await resultadoCT(db, uid, b); break;
      case "finalizar": avisos = await finalizarCT(db, uid, b); break;
      case "patrocinador": case "removerPatrocinador": await patrocinadorCT(db, uid, b); break;
      case "excluir": await excluirCT(db, uid, b); break;
      case "regulamentoPdf": avisos = await regulamentoPdfCT(db, uid, b); break;
      case "transferirAtleta": avisos = await transferirAtletaCT(db, uid, b); break;
      case "mesario": avisos = await mesarioCT(db, uid, b); break;
      case "pagamentoContato": case "contatoDono": case "avisarPagamento": case "pedirContato": avisos = await contatoCT(db, uid, b); break;
      default: avisos = await administrarCT(db, uid, b);
    }
    // Ação salva: os avisos saem agora (melhor esforço); o que falhar a fila recupera.
    await dispararAvisosCT(db, avisos);
    return res.status(200).json({ ok: true });
  } catch (erro) {
    if (erro instanceof ErroRegioesTimes) return res.status(erro.status).json({ error: erro.message, code: erro.code });
    if (erro instanceof RecusaCT) return res.status(erro.status).json({ error: erro.message, code: erro.code, ...(erro.detalhes ? { detalhes: erro.detalhes } : {}) });
    console.error(JSON.stringify({ evt: "campeonatos_times_falhou", acao, code: typeof (erro as { code?: unknown })?.code === "string" ? (erro as { code: string }).code.slice(0, 60) : "interno" }));
    return res.status(503).json({ error: "Não foi possível concluir agora. Tente novamente.", code: "campeonato_indisponivel", retryable: true });
  }
}
