import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
export interface ApnsResult { ok: boolean; permanent: boolean; reason: string }
export interface LiveApnsClient { send(token: string, payload: unknown, expiresAt: number): Promise<ApnsResult>; close(): void }
export function createLiveApnsClient(env: NodeJS.ProcessEnv = process.env): LiveApnsClient {
  const team = env.APPLE_TEAM_ID ?? "", keyId = env.LIVE_ACTIVITY_APNS_KEY_ID ?? "", bundle = env.IOS_BUNDLE_ID || "com.tugyn.tugynfut";
  const environment = env.LIVE_ACTIVITY_APNS_ENV || "production";
  if (!/^[A-Z0-9]{10}$/.test(team) || !/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Za-z0-9_.]+$/.test(bundle) || !["production","development"].includes(environment)) throw new Error("live_activity_apns_config");
  const key = createPrivateKey((env.LIVE_ACTIVITY_APNS_KEY ?? "").replace(/\\n/g,"\n"));
  const now = Math.floor(Date.now()/1000);
  const body = `${Buffer.from(JSON.stringify({ alg:"ES256",kid:keyId })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss:team,iat:now })).toString("base64url")}`;
  const jwt = `${body}.${sign("sha256",new Uint8Array(Buffer.from(body)),{ key,dsaEncoding:"ieee-p1363" }).toString("base64url")}`;
  let connection: ClientHttp2Session | null = null;
  const session = () => {
    if (!connection || connection.destroyed || connection.closed) {
      connection = connect(environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
      connection.on("error",()=>undefined); // cada stream resolve sua falha sem registrar credenciais ou tokens
      connection.setTimeout(10_000,()=>connection?.destroy());
    }
    return connection;
  };
  return {
    send: (token,payload,expiresAt) => new Promise(resolve => {
      let settled=false;
      const finish=(result:ApnsResult)=>{if(!settled){settled=true;clearTimeout(timer);resolve(result);}};
      const timer=setTimeout(()=>{stream?.close();finish({ok:false,permanent:false,reason:"timeout"});},7_000);
      let stream: ReturnType<ClientHttp2Session["request"]> | null = null;
      try {
        const end=(payload as {aps?:{event?:string}})?.aps?.event==="end";
        stream=session().request({ ":method":"POST",":path":`/3/device/${token}`,authorization:`bearer ${jwt}`,"apns-topic":`${bundle}.push-type.liveactivity`,"apns-push-type":"liveactivity","apns-priority":end?"10":"5","apns-expiration":String(Math.floor(expiresAt/1000)),"content-type":"application/json" });
        let status=0, response="";
        stream.on("response",headers=>{status=Number(headers[":status"] ?? 0);});
        stream.on("data",chunk=>{if(response.length<2048)response+=String(chunk);});
        stream.on("end",()=>{
          let reason="";try{reason=String(JSON.parse(response).reason ?? "");}catch{}
          // Falhas de credencial/tópico/configuração nunca apagam todos os tokens.
          finish({ok:status===200,permanent:status===410 || ["Unregistered","BadDeviceToken"].includes(reason),reason:reason || String(status)});
        });
        stream.on("error",()=>finish({ok:false,permanent:false,reason:"network"}));
        stream.end(JSON.stringify(payload));
      } catch { finish({ok:false,permanent:false,reason:"connection"}); }
    }),
    close:()=>{connection?.destroy();connection=null;},
  };
}
