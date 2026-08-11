const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "lembrete_mensalidade";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "pt_BR";

function todayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(new Date());
  const get = (type) => parts.find(p=>p.type===type).value;
  return {year:Number(get("year")), month:Number(get("month")), day:Number(get("day"))};
}

function dateKey(y,m,d) {
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}

function nextDue(day) {
  const t = todayParts();
  const safeDay = Math.min(Math.max(Number(day)||1,1),28);
  const current = new Date(Date.UTC(t.year,t.month-1,safeDay));
  const today = new Date(Date.UTC(t.year,t.month-1,t.day));
  if (current < today) current.setUTCMonth(current.getUTCMonth()+1);
  return {
    key: dateKey(current.getUTCFullYear(),current.getUTCMonth()+1,current.getUTCDate()),
    date: current
  };
}

function daysBetween(a,b) {
  return Math.round((a-b)/86400000);
}

async function sendWhatsAppTemplate({to,nome,valor,vencimento,dias}) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error("WhatsApp Cloud API não configurada.");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${ACCESS_TOKEN}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      messaging_product:"whatsapp",
      to,
      type:"template",
      template:{
        name:TEMPLATE_NAME,
        language:{code:TEMPLATE_LANG},
        components:[{
          type:"body",
          parameters:[
            {type:"text",text:String(nome)},
            {type:"text",text:String(valor)},
            {type:"text",text:String(vencimento)},
            {type:"text",text:String(dias)}
          ]
        }]
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

exports.enviarLembretes = onSchedule(
  {schedule:"0 9 * * *", timeZone:"America/Sao_Paulo", region:"southamerica-east1"},
  async () => {
    const users = await db.collection("users").get();
    const today = todayParts();
    const todayDate = new Date(Date.UTC(today.year,today.month-1,today.day));

    for (const userDoc of users.docs) {
      const clients = await userDoc.ref.collection("clientes").where("ativo","==",true).get();

      for (const clientDoc of clients.docs) {
        const c = clientDoc.data();
        if (!c.telefone || !c.nome || !c.vencimento) continue;

        const due = nextDue(c.vencimento);
        const dueDate = due.date;
        const days = daysBetween(dueDate,todayDate);
        const advance = Number(c.aviso || 3);

        if (days < 0 || days > advance) continue;

        // Uma notificação por ciclo de vencimento.
        if (c.ultimoLembreteVencimento === due.key) continue;

        try {
          await sendWhatsAppTemplate({
            to:String(c.telefone).replace(/\D/g,""),
            nome:c.nome,
            valor:Number(c.valor||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}),
            vencimento:c.vencimento,
            dias:days === 0 ? "hoje" : String(days)
          });

          await clientDoc.ref.update({
            ultimoLembreteVencimento:due.key,
            ultimoLembreteEm:FieldValue.serverTimestamp()
          });

          console.log(`Lembrete enviado para ${c.nome} - vencimento ${due.key}`);
        } catch (error) {
          console.error(`Falha ao enviar para ${c.nome}:`, error.message);
        }
      }
    }
  }
);
