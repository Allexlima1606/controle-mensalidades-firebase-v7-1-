import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, serverTimestamp, enableMultiTabIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

/* =========================================================
   1. COLE A CONFIGURAÇÃO DO SEU PROJETO FIREBASE AQUI
   Firebase Console > Configurações do projeto > Seus apps > Web
========================================================= */
const firebaseConfig = {
  // Cole aqui exatamente o objeto firebaseConfig do Firebase Console.
  // Firebase Console > Configurações do projeto > Seus apps > Web
  apiKey: "AIzaSyDrTeLwJEUl0nz8s2yF9MQ_K-twVcVf3Mk",
  authDomain: "controledemensalidades-446a0.firebaseapp.com",
  projectId: "controledemensalidades-446a0",
  storageBucket: "controledemensalidades-446a0.firebasestorage.app",
  messagingSenderId: "421002054943",
  appId: "1:421002054943:web:67680fe07db9d897a4742a"
};

const configIncompleta = Object.values(firebaseConfig).some(v =>
  !v || String(v).includes("COLE_") || String(v).includes("SEU-PROJETO") || String(v).includes("SEU_SENDER_ID") || String(v).includes("SEU_APP_ID")
);

const app = configIncompleta ? null : initializeApp(firebaseConfig);
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
let persistenceReady = false;
if (db) {
  enableMultiTabIndexedDbPersistence(db).then(() => {
    persistenceReady = true;
  }).catch(err => {
    console.warn("Persistência offline do Firestore não habilitada:", err.code || err);
  });
}

let clientes = [];
let unsubscribeClientes = null;
let editingId = null;
let autosaveTimer = null;
let autosaveBusy = false;
let autosaveCreating = false;
const LOCAL_KEY = "controle_mensalidades_clientes_localstorage_v6";
const PENDING_KEY = "controle_mensalidades_sync_queue_v6";
const DELETE_KEY = "controle_mensalidades_delete_queue_v6";
let localMode = false;

const $ = (id) => document.getElementById(id);
if (configIncompleta) {
  $("configWarning")?.classList.remove("hidden");
  $("firebaseStatus").textContent = "Firebase ainda não configurado.";
}

function authErrorMessage(err) {
  const code = err?.code || "";
  const messages = {
    "auth/email-already-in-use": "Este e-mail já possui uma conta. Tente entrar.",
    "auth/invalid-email": "Digite um e-mail válido.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/operation-not-allowed": "Ative E-mail/Senha em Firebase > Authentication > Sign-in method.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/network-request-failed": "Falha de conexão. Verifique a internet.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "A API Key do Firebase está incorreta.",
    "auth/configuration-not-found": "A configuração do Firebase Authentication não foi encontrada."
  };
  return messages[code] || `Não foi possível concluir. Código: ${code || "desconhecido"}`;
}

const money = (value) => Number(value || 0).toLocaleString("pt-BR", {
  style: "currency", currency: "BRL"
});

const normalizePhone = (phone) => String(phone || "").replace(/\D/g, "");

function currentReference() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function daysUntilDue(day) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let due = new Date(now.getFullYear(), now.getMonth(), Number(day));
  if (due < today) due = new Date(now.getFullYear(), now.getMonth()+1, Number(day));
  return Math.round((due - today) / 86400000);
}

function dueDateText(day) {
  const now = new Date();
  let due = new Date(now.getFullYear(), now.getMonth(), Number(day));
  if (due < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    due = new Date(now.getFullYear(), now.getMonth()+1, Number(day));
  }
  return due.toLocaleDateString("pt-BR");
}

function monthName() {
  return new Date().toLocaleDateString("pt-BR", {month:"long", year:"numeric"});
}

function isPaid(c) {
  return c.pagoReferencia === currentReference();
}

function statusOf(c) {
  if (isPaid(c)) return "paga";
  const days = daysUntilDue(c.vencimento);
  const now = new Date();
  const todayDay = now.getDate();
  const dueThisMonth = Number(c.vencimento);
  if (todayDay > dueThisMonth) return "vencida";
  if (days <= Number(c.aviso || 3)) return "proxima";
  return "pendente";
}

function showToast(text, ok=true) {
  $("toastText").textContent = text;
  $("toastIcon").textContent = ok ? "✓" : "!";
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2800);
}

function openWhatsApp(c, overdue=false) {
  const phone = normalizePhone(c.telefone);
  if (!phone) return showToast("Telefone inválido.", false);
  const days = daysUntilDue(c.vencimento);
  let message = overdue
    ? `Olá, ${c.nome}! Passando para lembrar que sua mensalidade de ${money(c.valor)} está em aberto. Podemos regularizar?`
    : `Olá, ${c.nome}! 😊 Lembrando que sua mensalidade de ${money(c.valor)} vence em ${c.vencimento} (${days} dia(s)). Obrigado!`;
  window.open(`https://wa.me/55${phone}?text=${encodeURIComponent(message)}`, "_blank");
}

function renderDashboard() {
  $("monthLabel").textContent = monthName();
  $("totalClientes").textContent = clientes.length;

  const paid = clientes.filter(isPaid);
  const overdue = clientes.filter(c => statusOf(c) === "vencida");
  const upcoming = clientes.filter(c => !isPaid(c) && daysUntilDue(c.vencimento) <= Number(c.aviso || 3) && daysUntilDue(c.vencimento) >= 0);
  const pending = clientes.filter(c => !isPaid(c) && statusOf(c) !== "vencida");

  const previsto = clientes.reduce((s,c)=>s+Number(c.valor||0),0);
  const recebido = paid.reduce((s,c)=>s+Number(c.valor||0),0);
  const pendente = Math.max(0, previsto-recebido);

  $("totalRecebido").textContent = money(recebido);
  $("totalProximos").textContent = upcoming.length;
  $("totalVencidas").textContent = overdue.length;
  $("statusPagas").textContent = paid.length;
  $("statusPendentes").textContent = pending.length;
  $("statusVencidas").textContent = overdue.length;
  $("totalPrevisto").textContent = money(previsto);
  $("totalFinanceiroRecebido").textContent = money(recebido);
  $("totalPendente").textContent = money(pendente);

  if (upcoming.length) {
    $("alertTitle").textContent = `${upcoming.length} vencimento(s) próximo(s)!`;
    $("alertText").textContent = "Você já pode enviar os lembretes pelo WhatsApp.";
  } else if (overdue.length) {
    $("alertTitle").textContent = `${overdue.length} mensalidade(s) vencida(s)!`;
    $("alertText").textContent = "Há pagamentos que precisam de atenção.";
  } else {
    $("alertTitle").textContent = "Nenhum vencimento próximo";
    $("alertText").textContent = "Tudo certo por enquanto.";
  }

  const list = [...upcoming].sort((a,b)=>daysUntilDue(a.vencimento)-daysUntilDue(b.vencimento)).slice(0,6);
  $("listaProximos").innerHTML = list.length ? `
    <table><thead><tr><th>CLIENTE</th><th>VALOR</th><th>VENCIMENTO</th><th>EM</th><th>AÇÃO</th></tr></thead>
    <tbody>${list.map(c=>`
      <tr>
        <td><span class="client-name">${escapeHtml(c.nome)}</span><span class="client-phone">${escapeHtml(c.telefone)}</span></td>
        <td>${money(c.valor)}</td>
        <td>${dueDateText(c.vencimento)}</td>
        <td><span class="badge orange">${daysUntilDue(c.vencimento) === 0 ? "Hoje" : `${daysUntilDue(c.vencimento)} dia(s)`}</span></td>
        <td><button class="action-btn whatsapp" data-wa="${c.id}">WhatsApp</button></td>
      </tr>`).join("")}</tbody></table>` :
    `<div class="empty"><div class="empty-icon">✓</div>Nenhum vencimento próximo.</div>`;

  document.querySelectorAll("[data-wa]").forEach(btn => btn.onclick = () => openWhatsApp(clientes.find(c=>c.id===btn.dataset.wa)));
}

function renderClients() {
  const q = ($("pesquisaCliente").value || "").toLowerCase().trim();
  const list = clientes.filter(c => c.nome.toLowerCase().includes(q) || String(c.telefone).includes(q));
  $("listaClientes").innerHTML = list.length ? list.map(c => `
    <article class="client-card">
      <div class="client-card-header"><div class="avatar">${initials(c.nome)}</div><span class="badge ${statusOf(c)==="paga"?"green":statusOf(c)==="vencida"?"red":"orange"}">${statusLabel(statusOf(c))}</span></div>
      <h3>${escapeHtml(c.nome)}</h3>
      <div class="client-info">📱 ${escapeHtml(c.telefone)}<br>📅 Vencimento dia ${c.vencimento}<br>🔔 Aviso ${c.aviso} dia(s) antes</div>
      <div class="client-value">${money(c.valor)}</div>
      <div class="client-actions">
        <button class="btn-whatsapp" data-client-wa="${c.id}">WhatsApp</button>
        <button class="btn-edit" data-edit="${c.id}">Editar</button>
        <button class="btn-delete" data-delete="${c.id}">Excluir</button>
      </div>
    </article>`).join("") :
    `<div class="empty"><div class="empty-icon">👥</div>Nenhum cliente encontrado.</div>`;

  document.querySelectorAll("[data-client-wa]").forEach(b=>b.onclick=()=>openWhatsApp(clientes.find(c=>c.id===b.dataset.clientWa)));
  document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>editClient(b.dataset.edit));
  document.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>removeClient(b.dataset.delete));
}

function renderMemberships() {
  const filter = $("filtroStatus").value;
  let list = [...clientes];
  if (filter !== "todos") list = list.filter(c => statusOf(c) === filter);
  list.sort((a,b)=>daysUntilDue(a.vencimento)-daysUntilDue(b.vencimento));
  $("listaMensalidades").innerHTML = list.length ? `
    <table><thead><tr><th>CLIENTE</th><th>VALOR</th><th>VENCIMENTO</th><th>STATUS</th><th>AÇÕES</th></tr></thead>
    <tbody>${list.map(c=>`
      <tr>
        <td><span class="client-name">${escapeHtml(c.nome)}</span><span class="client-phone">${escapeHtml(c.telefone)}</span></td>
        <td>${money(c.valor)}</td>
        <td>Dia ${c.vencimento} • ${dueDateText(c.vencimento)}</td>
        <td><span class="badge ${statusClass(statusOf(c))}">${statusLabel(statusOf(c))}</span></td>
        <td><div class="action-buttons">
          ${isPaid(c) ? `<button class="action-btn undo" data-undo="${c.id}">Desmarcar</button>` : `<button class="action-btn paid" data-paid="${c.id}">Marcar paga</button>`}
          <button class="action-btn whatsapp" data-wa2="${c.id}">WhatsApp</button>
        </div></td>
      </tr>`).join("")}</tbody></table>` :
    `<div class="empty">Nenhuma mensalidade nesta categoria.</div>`;

  document.querySelectorAll("[data-paid]").forEach(b=>b.onclick=()=>markPaid(b.dataset.paid));
  document.querySelectorAll("[data-undo]").forEach(b=>b.onclick=()=>unmarkPaid(b.dataset.undo));
  document.querySelectorAll("[data-wa2]").forEach(b=>b.onclick=()=>openWhatsApp(clientes.find(c=>c.id===b.dataset.wa2), statusOf(clientes.find(c=>c.id===b.dataset.wa2))==="vencida"));
}

function statusLabel(s) {
  return {paga:"Paga",pendente:"Pendente",vencida:"Vencida",proxima:"Próxima"}[s] || s;
}
function statusClass(s) {
  return {paga:"green",pendente:"orange",vencida:"red",proxima:"blue"}[s];
}
function initials(name) {
  return String(name||"").split(" ").filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();
}
function escapeHtml(v) {
  return String(v??"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

function renderAll() {
  renderDashboard();
  renderClients();
  renderMemberships();
}

function setAutosaveStatus(text, type="") {
  const el = $("autosaveStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `autosave-status ${type}`.trim();
}

function getClientFormData() {
  return {
    nome:$("nome").value.trim(),
    telefone:$("telefone").value.trim(),
    valor:Number($("valor").value),
    vencimento:Number($("vencimento").value),
    aviso:Number($("aviso").value),
    ativo:true,
    atualizadoEm:new Date().toISOString()
  };
}

function validClientData(data) {
  return Boolean(data.nome && data.telefone &&
    Number.isFinite(data.valor) && data.valor >= 0 &&
    Number.isInteger(data.vencimento) && data.vencimento >= 1 && data.vencimento <= 31);
}

function loadLocalClients() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    clientes = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error(e);
    clientes = [];
  }
  renderAll();
}

function saveLocalClients() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(clientes));
    return true;
  } catch (e) {
    console.error("Erro ao salvar no localStorage:", e);
    showToast("Não foi possível salvar no armazenamento local.", false);
    return false;
  }
}

function localSaveClient(data) {
  if (editingId) {
    const i = clientes.findIndex(c => c.id === editingId);
    if (i >= 0) clientes[i] = {...clientes[i], ...data, atualizadoEm: new Date().toISOString()};
  } else {
    editingId = `local_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const created = {...data, id: editingId, pagoReferencia: "", criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString()};
    clientes.push(created);
    queueSync(editingId);
    $("clienteId").value = editingId;
    $("modalTitulo").textContent = "Editar cliente";
  }
  saveLocalClients();
  renderAll();
}

function getPendingQueue() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); }
  catch { return []; }
}
function setPendingQueue(queue) {
  localStorage.setItem(PENDING_KEY, JSON.stringify([...new Set(queue)]));
}
function queueSync(id) {
  if (!id) return;
  const q = getPendingQueue();
  if (!q.includes(id)) q.push(id);
  setPendingQueue(q);
}
function dequeueSync(id) {
  setPendingQueue(getPendingQueue().filter(x => x !== id));
}

function getDeleteQueue() {
  try { return JSON.parse(localStorage.getItem(DELETE_KEY) || "[]"); } catch { return []; }
}
function queueDelete(id) {
  const q = getDeleteQueue(); if (!q.includes(id)) q.push(id);
  localStorage.setItem(DELETE_KEY, JSON.stringify(q));
}
async function migrateLocalToCloud() {
  if (!auth?.currentUser || !db) return;
  const local = [...clientes];
  if (!local.length) return;

  const uid = auth.currentUser.uid;
  for (const id of getDeleteQueue()) {
    try {
      await deleteDoc(doc(db, "users", uid, "clientes", id));
      localStorage.setItem(DELETE_KEY, JSON.stringify(getDeleteQueue().filter(x => x !== id)));
    } catch (err) { console.warn("Exclusão pendente:", id, err); }
  }
  for (const c of local) {
    try {
      if (String(c.id).startsWith("local_")) {
        const {id: _localId, ...cloudData} = c;
        const created = await addDoc(collection(db, "users", uid, "clientes"), {
          ...cloudData,
          criadoEm: c.criadoEm || new Date().toISOString(),
          atualizadoEm: serverTimestamp()
        });
        const i = clientes.findIndex(x => x.id === c.id);
        if (i >= 0) clientes[i] = {...clientes[i], id: created.id};
        dequeueSync(c.id);
      } else {
        await updateDoc(doc(db, "users", uid, "clientes", c.id), {
          ...c,
          atualizadoEm: serverTimestamp()
        });
        dequeueSync(c.id);
      }
    } catch (err) {
      console.warn("Aguardando sincronização:", c.id, err);
      queueSync(c.id);
    }
  }
  saveLocalClients();
  renderAll();
}

async function retryPendingSync() {
  if (!auth?.currentUser || !db || !navigator.onLine) return;
  await migrateLocalToCloud();
}

window.addEventListener("online", () => {
  if (auth?.currentUser) {
    setAutosaveStatus("● Internet restaurada — sincronizando...", "saving");
    retryPendingSync().then(() => setAutosaveStatus("✓ Sincronizado com a nuvem"));
  }
});
window.addEventListener("offline", () => {
  if (!configIncompleta) setAutosaveStatus("● Offline — salvo neste dispositivo", "error");
});

function hasCloud() {
  return !!(auth && db && auth.currentUser && !String(editingId || "").startsWith("local_"));
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!configIncompleta && !auth?.currentUser) return;
  setAutosaveStatus("● Alterações pendentes", "saving");
  autosaveTimer = setTimeout(autoSaveClient, 800);
}

async function autoSaveClient() {
  if (autosaveBusy) return;
  const data = getClientFormData();
  if (!validClientData(data)) {
    setAutosaveStatus("● Preencha os campos", "error");
    return;
  }
  autosaveBusy = true;
  setAutosaveStatus("● Salvando...", "saving");
  try {
    // Sempre salva no navegador primeiro: assim os dados não somem mesmo sem Firebase configurado.
    localSaveClient(data);

    // Se o Firebase estiver configurado e houver login, sincroniza também na nuvem.
    if (!configIncompleta && auth?.currentUser && db) {
      const ref = collection(db, "users", auth.currentUser.uid, "clientes");
      if (editingId && !String(editingId).startsWith("local_")) {
        await updateDoc(doc(db, "users", auth.currentUser.uid, "clientes", editingId), data);
      } else if (!editingId || String(editingId).startsWith("local_")) {
        const created = await addDoc(ref, {...data, pagoReferencia: "", criadoEm: serverTimestamp()});
        // troca o registro local temporário pelo ID do Firestore
        const localId = editingId;
        const i = clientes.findIndex(c => c.id === localId);
        if (i >= 0) clientes[i] = {...clientes[i], id: created.id};
        editingId = created.id;
        $("clienteId").value = created.id;
        saveLocalClients();
      }
      setAutosaveStatus("✓ Salvo e sincronizado");
    } else {
      setAutosaveStatus("✓ Salvo automaticamente neste dispositivo");
    }
    renderAll();
  } catch (err) {
    console.error(err);
    setAutosaveStatus("✓ Salvo neste dispositivo • nuvem indisponível", "error");
    queueSync(editingId);
    showToast("Salvo neste dispositivo. A sincronização será tentada novamente quando a internet voltar.", false);
  } finally {
    autosaveBusy = false;
    autosaveCreating = false;
  }
}

function openModal(client=null) {
  clearTimeout(autosaveTimer); autosaveBusy=false; autosaveCreating=false;
  editingId = client?.id || null;
  $("modalTitulo").textContent = client ? "Editar cliente" : "Novo cliente";
  $("clienteId").value = client?.id || "";
  $("nome").value = client?.nome || "";
  $("telefone").value = client?.telefone || "";
  $("valor").value = client?.valor ?? "";
  $("vencimento").value = client?.vencimento ?? "";
  $("aviso").value = client?.aviso ?? 3;
  $("modalCliente").classList.add("active");
  setAutosaveStatus(client ? "✓ Sincronizado" : "● Preencha para salvar");
}
function closeModal() {
  clearTimeout(autosaveTimer);
  $("modalCliente").classList.remove("active");
  $("formCliente").reset();
  editingId = null;
}
function editClient(id) {
  const c = clientes.find(x=>x.id===id);
  if (c) openModal(c);
}
async function removeClient(id) {
  const c = clientes.find(x=>x.id===id);
  if (!c || !confirm(`Excluir ${c.nome}?`)) return;
  clientes = clientes.filter(x => x.id !== id);
  saveLocalClients();
  if (auth?.currentUser && db && !String(id).startsWith("local_")) {
    try { await deleteDoc(doc(db, "users", auth.currentUser.uid, "clientes", id)); }
    catch (err) { console.error(err); queueDelete(id); showToast("Excluído deste dispositivo. A nuvem será atualizada quando voltar.", false); }
  }
  renderAll();
  showToast("Cliente excluído.");
}
async function markPaid(id) {
  const c = clientes.find(x=>x.id===id);
  if (!c) return;
  c.pagoReferencia = currentReference();
  c.atualizadoEm = new Date().toISOString();
  saveLocalClients();
  if (auth?.currentUser && db && !String(id).startsWith("local_")) {
    try { await updateDoc(doc(db,"users",auth.currentUser.uid,"clientes",id), {pagoReferencia:currentReference(), atualizadoEm:serverTimestamp()}); } catch(e){console.error(e);}
  }
  renderAll(); showToast("Mensalidade marcada como paga.");
}
async function unmarkPaid(id) {
  const c = clientes.find(x=>x.id===id);
  if (!c) return;
  c.pagoReferencia = ""; c.atualizadoEm = new Date().toISOString();
  saveLocalClients();
  if (auth?.currentUser && db && !String(id).startsWith("local_")) {
    try { await updateDoc(doc(db,"users",auth.currentUser.uid,"clientes",id), {pagoReferencia:"", atualizadoEm:serverTimestamp()}); } catch(e){console.error(e);}
  }
  renderAll(); showToast("Pagamento desmarcado.");
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (configIncompleta) return showToast("Configure o Firebase no script.js primeiro.", false);
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    showToast("Login realizado.");
  } catch (err) {
    console.error(err);
    showToast(authErrorMessage(err), false);
  }
});

$("registerBtn").onclick = async () => {
  if (configIncompleta) return showToast("Configure o Firebase no script.js primeiro.", false);

  const email = $("email").value.trim();
  const password = $("password").value;
  const confirm = $("passwordConfirm").value;

  if (!email) return showToast("Informe seu e-mail.", false);
  if (password.length < 6) return showToast("A senha precisa ter pelo menos 6 caracteres.", false);
  if (password !== confirm) return showToast("As senhas não são iguais.", false);

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    showToast("Conta criada com sucesso!");
    $("passwordConfirm").value = "";
  } catch (err) {
    console.error(err);
    showToast(authErrorMessage(err), false);
  }
};

$("forgotBtn").onclick = async () => {
  if (configIncompleta) return showToast("Configure o Firebase no script.js primeiro.", false);
  const email = $("email").value.trim();
  if (!email) return showToast("Digite seu e-mail primeiro.", false);

  try {
    const { sendPasswordResetEmail } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js");
    await sendPasswordResetEmail(auth, email);
    showToast("Link de recuperação enviado para seu e-mail.");
  } catch (err) {
    console.error(err);
    showToast(authErrorMessage(err), false);
  }
};

$("logoutBtn").onclick = () => signOut(auth);

$("newClientBtn").onclick = () => openModal();
$("newClientBtn2").onclick = () => openModal();
$("fecharModal").onclick = closeModal;
$("cancelarModal").onclick = closeModal;
$("modalCliente").addEventListener("click", e => { if(e.target === $("modalCliente")) closeModal(); });

$("formCliente").addEventListener("submit", async e => {
  e.preventDefault();
  clearTimeout(autosaveTimer);
  const data = getClientFormData();
  if (!validClientData(data)) return showToast("Confira os dados preenchidos.", false);
  try {
    await autoSaveClient();
    closeModal();
    showToast("Dados salvos no localStorage.");
  } catch(err) {
    console.error(err);
    showToast("Erro ao salvar. Verifique o Firebase.",false);
  }
});

["nome","telefone","valor","vencimento","aviso"].forEach(id => {
  $(id).addEventListener("input", scheduleAutosave);
  $(id).addEventListener("change", scheduleAutosave);
});

$("pesquisaCliente").oninput = renderClients;
$("filtroStatus").onchange = renderMemberships;
$("seeAllBtn").onclick = () => switchSection("mensalidades");

// Persistência local: grava imediatamente e também quando a página fica em segundo plano.
window.addEventListener("storage", (event) => {
  if (event.key === LOCAL_KEY) loadLocalClients();
});
window.addEventListener("beforeunload", () => {
  saveLocalClients();
});

document.querySelectorAll(".menu-item").forEach(btn => btn.onclick = () => switchSection(btn.dataset.section));

function switchSection(section) {
  document.querySelectorAll(".menu-item").forEach(b=>b.classList.toggle("active",b.dataset.section===section));
  document.querySelectorAll(".section").forEach(s=>s.classList.toggle("active",s.id===section));
  const titles = {
    dashboard:["Dashboard","Acompanhe suas mensalidades e vencimentos."],
    clientes:["Clientes","Cadastre e gerencie seus clientes."],
    mensalidades:["Mensalidades","Controle pagamentos, vencimentos e lembretes."]
  };
  $("pageTitle").textContent = titles[section][0];
  $("pageSubtitle").textContent = titles[section][1];
}

if (configIncompleta) {
  localMode = true;
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("userEmail").textContent = "Modo local • salvamento automático";
  $("firebaseStatus").textContent = "Modo local ativo — dados salvos automaticamente neste dispositivo.";
  loadLocalClients();
} else {
  onAuthStateChanged(auth, async user => {
    if (!user) {
      $("loginScreen").classList.remove("hidden");
      $("app").classList.add("hidden");
      if (unsubscribeClientes) unsubscribeClientes();
      return;
    }
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userEmail").textContent = user.email;
    $("firebaseStatus").textContent = navigator.onLine
      ? "Nuvem conectada • salvamento automático ativo"
      : "Offline • salvando neste dispositivo";
    // Primeiro recupera a cópia local e envia alterações locais para a nuvem.
    loadLocalClients();
    await migrateLocalToCloud();
    const ref = collection(db,"users",user.uid,"clientes");
    if (unsubscribeClientes) unsubscribeClientes();
    unsubscribeClientes = onSnapshot(ref, snap => {
      const cloud = snap.docs.map(d=>({id:d.id,...d.data()}));
      // A nuvem passa a ser a fonte compartilhada entre aparelhos.
      clientes = cloud;
      saveLocalClients();
      renderAll();
      $("firebaseStatus").textContent = navigator.onLine
        ? "✓ Sincronizado com a nuvem"
        : "● Offline • dados locais";
    }, err => {
      console.error(err);
      $("firebaseStatus").textContent = "● Nuvem indisponível • usando dados locais";
      loadLocalClients();
      showToast("Nuvem indisponível. Seus dados locais continuam salvos.",false);
    });
  });
}

