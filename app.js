/* ============================================================================
   APP CONTABILITA
   ============================================================================
   Indice del file (cerca questi titoli con Ctrl+F per saltare tra le sezioni):

   1. CONFIG                -> CLIENT_ID, nome del file su Drive, costanti varie
   2. STATE                 -> lo stato dell'app in memoria + struttura di default
   3. AUTH                  -> login/logout con Google (Google Identity Services)
   4. DRIVE I/O             -> le 4 chiamate REST verso Google Drive
   5. UTIL                  -> funzioni di supporto (formattazione, ricerca id)
   6. BILANCIO CALC         -> il "motore di calcolo" del bilancio mensile
   7. RENDER: BILANCIO      -> disegna la tabella del bilancio
   8. RENDER: MOVIMENTI     -> lista + form di movimenti
   9. RENDER: TRASFERIMENTI -> lista + form di trasferimenti
   10. RENDER: IMPOSTAZIONI -> conti/saldi iniziali + albero macro/categorie
   11. EXPORT / IMPORT      -> backup manuale in locale
   12. TAB                  -> cambio scheda
   13. MASTER RENDER        -> renderAll(), richiamata dopo ogni modifica

   FLUSSO GENERALE:
   login -> loadOrCreateFile() legge/crea il JSON su Drive -> state
   ogni azione utente (aggiungi/modifica/elimina) cambia `state`,
   richiama renderAll() per aggiornare la UI e persist() per salvare
   subito su Drive.

   PER PERSONALIZZARE:
   - Le categorie di default (usate solo alla primissima creazione del file
     su Drive) sono in DEFAULT_STATE qui sotto.
   - Il nome del file su Drive è la costante FILE_NAME.
   - La logica di calcolo del bilancio è tutta in computeBilancio().
   ============================================================================ */

/* ============================================================================
   1. CONFIG
   Costanti principali: se cambi il progetto Google Cloud o vuoi rinominare
   il file salvato su Drive, tocca solo qui.
   ============================================================================ */
const CLIENT_ID = "417307407339-hvf9b8pnsrdluuttvcog56olg6lvvvrk.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const FILE_NAME = "bilancio-accounting.json";
const MESI = ["GENNAIO","FEBBRAIO","MARZO","APRILE","MAGGIO","GIUGNO","LUGLIO","AGOSTO","SETTEMBRE","OTTOBRE","NOVEMBRE","DICEMBRE"];

/* ============================================================================
   2. STATE
   `state` è l'unico oggetto che contiene TUTTI i dati (conti, categorie,
   movimenti, trasferimenti...). Viene popolato leggendo il JSON da Drive,
   e ogni modifica lo aggiorna direttamente prima di richiamare persist().
   `DEFAULT_STATE` è la struttura usata SOLO se su Drive non esiste ancora
   nessun file: puoi modificarla per partire con le tue categorie preferite.
   ============================================================================ */
let accessToken = null;
let fileId = null;
let state = null; // parsed JSON
let saving = false;
let saveQueued = false;

const DEFAULT_STATE = {
  version: 1,
  valuta: "EUR",
  aggiornamento: new Date().toISOString().slice(0,10),
  conti: [
    // { id:"trade", nome:"TradeRepublic" },
    // { id:"sella", nome:"Banca Sella" }
  ],
  saldiIniziali: {
    // [new Date().getFullYear()]: { trade:0, sella:0 }
  },
  macroCategorie: [
    // { id:"stipendi", nome:"Stipendi" },
    // { id:"rimborsi", nome:"Rimborsi" },
    // { id:"entrate", nome:"Altre Entrate" },
    // { id:"obbligate", nome:"Spese Obbligate" },
    // { id:"dottorato", nome:"Spese Dottorato" },
    // { id:"casa", nome:"Spese Casa" },
    // { id:"extra", nome:"Spese Extra" }
  ],
  categorie: [
    // { id:"stipendiodottorato", nome:"Stipendio Dottorato", macroCategoria:"stipendi" },
    // { id:"fatture", nome:"Fatture", macroCategoria:"stipendi" },
    // { id:"interessi", nome:"Interessi", macroCategoria:"entrate" },
    // { id:"altreentrate", nome:"Altre entrate", macroCategoria:"entrate" },
    // { id:"rimborsidottorato", nome:"Rimborsi dottorato", macroCategoria:"rimborsi" },
    // { id:"altrerimborsi", nome:"Altri Rimborsi", macroCategoria:"rimborsi" },
    // { id:"tassefattura", nome:"Tasse fattura", macroCategoria:"obbligate" },
    // { id:"bolloauto", nome:"Bollo auto", macroCategoria:"obbligate" },
    // { id:"commercialista", nome:"Commercialista", macroCategoria:"obbligate" },
    // { id:"altreobbligate", nome:"Altre spese obbligate", macroCategoria:"obbligate" },
    // { id:"affitto", nome:"Affitto", macroCategoria:"casa" },
    // { id:"bollette", nome:"Bollette", macroCategoria:"casa" },
    // { id:"spesa", nome:"Spesa", macroCategoria:"casa" },
    // { id:"ristoranti", nome:"Ristoranti e bar", macroCategoria:"extra" },
    // { id:"abbonamenti", nome:"Abbonamenti", macroCategoria:"extra" },
    // { id:"altreextra", nome:"Altre spese extra", macroCategoria:"extra" }
  ],
  movimenti: [],
  trasferimenti: []
};

/* ============================================================================
   3. AUTH — login con Google (OAuth via Google Identity Services)
   initAuth() crea un "token client": quando l'utente clicca su Accedi,
   Google apre il popup di consenso e nel callback riceviamo un access_token
   valido per chiamare le API di Drive (nessuna password gestita da noi).
   Lo scope 'drive.file' fa sì che l'app veda SOLO i file creati da lei
   stessa, non l'intero Drive dell'utente.
   ============================================================================ */
let tokenClient;
const AUTH_SESSION_KEY = "balancy-google-auth";

function saveAuthSession(resp){
  const expiresIn = Number(resp.expires_in || 0);
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
    accessToken: resp.access_token,
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000
  }));
}

function clearAuthSession(){
  sessionStorage.removeItem(AUTH_SESSION_KEY);
}

async function activateAuthenticatedUi(token){
  accessToken = token;
  setStatus(true, "connesso");
  document.getElementById("loginBtn").textContent = "Disconnetti";
  document.getElementById("tabs").style.display = "flex";
  document.getElementById("gate").style.display = "none";
  document.getElementById("content").style.display = "block";
  await loadOrCreateFile();
}

function initAuth(){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error){
        clearAuthSession();
        setStatus(false, "non connesso");
        return;
      }
      saveAuthSession(resp);
      await activateAuthenticatedUi(resp.access_token);
    }
  });

  // Un access token valido viene conservato solo per la durata della scheda.
  // sessionStorage sopravvive a un refresh, ma viene eliminato chiudendo la
  // scheda/browser. Se il token è scaduto proviamo a rinnovarlo senza chiedere
  // nuovamente il consenso: se Google richiede interazione, resta disponibile
  // il normale pulsante di accesso.
  try{
    const saved = JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || "null");
    if (saved?.accessToken && saved?.expiresAt > Date.now()){
      activateAuthenticatedUi(saved.accessToken);
    } else if (saved){
      clearAuthSession();
      tokenClient.requestAccessToken({ prompt: "" });
    }
  } catch(e){
    clearAuthSession();
  }
}
function setStatus(ok, text){
  document.getElementById("statusDot").className = "status-dot " + (ok?"ok":"err");
  document.getElementById("statusText").textContent = text;
}
document.getElementById("loginBtn").addEventListener("click", () => {
  if (accessToken){
    google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; fileId = null; state = null;
    clearAuthSession();
    document.getElementById("loginBtn").textContent = "Accedi con Google";
    document.getElementById("tabs").style.display = "none";
    document.getElementById("gate").style.display = "block";
    document.getElementById("content").style.display = "none";
    setStatus(false, "non connesso");
    return;
  }
  tokenClient.requestAccessToken({ prompt: "consent" });
});
window.addEventListener("load", () => {
  // GIS script loads async; poll briefly for google object
  const t = setInterval(() => {
    if (window.google && google.accounts){ clearInterval(t); initAuth(); }
  }, 100);
});

/* ============================================================================
   4. DRIVE I/O — le chiamate dirette alle API REST di Google Drive
   driveFetch()   -> wrapper che aggiunge sempre l'header Authorization
   findFile()     -> cerca un file chiamato FILE_NAME (query per nome)
   createFile()   -> crea il file la prima volta (upload multipart)
   updateFile()   -> sovrascrive il contenuto di un file esistente (PATCH)
   getFileContent()-> scarica il contenuto testuale del file (?alt=media)
   loadOrCreateFile() e persist() sono le due funzioni "di alto livello"
   usate dal resto dell'app: la prima all'avvio, la seconda dopo ogni
   modifica ai dati.
   ============================================================================ */
async function driveFetch(url, opts={}){
  opts.headers = Object.assign({ "Authorization": "Bearer " + accessToken }, opts.headers||{});
  const res = await fetch(url, opts);
  if (!res.ok){ throw new Error("Drive API error " + res.status + ": " + await res.text()); }
  return res;
}
async function findFile(){
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)`);
  const data = await res.json();
  return (data.files && data.files.length) ? data.files[0] : null;
}
async function createFile(content){
  const metadata = { name: FILE_NAME, mimeType: "application/json" };
  const boundary = "libro_mastro_boundary";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await res.json();
  return data.id;
}
async function updateFile(id, content){
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: content
  });
}
async function getFileContent(id){
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return await res.text();
}

async function loadOrCreateFile(){
  setStatus(true, "caricamento...");
  try{
    const existing = await findFile();
    if (existing){
      fileId = existing.id;
      const text = await getFileContent(fileId);
      state = JSON.parse(text);
    } else {
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
      fileId = await createFile(JSON.stringify(state, null, 2));
    }
    setStatus(true, "connesso · sincronizzato");
    renderAll();
  } catch(e){
    console.error(e);
    setStatus(false, "errore caricamento");
    alert("Errore nel caricare il file da Drive: " + e.message);
  }
}

async function persist(){
  if (!fileId || !state) return;
  if (saving){ saveQueued = true; return; }
  saving = true;
  setStatus(true, "salvataggio...");
  try{
    state.aggiornamento = new Date().toISOString().slice(0,10);
    await updateFile(fileId, JSON.stringify(state, null, 2));
    setStatus(true, "connesso · sincronizzato");
  } catch(e){
    console.error(e);
    setStatus(false, "errore salvataggio");
  } finally {
    saving = false;
    if (saveQueued){ saveQueued = false; persist(); }
  }
}

/* ============================================================================
   5. UTIL — funzioni di supporto usate ovunque nel file
   eur()        -> formatta un numero come valuta italiana (es. € 1.234,56)
   nextId()     -> genera il prossimo id progressivo tipo m-26-000004
   slugify()    -> trasforma un nome ("Banca Sella") in un id leggibile ("bancasella")
   uniqueId()   -> come slugify(), ma garantisce che l'id non sia già usato
                   nella lista indicata (aggiunge un numero se serve, es. "extra2")
   catById(), macroById(), contoById() -> ricerche rapide per id
   yearsAvailable() -> elenco degli anni da mostrare nel menu a tendina
   ============================================================================ */
function eur(n){
  return (n||0).toLocaleString("it-IT", { style:"currency", currency: state?.valuta || "EUR" });
}
// Converte una data "aaaa-mm-gg" (formato usato internamente e nei campi
// <input type="date">) nel formato italiano "gg/mm/aaaa" per la visualizzazione.
function formatDataIt(dataIso){
  if (!dataIso) return "";
  const [y, m, d] = dataIso.split("-");
  return `${d}/${m}/${y}`;
}
function nextId(prefix, list, year){
  const yy = String(year).slice(-2);
  const existing = list.filter(x => x.id && x.id.startsWith(`${prefix}-${yy}-`))
    .map(x => parseInt(x.id.split("-")[2], 10)).filter(n => !isNaN(n));
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  return `${prefix}-${yy}-${String(next).padStart(6,"0")}`;
}
// Trasforma un nome in un id "pulito": minuscolo, senza accenti, senza spazi
// o simboli. Es: "TradeRepublic" -> "traderepublic", "Spese Extra" -> "speseextra"
function slugify(nome){
  return (nome || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // rimuove gli accenti
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")                          // tiene solo lettere/numeri
    .trim();
}
// Genera un id univoco a partire dal nome, controllando che non esista già
// nella lista passata (conti, macroCategorie o categorie). Se l'id esiste
// già, aggiunge un numero progressivo (es. "extra", "extra2", "extra3"...).
function uniqueId(nome, list){
  const base = slugify(nome) || "voce";
  let id = base, i = 2;
  while (list.some(x => x.id === id)){
    id = base + i;
    i++;
  }
  return id;
}
function catById(id){ return state.categorie.find(c => c.id === id); }
function macroById(id){ return state.macroCategorie.find(m => m.id === id); }
function contoById(id){ return state.conti.find(c => c.id === id); }
function yearsAvailable(){
  const ys = new Set(Object.keys(state.saldiIniziali||{}).map(Number));
  state.movimenti.forEach(m => ys.add(new Date(m.data).getFullYear()));
  state.trasferimenti.forEach(t => ys.add(new Date(t.data).getFullYear()));
  ys.add(new Date().getFullYear());
  return Array.from(ys).sort();
}

/* ============================================================================
   6. BILANCIO CALC — il cuore matematico dell'app
   computeBilancio(year) calcola, per l'anno passato:
     - il saldo di fine mese di ogni conto (saldo iniziale + movimenti
       + trasferimenti in entrata - trasferimenti in uscita, cumulati
       mese per mese)
     - il saldo totale (somma di tutti i conti) mese per mese
     - la somma mensile di ogni macro categoria (stipendi, casa, extra...)
     - la classificazione automatica di ogni macro categoria come
       "entrata" o "uscita" in base al segno del totale dei movimenti
     - i totali di entrate e uscite del mese (positivi/negativi separati)
   Se vuoi cambiare la logica di calcolo (es. far ripartire il saldo
   iniziale dell'anno dal saldo finale dell'anno precedente invece che
   da un valore fisso), è qui che devi intervenire.
   ============================================================================ */
function computeBilancio(year){
  const conti = state.conti;
  const saldoIniz = (state.saldiIniziali[year]) || {};
  // running balance per conto per month (end-of-month)
  const contoMonthly = {}; // contoId -> [12]
  conti.forEach(c => {
    let running = saldoIniz[c.id] || 0;
    contoMonthly[c.id] = [];
    for (let m=0;m<12;m++){
      const movSum = state.movimenti
        .filter(x => x.conto===c.id && sameYearMonth(x.data, year, m))
        .reduce((a,b)=>a+b.importo,0);
      const traIn = state.trasferimenti
        .filter(x => x.a===c.id && sameYearMonth(x.data, year, m))
        .reduce((a,b)=>a+b.importo,0);
      const traOut = state.trasferimenti
        .filter(x => x.da===c.id && sameYearMonth(x.data, year, m))
        .reduce((a,b)=>a+b.importo,0);
      running += movSum + traIn - traOut;
      contoMonthly[c.id].push(running);
    }
  });
  const saldoTotaleMonthly = [];
  for (let m=0;m<12;m++){
    saldoTotaleMonthly.push(conti.reduce((a,c)=>a+contoMonthly[c.id][m],0));
  }
  const saldoInizioAnno = conti.reduce((a,c)=>a+(saldoIniz[c.id]||0),0);

  // macro category monthly sums (natural sign)
  const macroMonthly = {}; // macroId -> [12]
  state.macroCategorie.forEach(mc => { macroMonthly[mc.id] = new Array(12).fill(0); });
  for (let m=0;m<12;m++){
    state.movimenti.filter(x => sameYearMonth(x.data, year, m)).forEach(mv => {
      const cat = catById(mv.categoria);
      if (!cat) return;
      macroMonthly[cat.macroCategoria][m] += mv.importo;
    });
  }
  // classify macro as entrata/uscita by total sign across dataset
  const entrateMacro = [], usciteMacro = [];
  state.macroCategorie.forEach(mc => {
    const total = macroMonthly[mc.id].reduce((a,b)=>a+b,0);
    // also consider all-time sign if this year has no data
    if (total < 0) usciteMacro.push(mc); else entrateMacro.push(mc);
  });
  const entrateTotaliMonthly = [], usciteTotaliMonthly = [];
  for (let m=0;m<12;m++){
    entrateTotaliMonthly.push(entrateMacro.reduce((a,mc)=>a+Math.max(macroMonthly[mc.id][m],0)+ (entrateMacro.includes(mc)? Math.min(0,0):0),0));
  }
  // simpler recompute: entrate totali = sum of positive movimenti that month; uscite totali = abs(sum of negative movimenti that month)
  const entTot = [], uscTot = [];
  for (let m=0;m<12;m++){
    let ent=0, usc=0;
    state.movimenti.filter(x => sameYearMonth(x.data, year, m)).forEach(mv=>{
      if (mv.importo>=0) ent+=mv.importo; else usc+=mv.importo;
    });
    entTot.push(ent); uscTot.push(Math.abs(usc));
  }

  // bilancio mensile = entrate - uscite del singolo mese
  // bilancio annuale = somma cumulata del bilancio mensile da gennaio al mese corrente
  const bilancioMensile = [], bilancioAnnuale = [];
  let cumulato = 0;
  for (let m=0;m<12;m++){
    const netto = entTot[m] - uscTot[m];
    bilancioMensile.push(netto);
    cumulato += netto;
    bilancioAnnuale.push(cumulato);
  }

  return { conti, contoMonthly, saldoTotaleMonthly, saldoInizioAnno, macroMonthly, entrateMacro, usciteMacro, entTot, uscTot, bilancioMensile, bilancioAnnuale };
}
function sameYearMonth(dateStr, year, monthIdx){
  const d = new Date(dateStr+"T00:00:00");
  return d.getFullYear()===year && d.getMonth()===monthIdx;
}

/* ============================================================================
   7. RENDER: BILANCIO — disegna la tabella (foglio pergamena) del bilancio
   renderYearSelect() popola il menu a tendina degli anni.
   renderBilancio(year) costruisce l'HTML della tabella riga per riga:
   un conto per riga, poi SALDO TOTALE, poi entrate totali + dettaglio
   per macro categoria, poi uscite totali + dettaglio.
   ============================================================================ */
function renderYearSelect(){
  const sel = document.getElementById("yearSelect");
  const years = yearsAvailable();
  const annoPrecedente = sel.value; // l'anno che l'utente stava guardando prima del refresh
  sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join("");
  // Se l'anno che si stava guardando esiste ancora, lo si mantiene selezionato
  // (altrimenti si torna sull'anno corrente). Senza questo accorgimento,
  // ogni renderAll() (es. dopo aver modificato un saldo iniziale) avrebbe
  // fatto "saltare" la vista sull'anno di oggi.
  sel.value = years.map(String).includes(annoPrecedente) ? annoPrecedente : String(new Date().getFullYear());
  sel.onchange = () => renderBilancio(Number(sel.value));
}
function renderBilancio(year){
  const b = computeBilancio(year);
  // Colonna "Voce" + 12 mesi (la colonna "Inizio anno" è stata rimossa:
  // poco utile da vedere ogni volta, resta comunque modificabile in
  // Impostazioni > Saldi iniziali).
  let html = `<table class="ledger"><thead><tr><th>Voce</th>`;
  html += MESI.map(m=>`<th>${m}</th>`).join("") + `</tr></thead><tbody>`;

  b.conti.forEach(c => {
    html += `<tr><td>conto ${c.nome}</td>`;
    html += b.contoMonthly[c.id].map(v=>`<td>${eur(v)}</td>`).join("");
    html += `</tr>`;
  });
  html += `<tr class="row-total"><td>SALDO TOTALE</td>`;
  html += b.saldoTotaleMonthly.map(v=>`<td>${eur(v)}</td>`).join("") + `</tr>`;

  // Bilancio mensile: entrate - uscite del singolo mese.
  // Bilancio annuale: la stessa cosa ma cumulata mese dopo mese.
  html += `<tr><td>Bilancio mensile</td>` +
    b.bilancioMensile.map(v=>`<td class="${v>=0?'pos':'neg'}">${eur(v)}</td>`).join("") + `</tr>`;
  html += `<tr class="row-balance"><td>Bilancio annuale</td>` +
    b.bilancioAnnuale.map(v=>`<td class="${v>=0?'pos':'neg'}">${eur(v)}</td>`).join("") + `</tr>`;

  html += `<tr class="row-spacer"><td colspan="13"></td></tr>`;

  html += `<tr class="row-section"><td>entrate totali</td>` + b.entTot.map(v=>`<td class="pos">${eur(v)}</td>`).join("") + `</tr>`;
  b.entrateMacro.forEach(mc => {
    html += `<tr class="row-sub"><td>${mc.nome.toLowerCase()}</td>` + b.macroMonthly[mc.id].map(v=>`<td>${v?eur(v):"—"}</td>`).join("") + `</tr>`;
  });
  html += `<tr class="row-section"><td>uscite totali</td>` + b.uscTot.map(v=>`<td class="neg">${eur(v)}</td>`).join("") + `</tr>`;
  b.usciteMacro.forEach(mc => {
    html += `<tr class="row-sub"><td>${mc.nome.toLowerCase()}</td>` + b.macroMonthly[mc.id].map(v=>`<td>${v?eur(v):"—"}</td>`).join("") + `</tr>`;
  });
  html += `</tbody></table>`;
  document.getElementById("bilancioCard").innerHTML = html;

  renderBilancioCharts(b, year);
}

/* ----------------------------------------------------------------------
   Grafici del bilancio: due grafici ad area in pila ("stacked area"),
   disegnati a mano in SVG (nessuna libreria esterna, coerente con il
   resto dell'app). renderBilancioCharts(b) riceve lo stesso oggetto
   calcolato da computeBilancio() e passa a renderStackedAreaChart() i
   dati già pronti per ciascuno dei due grafici:
   - "Andamento conti": il saldo di ogni conto, impilato mese per mese
     (la cima della pila coincide col SALDO TOTALE della tabella sopra).
   - "Entrate e uscite": entrate totali e uscite totali, impilate per
     confrontarne visivamente la grandezza mese per mese.
   ---------------------------------------------------------------------- */
// Palette categorica per i conti: ordine fisso (mai assegnato a caso o in
// base alla posizione in classifica), pensata per restare distinguibile
// anche a chi ha una forma di daltonismo. Se i conti sono più di 8 i colori
// si ripetono: è un limite accettabile, capita raramente in pratica.
const CHART_PALETTE = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#9085e9","#e66767","#008300"];

// Stato locale dei filtri del grafico "Andamento macro categorie".
// Non viene salvato su Drive: serve solo a mantenere le scelte mentre
// l'app è aperta e viene ridisegnata dopo una modifica ai dati.
const macroChartState = {
  selectedIds: null,       // null = prima apertura: seleziona tutte le macro
  granularita: "mensile", // giornaliero | settimanale | mensile
  cumulativo: false,
  assoluto: false,
  andamento: false
};

function renderBilancioCharts(b, year){
  renderStackedAreaChart("chartConti", b.conti.map((c,i) => ({
    nome: c.nome,
    colore: CHART_PALETTE[i % CHART_PALETTE.length],
    valori: b.contoMonthly[c.id]
  })));
  // Le uscite sono mostrate in negativo (sotto lo zero): così la pila
  // "Entrate" verso l'alto e "Uscite" verso il basso rende subito l'idea
  // di quanto è entrato e quanto è uscito, e la linea bianca sovrapposta
  // (entrate + uscite, che essendo le uscite negative è proprio il netto
  // del mese) mostra a colpo d'occhio se il bilancio è in positivo o in
  // negativo senza dover fare il calcolo a mente.
  renderStackedAreaChart("chartFlussi", [
    { nome:"Entrate", colore:"var(--green)", valori: b.entTot },
    { nome:"Uscite",  colore:"var(--red)",   valori: b.uscTot.map(v => -v) }
  ], {
    linea: { nome:"Netto (entrate - uscite)", colore:"rgba(255,255,255,0.85)", valori: b.bilancioMensile },
    // Col segno esplicito: +2.425,15 € per un'entrata, -1.564,14 € per
    // un'uscita, +861,01 € per un netto in attivo (o già -€ per un netto
    // in passivo, che il segno meno rende comunque inequivocabile).
    segnato: true,
    // Entrate e uscite partono entrambe da zero (non impilate una
    // sull'altra): è questo che fa scendere l'area delle uscite dalla
    // linea 0 invece che dal bordo superiore delle entrate.
    divergente: true
  });

  // Stessa lettura del grafico mensile, ma con un punto per ogni giorno
  // dell'anno e valori cumulati dall'1 gennaio fino al giorno selezionato.
  const giornaliero = computeFlussiGiornalieriCumulativi(year);
  renderStackedAreaChart("chartFlussiGiornalieri", [
    { nome:"Entrate cumulative", colore:"var(--green)", valori: giornaliero.entrate },
    { nome:"Uscite cumulative",  colore:"var(--red)",   valori: giornaliero.uscite.map(v => -v) }
  ], {
    linea: { nome:"Netto cumulativo", colore:"rgba(255,255,255,0.85)", valori: giornaliero.netto },
    segnato: true,
    divergente: true,
    labels: giornaliero.labels,
    axisLabels: giornaliero.axisLabels,
    mostraPuntiLinea: false
  });

  renderMacroChart(year);
}

// Costruisce le serie giornaliere cumulative per l'anno scelto. I
// trasferimenti non sono inclusi, esattamente come nel grafico mensile
// Entrate e uscite: contano solo i movimenti.
function computeFlussiGiornalieriCumulativi(year){
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const movPerGiorno = new Map();

  state.movimenti.forEach(mv => {
    const d = new Date(mv.data + "T00:00:00");
    if (d.getFullYear() !== year) return;
    const key = mv.data;
    const corrente = movPerGiorno.get(key) || { entrate:0, uscite:0 };
    if (mv.importo >= 0) corrente.entrate += mv.importo;
    else corrente.uscite += Math.abs(mv.importo);
    movPerGiorno.set(key, corrente);
  });

  const labels = [], axisLabels = [], entrate = [], uscite = [], netto = [];
  let cumEntrate = 0, cumUscite = 0;
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)){
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const iso = `${yyyy}-${mm}-${dd}`;
    const flussi = movPerGiorno.get(iso) || { entrate:0, uscite:0 };
    cumEntrate += flussi.entrate;
    cumUscite += flussi.uscite;

    labels.push(`${dd}/${mm}/${yyyy}`);
    axisLabels.push(d.getDate() === 1 ? MESI[d.getMonth()].slice(0,3) : "");
    entrate.push(cumEntrate);
    uscite.push(cumUscite);
    netto.push(cumEntrate - cumUscite);
  }
  return { labels, axisLabels, entrate, uscite, netto };
}


// ----------------------------------------------------------------------
// Quarto grafico: andamento di una o più macro categorie come linee.
// I filtri permettono di scegliere granularità, cumulativo e valore assoluto.
function renderMacroChart(year){
  const controls = document.getElementById("macroChartControls");
  const chart = document.getElementById("chartMacro");
  if (!controls || !chart) return;

  const macroIdsEsistenti = state.macroCategorie.map(m => m.id);
  if (macroChartState.selectedIds === null){
    macroChartState.selectedIds = [...macroIdsEsistenti];
  } else {
    macroChartState.selectedIds = macroChartState.selectedIds.filter(id => macroIdsEsistenti.includes(id));
  }

  controls.innerHTML = `
    <div class="macro-chart-control-row">
      <span class="macro-chart-control-label">Macro</span>
      <div class="macro-chart-pills">
        ${state.macroCategorie.map(mc => `
          <label class="macro-chart-pill">
            <input type="checkbox" data-macro-id="${mc.id}" ${macroChartState.selectedIds.includes(mc.id) ? "checked" : ""}>
            <span>${mc.nome}</span>
          </label>
        `).join("") || `<span style="font-size:12px;color:var(--brass-dim)">Nessuna macro categoria configurata</span>`}
      </div>
    </div>

    <div class="macro-chart-control-row">
      <span class="macro-chart-control-label">Periodo</span>
      <div class="macro-chart-segment" data-control="granularita">
        ${["giornaliero","settimanale","mensile"].map(g =>
          `<button type="button" data-value="${g}" class="${macroChartState.granularita===g ? "active" : ""}">${g[0].toUpperCase()+g.slice(1)}</button>`
        ).join("")}
      </div>
    </div>

    <div class="macro-chart-control-row">
      <span class="macro-chart-control-label">Opzioni</span>
      <label class="macro-chart-check">
        <input type="checkbox" data-control="cumulativo" ${macroChartState.cumulativo ? "checked" : ""}>
        Cumulativo
      </label>
      <label class="macro-chart-check">
        <input type="checkbox" data-control="assoluto" ${macroChartState.assoluto ? "checked" : ""}>
        Valore assoluto
      </label>
      <label class="macro-chart-check">
        <input type="checkbox" data-control="andamento" ${macroChartState.andamento ? "checked" : ""}>
        Andamento
      </label>
    </div>`;

  controls.querySelectorAll("input[data-macro-id]").forEach(input => {
    input.addEventListener("change", () => {
      macroChartState.selectedIds = Array.from(controls.querySelectorAll("input[data-macro-id]:checked")).map(x => x.dataset.macroId);
      renderMacroChartPlot(year);
    });
  });

  controls.querySelectorAll('[data-control="granularita"] button').forEach(btn => {
    btn.addEventListener("click", () => {
      macroChartState.granularita = btn.dataset.value;
      renderMacroChart(year);
    });
  });

  const cumulativo = controls.querySelector('input[data-control="cumulativo"]');
  const assoluto = controls.querySelector('input[data-control="assoluto"]');
  const andamento = controls.querySelector('input[data-control="andamento"]');
  cumulativo?.addEventListener("change", () => {
    macroChartState.cumulativo = cumulativo.checked;
    renderMacroChartPlot(year);
  });
  assoluto?.addEventListener("change", () => {
    macroChartState.assoluto = assoluto.checked;
    renderMacroChartPlot(year);
  });
  andamento?.addEventListener("change", () => {
    macroChartState.andamento = andamento.checked;
    renderMacroChartPlot(year);
  });

  renderMacroChartPlot(year);
}

function renderMacroChartPlot(year){
  const chart = document.getElementById("chartMacro");
  if (!chart) return;
  if (!macroChartState.selectedIds.length){
    chart.innerHTML = `<div class="chart-empty">Seleziona almeno una macro categoria.</div>`;
    return;
  }

  const dati = computeMacroTrend(
    year,
    macroChartState.selectedIds,
    macroChartState.granularita,
    macroChartState.cumulativo,
    macroChartState.assoluto
  );

  const serie = macroChartState.selectedIds.map((id, i) => {
    const mc = macroById(id);
    return {
      nome: mc?.nome || id,
      colore: CHART_PALETTE[i % CHART_PALETTE.length],
      valori: dati.valori[id] || []
    };
  });

  // La spunta "Andamento" riassume SOLO le macro attualmente selezionate.
  // Le entrate restano positive. Le uscite mantengono il segno negativo
  // oppure diventano positive quando è attivo "Valore assoluto".
  // Il netto è quindi entrate + uscite nel primo caso e entrate - uscite
  // nel secondo, così rappresenta sempre la differenza economica reale.
  if (macroChartState.andamento){
    const andamento = computeOverallTrend(
      year,
      macroChartState.selectedIds,
      macroChartState.granularita,
      macroChartState.cumulativo,
      macroChartState.assoluto
    );
    serie.push(
      { nome:"Entrate selezionate", colore:"var(--green)", valori: andamento.entrate },
      { nome:"Uscite selezionate", colore:"var(--red)", valori: andamento.uscite },
      { nome:"Netto selezionato", colore:"rgba(255,255,255,0.9)", valori: andamento.netto }
    );
  }

  renderLineChart("chartMacro", serie, {
    labels: dati.labels,
    axisLabels: dati.axisLabels,
    segnato: !macroChartState.assoluto
  });
}


function computeOverallTrend(year, macroIds, granularita, cumulativo, assoluto){
  const periodi = buildMacroPeriods(year, granularita);
  let entrate = new Array(periodi.length).fill(0);
  let uscite = new Array(periodi.length).fill(0);

  state.movimenti.forEach(mv => {
    const d = new Date(mv.data + "T00:00:00");
    if (d.getFullYear() !== year) return;

    const cat = catById(mv.categoria);
    if (!cat || !macroIds.includes(cat.macroCategoria)) return;

    const idx = periodi.findIndex(p => d >= p.start && d <= p.end);
    if (idx < 0) return;

    if (mv.importo >= 0){
      entrate[idx] += mv.importo;
    } else {
      uscite[idx] += assoluto ? Math.abs(mv.importo) : mv.importo;
    }
  });

  if (cumulativo){
    let cumEntrate = 0, cumUscite = 0;
    entrate = entrate.map(v => (cumEntrate += v));
    uscite = uscite.map(v => (cumUscite += v));
  }

  const netto = entrate.map((v, i) => assoluto ? v - uscite[i] : v + uscite[i]);
  return { entrate, uscite, netto };
}

function computeMacroTrend(year, macroIds, granularita, cumulativo, assoluto){
  const movimenti = state.movimenti.filter(mv => {
    const d = new Date(mv.data + "T00:00:00");
    const cat = catById(mv.categoria);
    return d.getFullYear() === year && cat && macroIds.includes(cat.macroCategoria);
  });

  const periodi = buildMacroPeriods(year, granularita);
  const valori = Object.fromEntries(macroIds.map(id => [id, new Array(periodi.length).fill(0)]));

  movimenti.forEach(mv => {
    const cat = catById(mv.categoria);
    if (!cat || !valori[cat.macroCategoria]) return;
    const d = new Date(mv.data + "T00:00:00");
    const idx = periodi.findIndex(p => d >= p.start && d <= p.end);
    if (idx < 0) return;
    valori[cat.macroCategoria][idx] += assoluto ? Math.abs(mv.importo) : mv.importo;
  });

  if (cumulativo){
    macroIds.forEach(id => {
      let running = 0;
      valori[id] = valori[id].map(v => (running += v));
    });
  }

  return {
    labels: periodi.map(p => p.label),
    axisLabels: periodi.map(p => p.axisLabel),
    valori
  };
}

function buildMacroPeriods(year, granularita){
  const giorniNelMese = m => new Date(year, m + 1, 0).getDate();
  if (granularita === "mensile"){
    return MESI.map((mese, m) => ({
      start: new Date(year, m, 1),
      end: new Date(year, m, giorniNelMese(m), 23, 59, 59, 999),
      label: `${mese[0] + mese.slice(1).toLowerCase()} ${year}`,
      axisLabel: mese.slice(0,3)
    }));
  }

  if (granularita === "giornaliero"){
    const out = [];
    for (let d = new Date(year,0,1); d.getFullYear() === year; d.setDate(d.getDate()+1)){
      const x = new Date(d);
      out.push({
        start: new Date(x.getFullYear(), x.getMonth(), x.getDate()),
        end: new Date(x.getFullYear(), x.getMonth(), x.getDate(), 23,59,59,999),
        label: x.toLocaleDateString("it-IT"),
        axisLabel: x.getDate() === 1 ? MESI[x.getMonth()].slice(0,3) : ""
      });
    }
    return out;
  }

  // Settimane lunedì-domenica; la prima/ultima possono essere parziali
  // perché il grafico resta sempre confinato all'anno selezionato.
  const out = [];
  const annoStart = new Date(year,0,1);
  const annoEnd = new Date(year,11,31,23,59,59,999);
  const first = new Date(annoStart);
  const offset = (first.getDay() + 6) % 7; // lunedì=0
  first.setDate(first.getDate() - offset);
  let cursor = first;
  let idx = 0;
  while (cursor <= annoEnd){
    const rawStart = new Date(cursor);
    const rawEnd = new Date(cursor);
    rawEnd.setDate(rawEnd.getDate()+6);
    rawEnd.setHours(23,59,59,999);
    const start = rawStart < annoStart ? new Date(annoStart) : rawStart;
    const end = rawEnd > annoEnd ? new Date(annoEnd) : rawEnd;
    const fmt = d => d.toLocaleDateString("it-IT", {day:"2-digit", month:"short"}).replace(".","");
    out.push({
      start,
      end,
      label: `${fmt(start)} – ${fmt(end)}`,
      axisLabel: idx % 4 === 0 ? fmt(start) : ""
    });
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate()+7);
    idx++;
  }
  return out;
}

function renderLineChart(containerId, serie, opts = {}){
  const container = document.getElementById(containerId);
  if (!container || !serie.length) return;
  const n = Math.max(1, ...serie.map(s => s.valori.length));
  const labels = opts.labels || new Array(n).fill("");
  const axisLabels = opts.axisLabels || labels;
  const fmt = opts.segnato ? eurConSegno : eur;

  const W = 640, H = 260, padL = 60, padR = 12, padT = 10, padB = 26;
  const plotW = W-padL-padR, plotH = H-padT-padB;
  const all = serie.flatMap(s => s.valori).concat(0);
  const yMin = Math.min(...all), yMax = Math.max(...all);
  const yPad = (yMax-yMin)*0.08 || Math.abs(yMax)*0.1 || 1;
  const y0 = yMin-yPad, y1 = yMax+yPad;
  const xAt = i => n===1 ? padL+plotW/2 : padL + plotW*i/(n-1);
  const yAt = v => padT + plotH - ((v-y0)/(y1-y0))*plotH;

  let gridSvg = "";
  for (let g=0; g<=4; g++){
    const v = y0 + (y1-y0)*g/4;
    const y = yAt(v);
    gridSvg += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" stroke="var(--brass-dim)" stroke-width="1" opacity="0.25"/>`;
    gridSvg += `<text x="${padL-6}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--brass-dim)">${eurBreve(v)}</text>`;
  }
  if (y0 < 0 && y1 > 0){
    const yz = yAt(0);
    gridSvg += `<line x1="${padL}" x2="${W-padR}" y1="${yz}" y2="${yz}" stroke="var(--text-dim)" stroke-width="1" opacity="0.6"/>`;
  }

  let linesSvg = "";
  serie.forEach(s => {
    const punti = s.valori.map((v,i)=>`${xAt(i)},${yAt(v)}`).join(" L ");
    linesSvg += `<path d="M ${punti}" fill="none" stroke="${s.colore}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n <= 60){
      linesSvg += s.valori.map((v,i)=>`<circle cx="${xAt(i)}" cy="${yAt(v)}" r="2.5" fill="${s.colore}"/>`).join("");
    }
  });

  let axisSvg = "";
  axisLabels.forEach((label,i) => {
    if (!label) return;
    axisSvg += `<text x="${xAt(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--brass-dim)">${label}</text>`;
  });

  let hoverSvg = `<line id="${containerId}-crosshair" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" stroke="var(--text-dim)" stroke-width="1" opacity="0"/>`;
  for (let i=0;i<n;i++){
    const x0 = i===0 ? padL : (xAt(i-1)+xAt(i))/2;
    const x1 = i===n-1 ? W-padR : (xAt(i)+xAt(i+1))/2;
    hoverSvg += `<rect data-point="${i}" x="${x0}" y="${padT}" width="${x1-x0}" height="${plotH}" fill="transparent"/>`;
  }

  const legendHtml = serie.map(s =>
    `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${s.colore}"></span>${s.nome}</span>`
  ).join("");

  container.innerHTML = `
    <div class="chart-legend">${legendHtml}</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg">${gridSvg}${linesSvg}${axisSvg}${hoverSvg}</svg>
    <div class="chart-tooltip" id="${containerId}-tooltip"></div>`;

  const svg = container.querySelector("svg");
  const crosshair = document.getElementById(`${containerId}-crosshair`);
  const tooltip = document.getElementById(`${containerId}-tooltip`);
  svg.querySelectorAll("rect[data-point]").forEach(rect => {
    rect.addEventListener("mouseenter", () => {
      const i = Number(rect.dataset.point);
      const x = xAt(i);
      crosshair.setAttribute("x1",x); crosshair.setAttribute("x2",x); crosshair.setAttribute("opacity","1");
      const righe = serie.map(s => `<div><span class="chart-tooltip-dot" style="background:${s.colore}"></span>${s.nome}: <b>${fmt(s.valori[i]||0)}</b></div>`).join("");
      tooltip.innerHTML = `<div class="chart-tooltip-title">${labels[i]||""}</div>${righe}`;
      tooltip.style.display="block";
      const pct=(x/W)*100;
      tooltip.style.left=pct>60?"auto":`${pct}%`;
      tooltip.style.right=pct>60?`${100-pct}%`:"auto";
    });
    rect.addEventListener("mouseleave",()=>{
      crosshair.setAttribute("opacity","0"); tooltip.style.display="none";
    });
  });
}

// Disegna un grafico ad area in pila dentro il contenitore `containerId`.
// `serie` è un array di { nome, colore, valori:[12 numeri, uno per mese] }.
// Ogni area viene impilata su quella precedente: il bordo superiore
// dell'ultima serie rappresenta quindi il totale di tutte le serie insieme
// (a meno che alcuni valori siano negativi, nel qual caso la pila sale e
// scende attorno allo zero invece di sommarsi in un unico totale).
// `opts.linea`, se presente, è una serie aggiuntiva { nome, colore, valori }
// disegnata come linea sopra alle aree invece che impilata (usata per il
// "Netto" nel grafico entrate/uscite).
function renderStackedAreaChart(containerId, serie, opts = {}){
  // Nei tooltip del grafico entrate/uscite i valori positivi mostrano il
  // "+" esplicito (coerente col segno "-" che le uscite negative già
  // hanno): usiamo questo formato solo quando opts.segnato è true, per
  // non cambiare l'aspetto del grafico "Andamento conti" (saldi, dove un
  // "+" davanti a un importo positivo non avrebbe senso).
  const fmt = opts.segnato ? eurConSegno : eur;
  const container = document.getElementById(containerId);
  if (!container || !serie.length) return;
  const linea = opts.linea || null;

  const W = 640, H = 260, padL = 60, padR = 12, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = Math.max(1, ...serie.map(s => s.valori.length), linea ? linea.valori.length : 0);
  const labels = opts.labels || MESI.slice(0, n);
  const axisLabels = opts.axisLabels || labels.map(x => String(x).slice(0,3));

  // Base e cima di ogni fascia, mese per mese. Due modalità:
  // - normale (default, usata per "Andamento conti"): impilamento
  //   cumulativo classico, ogni serie parte da dove finisce la
  //   precedente, così la cima dell'ultima fascia è il totale di tutte.
  // - opts.divergente (usata per "Entrate e uscite"): ogni serie parte
  //   SEMPRE da zero, non da dove finisce la precedente; i valori
  //   positivi si impilano verso l'alto partendo da zero, i negativi
  //   verso il basso partendo da zero. Così le uscite (negative) non si
  //   agganciano più in cima alle entrate, ma scendono dalla linea 0.
  const top = serie.map(() => new Array(n).fill(0));
  const bottom = serie.map(() => new Array(n).fill(0));
  for (let m=0; m<n; m++){
    if (opts.divergente){
      let pos = 0, neg = 0;
      serie.forEach((s,i) => {
        const v = s.valori[m] || 0;
        if (v >= 0){ bottom[i][m] = pos; pos += v; top[i][m] = pos; }
        else { top[i][m] = neg; neg += v; bottom[i][m] = neg; }
      });
    } else {
      let acc = 0;
      serie.forEach((s,i) => {
        bottom[i][m] = acc;
        acc += (s.valori[m] || 0);
        top[i][m] = acc;
      });
    }
  }
  const tutteLeQuote = top.flat().concat(bottom.flat()).concat(0).concat(linea ? linea.valori : []);
  const yMin = Math.min(...tutteLeQuote), yMax = Math.max(...tutteLeQuote);
  const yPad = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.1 || 1;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const xAt = (m) => n === 1 ? padL + plotW / 2 : padL + (plotW * m) / (n - 1);
  const yAt = (v) => padT + plotH - ((v - y0) / (y1 - y0)) * plotH;

  // Linee guida orizzontali con l'importo a fianco (4 livelli)
  let gridSvg = "";
  for (let g=0; g<=4; g++){
    const v = y0 + ((y1 - y0) * g) / 4;
    const y = yAt(v);
    gridSvg += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" stroke="var(--brass-dim)" stroke-width="1" opacity="0.25"/>`;
    gridSvg += `<text x="${padL-6}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--brass-dim)">${eurBreve(v)}</text>`;
  }
  // Se l'intervallo attraversa lo zero (es. un conto in rosso), una riga
  // più marcata segna lo zero: altrimenti sarebbe difficile individuarlo.
  if (y0 < 0 && y1 > 0){
    const yz = yAt(0);
    gridSvg += `<line x1="${padL}" x2="${W-padR}" y1="${yz}" y2="${yz}" stroke="var(--text-dim)" stroke-width="1" opacity="0.6"/>`;
  }

  // Un'area per serie, impilata su quella precedente. Lo stroke color
  // uguale allo sfondo della card separa visivamente le fasce (coerente
  // con la pausa di 2px che si usa tra segmenti impilati).
  let areasSvg = "";
  serie.forEach((s,i) => {
    const puntiSopra = top[i].map((v,m)=>`${xAt(m)},${yAt(v)}`).join(" L ");
    const puntiSotto = bottom[i].map((v,m)=>`${xAt(m)},${yAt(v)}`).reverse().join(" L ");
    areasSvg += `<path d="M ${puntiSopra} L ${puntiSotto} Z" fill="${s.colore}" fill-opacity="0.78" stroke="var(--ink-2)" stroke-width="2"/>`;
  });

  // Linea del netto (se richiesta): non impilata, segue direttamente il
  // suo valore mese per mese, così resta leggibile anche quando le aree
  // sopra e sotto lo zero cambiano forma. Bianca e leggermente
  // trasparente per distinguersi dai colori delle aree sottostanti, con
  // un pallino su ogni mese per renderla precisa anche senza passare il
  // mouse.
  let lineaSvg = "";
  if (linea){
    const punti = linea.valori.map((v,m)=>`${xAt(m)},${yAt(v)}`).join(" L ");
    lineaSvg = `<path d="M ${punti}" fill="none" stroke="${linea.colore}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (opts.mostraPuntiLinea !== false){
      lineaSvg += linea.valori.map((v,m)=>`<circle cx="${xAt(m)}" cy="${yAt(v)}" r="3" fill="${linea.colore}"/>`).join("");
    }
  }

  // Etichette dei mesi sull'asse orizzontale (abbreviate per non affollare)
  let axisSvg = "";
  axisLabels.forEach((label,i) => {
    if (!label) return;
    axisSvg += `<text x="${xAt(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--brass-dim)">${label}</text>`;
  });

  // Crosshair verticale (nascosto finché non si passa il mouse) + una
  // colonna invisibile per mese, per intercettare l'hover mese per mese.
  let hoverSvg = `<line id="${containerId}-crosshair" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" stroke="var(--text-dim)" stroke-width="1" opacity="0"/>`;
  for (let m=0; m<n; m++){
    const x0 = m===0 ? padL : (xAt(m-1)+xAt(m))/2;
    const x1 = m===n-1 ? W-padR : (xAt(m)+xAt(m+1))/2;
    hoverSvg += `<rect data-month="${m}" x="${x0}" y="${padT}" width="${x1-x0}" height="${plotH}" fill="transparent"/>`;
  }

  // Legenda: sempre presente quando ci sono 2 o più voci da distinguere
  // (serie impilate + eventuale linea del netto). Con una sola serie e
  // nessuna linea il titolo della card già identifica il grafico.
  const legendEntries = linea ? [...serie, linea] : serie;
  const legendHtml = legendEntries.length > 1 ? legendEntries.map(s =>
    `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${s.colore}"></span>${s.nome}</span>`
  ).join("") : "";

  container.innerHTML = `
    ${legendHtml ? `<div class="chart-legend">${legendHtml}</div>` : ""}
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg">${gridSvg}${areasSvg}${lineaSvg}${axisSvg}${hoverSvg}</svg>
    <div class="chart-tooltip" id="${containerId}-tooltip"></div>
  `;

  // Interattività: passando il mouse su un mese si vede il crosshair e un
  // riepilogo dei valori di quel mese per ogni serie (più il totale, se le
  // serie sono più di una).
  const svg = container.querySelector("svg");
  const crosshair = document.getElementById(`${containerId}-crosshair`);
  const tooltip = document.getElementById(`${containerId}-tooltip`);
  svg.querySelectorAll("rect[data-month]").forEach(rect => {
    rect.addEventListener("mouseenter", () => {
      const m = Number(rect.dataset.month);
      const x = xAt(m);
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("opacity", "1");
      const righe = serie.map(s =>
        `<div><span class="chart-tooltip-dot" style="background:${s.colore}"></span>${s.nome}: <b>${fmt(s.valori[m]||0)}</b></div>`
      ).join("");
      // Quando c'è una linea (il "Netto"), è quella a chiudere il tooltip
      // invece del generico "Totale" impilato: coi valori negativi delle
      // uscite i due coinciderebbero comunque, ma il nome "Netto" rende
      // subito chiaro cosa rappresenta il numero.
      const extraHtml = linea
        ? `<div style="margin-top:4px;border-top:1px solid var(--brass-dim);padding-top:4px;"><span class="chart-tooltip-dot" style="background:${linea.colore}"></span>${linea.nome}: <b>${fmt(linea.valori[m]||0)}</b></div>`
        : (serie.length > 1
          ? `<div style="margin-top:4px;border-top:1px solid var(--brass-dim);padding-top:4px;">Totale: <b>${eur(top[top.length-1][m])}</b></div>`
          : "");
      tooltip.innerHTML = `<div class="chart-tooltip-title">${labels[m] || ""}</div>${righe}${extraHtml}`;
      tooltip.style.display = "block";
      const pct = (x / W) * 100;
      tooltip.style.left = pct > 60 ? "auto" : `${pct}%`;
      tooltip.style.right = pct > 60 ? `${100 - pct}%` : "auto";
    });
    rect.addEventListener("mouseleave", () => {
      crosshair.setAttribute("opacity", "0");
      tooltip.style.display = "none";
    });
  });
}
// Versione abbreviata di eur(), senza decimali, usata solo per le etichette
// sull'asse dei grafici (eur() per intero è troppo lunga per starci a fianco).
function eurBreve(n){
  return Math.round(n||0).toLocaleString("it-IT", { style:"currency", currency: state?.valuta || "EUR", maximumFractionDigits:0 });
}
// Come eur(), ma con il segno "+" davanti ai valori positivi (il segno "-"
// davanti ai negativi lo mette già eur() di suo). Usata nei tooltip dei
// grafici dove il segno fa parte dell'informazione, es. entrate/uscite/netto.
function eurConSegno(n){
  return (n||0).toLocaleString("it-IT", { style:"currency", currency: state?.valuta || "EUR", signDisplay:"exceptZero" });
}

/* ============================================================================
   8. RENDER: MOVIMENTI
   renderMovForm(editId) mostra il form di aggiunta/modifica (se editId è
   valorizzato, precompila i campi con il movimento da modificare).
   renderMovTable() disegna l'elenco con i pulsanti Modifica/Elimina.
   ============================================================================ */
function renderMovForm(editId){
  const form = document.getElementById("movForm");
  const editing = editId ? state.movimenti.find(m=>m.id===editId) : null;
  form.style.display = "grid";
  form.innerHTML = `
    <div><label>Data</label><input type="date" name="data" required value="${editing?editing.data:new Date().toISOString().slice(0,10)}"></div>
    <div><label>Conto</label><select name="conto">${state.conti.map(c=>`<option value="${c.id}" ${editing?.conto===c.id?"selected":""}>${c.nome}</option>`).join("")}</select></div>
    <div>
      <label>Categoria</label>
      <select name="categoria">
        ${
          [...state.categorie]
            .sort((a, b) => {
              const macroA = macroById(a.macroCategoria)?.nome || "";
              const macroB = macroById(b.macroCategoria)?.nome || "";

              const confrontoMacro = macroA.localeCompare(macroB, "it");
              if (confrontoMacro !== 0) return confrontoMacro;

              return a.nome.localeCompare(b.nome, "it");
            })
            .map(c => `
              <option value="${c.id}" ${editing?.categoria===c.id ? "selected" : ""}>
                ${macroById(c.macroCategoria)?.nome || ""} — ${c.nome}
              </option>
            `)
            .join("")
        }
      </select>
    </div>
    <div><label>Importo (+ entrata / - uscita)</label><input type="number" step="0.01" name="importo" required value="${editing?editing.importo:""}"></div>
    <div class="full"><label>Descrizione</label><input type="text" name="descrizione" value="${editing?editing.descrizione:""}"></div>
    <div class="full" style="display:flex;gap:8px;">
      <button class="btn small" type="submit">${editing?"Salva modifica":"Aggiungi movimento"}</button>
      <button class="btn secondary small" type="button" id="cancelMov">Annulla</button>
    </div>
  `;
  document.getElementById("cancelMov").onclick = () => { form.style.display="none"; };
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const importo = parseFloat(fd.get("importo"));
    const data = fd.get("data");
    if (editing){
      Object.assign(editing, { data, conto: fd.get("conto"), categoria: fd.get("categoria"), importo, descrizione: fd.get("descrizione") });
    } else {
      const year = new Date(data).getFullYear();
      state.movimenti.push({
        id: nextId("m", state.movimenti, year),
        data, conto: fd.get("conto"), categoria: fd.get("categoria"), importo, descrizione: fd.get("descrizione")
      });
    }
    form.style.display = "none";
    renderAll(); persist();
  };
}
document.getElementById("newMovBtn").onclick = () => renderMovForm(null);

const movFilters = {
  conto: "",
  macro: "",
  categoria: "",
  tipo: ""
};
const collapsedMovMonths = new Set();

// function renderMovTable(){
//   const rows = [...state.movimenti].sort((a,b)=> b.data.localeCompare(a.data));
//   let html = `<thead><tr><th>Data</th><th>Conto</th><th>Macro categoria</th><th>Categoria</th><th>Descrizione</th><th style="text-align:right;">Importo</th><th></th></tr></thead><tbody>`;
//   let meseCorrente = null;
//   rows.forEach(m => {
//     const [anno, mese] = m.data.split("-");
//     const chiaveMese = `${anno}-${mese}`;
//     if (chiaveMese !== meseCorrente){
//       meseCorrente = chiaveMese;
//       const nomeMese = MESI[Number(mese) - 1];
//       html += `<tr class="mov-month-header"><td colspan="7"><span>${nomeMese} ${anno}</span></td></tr>`;
//     }
//     const cat = catById(m.categoria);
//     const macro = cat ? macroById(cat.macroCategoria) : null;
//     html += `<tr>
//       <td>${formatDataIt(m.data)}</td>
//       <td>${contoById(m.conto)?.nome||m.conto}</td>
//       <td>${macro?macro.nome:""}</td>
//       <td>${cat?cat.nome:m.categoria}</td>
//       <td>${m.descrizione||""}</td>
//       <td class="amount"
//           style="text-align:right;color:${m.importo>=0?'var(--green)':'var(--red)'}">
//         ${eur(m.importo)}
//       </td>
//       <td class="row-actions">
//         <button class="btn secondary small" data-edit="${m.id}">Modifica</button>
//         <button class="btn danger small" data-del="${m.id}">Elimina</button>
//       </td>
//     </tr>`;
//   });

//   html += `</tbody>`;
//   const table = document.getElementById("movTable");
//   table.innerHTML = html;
//   table.querySelectorAll("[data-edit]").forEach(
//     b => b.onclick = () => renderMovForm(b.dataset.edit)
//   );
//   table.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
//     if (!confirm("Eliminare questo movimento?")) return;
//     state.movimenti = state.movimenti.filter(
//       m => m.id !== b.dataset.del
//     );
//     renderAll();persist();
//   });
// }

function renderMovTable(){

  // -------------------------------------------------------------------
  // FILTRI
  // -------------------------------------------------------------------

  let filterBox = document.getElementById("movFilters");

  // Se non esiste ancora, lo creiamo automaticamente sopra la tabella.
  if (!filterBox){
    const table = document.getElementById("movTable");

    filterBox = document.createElement("div");
    filterBox.id = "movFilters";
    filterBox.className = "mov-filters";

    table.parentNode.insertBefore(filterBox, table);
  }

  // Le categorie visibili nel filtro categoria dipendono
  // dalla macro categoria eventualmente selezionata.
  const categorieFiltro = [...state.categorie]
    .filter(c => !movFilters.macro || c.macroCategoria === movFilters.macro)
    .sort((a,b) => a.nome.localeCompare(b.nome, "it"));

  // Se cambio macro e la categoria selezionata non appartiene più
  // alla nuova macro, azzero il filtro categoria.
  if (
    movFilters.categoria &&
    !categorieFiltro.some(c => c.id === movFilters.categoria)
  ){
    movFilters.categoria = "";
  }

  filterBox.innerHTML = `
    <div class="mov-filter">
      <label>Conto</label>
      <select data-mov-filter="conto" class="btn secondary small">
        <option value="">Tutti i conti</option>
        ${state.conti
          .map(c => `
            <option
              value="${c.id}"
              ${movFilters.conto === c.id ? "selected" : ""}
            >
              ${c.nome}
            </option>
          `)
          .join("")}
      </select>
    </div>

    <div class="mov-filter">
      <label>Macro categoria</label>
      <select data-mov-filter="macro" class="btn secondary small">
        <option value="">Tutte le macro</option>
        ${[...state.macroCategorie]
          .sort((a,b) => a.nome.localeCompare(b.nome, "it"))
          .map(m => `
            <option
              value="${m.id}"
              ${movFilters.macro === m.id ? "selected" : ""}
            >
              ${m.nome}
            </option>
          `)
          .join("")}
      </select>
    </div>

    <div class="mov-filter">
      <label>Categoria</label>
      <select data-mov-filter="categoria" class="btn secondary small">
        <option value="">Tutte le categorie</option>
        ${categorieFiltro
          .map(c => `
            <option
              value="${c.id}"
              ${movFilters.categoria === c.id ? "selected" : ""}
            >
              ${c.nome}
            </option>
          `)
          .join("")}
      </select>
    </div>

    <div class="mov-filter">
      <label>Tipo</label>
      <select data-mov-filter="tipo" class="btn secondary small">
        <option value="">Entrate e uscite</option>
        <option
          value="entrata"
          ${movFilters.tipo === "entrata" ? "selected" : ""}
        >
          Entrate
        </option>
        <option
          value="uscita"
          ${movFilters.tipo === "uscita" ? "selected" : ""}
        >
          Uscite
        </option>
      </select>
    </div>

    <div class="mov-filter-reset">
      <button
        type="button"
        class="btn secondary small"
        id="resetMovFilters"
      >
        Azzera filtri
      </button>
    </div>
  `;

  // Cambio di uno dei filtri.
  filterBox.querySelectorAll("[data-mov-filter]").forEach(select => {
    select.onchange = () => {
      movFilters[select.dataset.movFilter] = select.value;

      // La macro influenza il contenuto del filtro categoria,
      // quindi ridisegniamo tutto.
      renderMovTable();
    };
  });

  document.getElementById("resetMovFilters").onclick = () => {
    movFilters.conto = "";
    movFilters.macro = "";
    movFilters.categoria = "";
    movFilters.tipo = "";

    renderMovTable();
  };


  // -------------------------------------------------------------------
  // APPLICAZIONE DEI FILTRI
  // -------------------------------------------------------------------

  const rows = [...state.movimenti]
    .filter(m => {

      const cat = catById(m.categoria);

      if (
        movFilters.conto &&
        m.conto !== movFilters.conto
      ){
        return false;
      }

      if (
        movFilters.macro &&
        cat?.macroCategoria !== movFilters.macro
      ){
        return false;
      }

      if (
        movFilters.categoria &&
        m.categoria !== movFilters.categoria
      ){
        return false;
      }

      if (
        movFilters.tipo === "entrata" &&
        m.importo < 0
      ){
        return false;
      }

      if (
        movFilters.tipo === "uscita" &&
        m.importo >= 0
      ){
        return false;
      }

      return true;
    })
    .sort((a,b) => b.data.localeCompare(a.data));


  // -------------------------------------------------------------------
  // TABELLA
  // -------------------------------------------------------------------

  let html = `
    <thead>
      <tr>
        <th>Data</th>
        <th>Conto</th>
        <th>Macro categoria</th>
        <th>Categoria</th>
        <th>Descrizione</th>
        <th style="text-align:right;">Importo</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
  `;

  if (!rows.length){
    html += `
      <tr>
        <td colspan="7" class="mov-empty">
          Nessun movimento corrisponde ai filtri selezionati.
        </td>
      </tr>
    `;
  }

  let meseCorrente = null;

  rows.forEach(m => {

    const [anno, mese] = m.data.split("-");
    const chiaveMese = `${anno}-${mese}`;

    // ---------------------------------------------------------------
    // INTESTAZIONE MESE
    // ---------------------------------------------------------------

    if (chiaveMese !== meseCorrente){

      meseCorrente = chiaveMese;

      const nomeMese = MESI[Number(mese) - 1];
      const collapsed = collapsedMovMonths.has(chiaveMese);

      html += `
        <tr class="mov-month-header">
          <td colspan="7">

          <button
            type="button"
            class="mov-month-toggle"
            data-month-toggle="${chiaveMese}"
            aria-expanded="${!collapsed}"
          >
            ${nomeMese} ${anno}
          </button>

          </td>
        </tr>
      `;
    }

    // Se il mese è chiuso, non generiamo proprio la riga.
    if (collapsedMovMonths.has(chiaveMese)){
      return;
    }

    const cat = catById(m.categoria);
    const macro = cat ? macroById(cat.macroCategoria) : null;

    html += `
      <tr class="mov-row">
        <td>${formatDataIt(m.data)}</td>

        <td>
          ${contoById(m.conto)?.nome || m.conto}
        </td>

        <td>
          ${macro ? macro.nome : ""}
        </td>

        <td>
          ${cat ? cat.nome : m.categoria}
        </td>

        <td>
          ${m.descrizione || ""}
        </td>

        <td
          class="amount"
          style="
            text-align:right;
            color:${m.importo >= 0 ? "var(--green)" : "var(--red)"}
          "
        >
          ${eur(m.importo)}
        </td>

        <td class="row-actions">

          <button
            class="btn secondary small"
            data-edit="${m.id}"
          >
            Modifica
          </button>

          <button
            class="btn danger small"
            data-del="${m.id}"
          >
            Elimina
          </button>

        </td>
      </tr>
    `;
  });

  html += `</tbody>`;

  const table = document.getElementById("movTable");
  table.innerHTML = html;


  // -------------------------------------------------------------------
  // CLICK SUL MESE
  // -------------------------------------------------------------------

  table.querySelectorAll("[data-month-toggle]").forEach(btn => {

    btn.onclick = () => {

      const month = btn.dataset.monthToggle;

      if (collapsedMovMonths.has(month)){
        collapsedMovMonths.delete(month);
      } else {
        collapsedMovMonths.add(month);
      }

      renderMovTable();
    };

  });


  // -------------------------------------------------------------------
  // MODIFICA / ELIMINA
  // -------------------------------------------------------------------

  table.querySelectorAll("[data-edit]").forEach(b => {
    b.onclick = () => renderMovForm(b.dataset.edit);
  });

  table.querySelectorAll("[data-del]").forEach(b => {

    b.onclick = () => {

      if (!confirm("Eliminare questo movimento?")){
        return;
      }

      state.movimenti = state.movimenti.filter(
        m => m.id !== b.dataset.del
      );

      renderAll();
      persist();
    };

  });
}

/* ============================================================================
   9. RENDER: TRASFERIMENTI (stessa logica dei movimenti, ma tra due conti)
   ============================================================================ */
function renderTraForm(editId){
  const form = document.getElementById("traForm");
  const editing = editId ? state.trasferimenti.find(t=>t.id===editId) : null;
  form.style.display = "grid";
  form.innerHTML = `
    <div><label>Data</label><input type="date" name="data" required value="${editing?editing.data:new Date().toISOString().slice(0,10)}"></div>
    <div><label>Da conto</label><select name="da">${state.conti.map(c=>`<option value="${c.id}" ${editing?.da===c.id?"selected":""}>${c.nome}</option>`).join("")}</select></div>
    <div><label>A conto</label><select name="a">${state.conti.map(c=>`<option value="${c.id}" ${editing?.a===c.id?"selected":""}>${c.nome}</option>`).join("")}</select></div>
    <div><label>Importo</label><input type="number" step="0.01" name="importo" required value="${editing?editing.importo:""}"></div>
    <div class="full" style="display:flex;gap:8px;">
      <button class="btn small" type="submit">${editing?"Salva modifica":"Aggiungi trasferimento"}</button>
      <button class="btn secondary small" type="button" id="cancelTra">Annulla</button>
    </div>
  `;
  document.getElementById("cancelTra").onclick = () => { form.style.display="none"; };
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const importo = parseFloat(fd.get("importo"));
    const data = fd.get("data");
    if (fd.get("da")===fd.get("a")){ alert("Il conto di partenza e di arrivo devono essere diversi."); return; }
    if (editing){
      Object.assign(editing, { data, da: fd.get("da"), a: fd.get("a"), importo });
    } else {
      const year = new Date(data).getFullYear();
      state.trasferimenti.push({ id: nextId("t", state.trasferimenti, year), data, da: fd.get("da"), a: fd.get("a"), importo });
    }
    form.style.display = "none";
    renderAll(); persist();
  };
}
document.getElementById("newTraBtn").onclick = () => renderTraForm(null);

function renderTraTable(){
  const rows = [...state.trasferimenti].sort((a,b)=> b.data.localeCompare(a.data));
  let html = `<thead><tr><th>Data</th><th>Da</th><th>A</th><th style="text-align:right;">Importo</th><th></th></tr></thead><tbody>`;
  rows.forEach(t => {
    html += `<tr>
      <td>${t.data}</td>
      <td>${contoById(t.da)?.nome||t.da}</td>
      <td>${contoById(t.a)?.nome||t.a}</td>
      <td class="amount" style="text-align:right;">${eur(t.importo)}</td>
      <td class="row-actions">
        <button class="btn secondary small" data-edit="${t.id}">Modifica</button>
        <button class="btn danger small" data-del="${t.id}">Elimina</button>
      </td>
    </tr>`;
  });
  html += `</tbody>`;
  const table = document.getElementById("traTable");
  table.innerHTML = html;
  table.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => renderTraForm(b.dataset.edit));
  table.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    if (!confirm("Eliminare questo trasferimento?")) return;
    state.trasferimenti = state.trasferimenti.filter(t=>t.id!==b.dataset.del);
    renderAll(); persist();
  });
}

/* ============================================================================
   10. RENDER: IMPOSTAZIONI
   Gestisce: conti, saldi iniziali per anno, e l'albero macro categorie
   -> categorie. Gli id (conto.id, macroCategoria.id, categoria.id) NON si
   scrivono mai a mano: vengono generati automaticamente dal nome con
   uniqueId() (vedi sezione 5 UTIL), così non si rischiano id duplicati o
   con caratteri strani.
   ============================================================================ */
function renderImpostazioni(){
  // --- Conti -----------------------------------------------------------
  // Si inserisce solo il nome (es. "Banca Sella"): l'id ("bancasella") è
  // calcolato automaticamente e mostrato accanto al nome solo come info.
  const contiList = document.getElementById("contiList");
  contiList.innerHTML = state.conti.map(c => `<li>${c.nome}
    <button class="btn danger small" data-del-conto="${c.id}">×</button></li>`).join("");
  contiList.querySelectorAll("[data-del-conto]").forEach(b=>b.onclick=()=>{
    if (!confirm("Rimuovere questo conto? I movimenti collegati resteranno con id orfano.")) return;
    state.conti = state.conti.filter(c=>c.id!==b.dataset.delConto);
    renderAll(); persist();
  });
  document.getElementById("contoForm").onsubmit = (e) => {
    e.preventDefault();
    const nome = document.getElementById("contoNome").value.trim();
    if (!nome) return;
    const id = uniqueId(nome, state.conti);
    state.conti.push({ id, nome });
    document.getElementById("contoNome").value="";
    renderAll(); persist();
  };

  // saldi iniziali
  // Ogni riga ha, in fondo, una "×" per eliminare l'intero anno.
  const years = yearsAvailable();
  let sHtml = `<table class="data"><thead><tr><th>Anno</th>${state.conti.map(c=>`<th>${c.nome}</th>`).join("")}<th></th></tr></thead><tbody>`;
  years.forEach(y => {
    sHtml += `<tr><td>${y}</td>` + state.conti.map(c => {
      const v = state.saldiIniziali[y]?.[c.id] ?? 0;
      return `<td><input type="number" step="0.01" value="${v}" data-year="${y}" data-conto="${c.id}" style="width:100px; padding:10px;"></td>`;
    }).join("") + `<td><button class="btn danger small" data-del-year="${y}" title="Rimuovi anno">×</button></td></tr>`;
  });
  sHtml += `</tbody></table><button class="btn small" id="addYearBtn" style="margin-top:10px;">+ Nuovo anno</button>`;
  const container = document.getElementById("saldiIniziali");
  container.innerHTML = sHtml;
  container.querySelectorAll("input[data-year]").forEach(inp => {
    inp.onchange = () => {
      const y = inp.dataset.year, c = inp.dataset.conto;
      state.saldiIniziali[y] = state.saldiIniziali[y] || {};
      state.saldiIniziali[y][c] = parseFloat(inp.value)||0;
      // renderAll() ridisegna anche la tabella Bilancio, che dipende
      // proprio dai saldi iniziali: senza questa chiamata la modifica
      // veniva salvata ma non si vedeva finché non si cambiava tab.
      renderAll(); persist();
    };
  });
  container.querySelectorAll("[data-del-year]").forEach(b => b.onclick = () => {
    const y = b.dataset.delYear;
    if (!confirm(`Eliminare i saldi iniziali dell'anno ${y}?`)) return;
    delete state.saldiIniziali[y];
    renderAll(); persist();
  });
  document.getElementById("addYearBtn").onclick = () => {
    const y = prompt("Anno da aggiungere:", String(new Date().getFullYear()+1));
    if (!y) return;
    state.saldiIniziali[y] = state.saldiIniziali[y] || {};
    renderAll(); persist();
  };

  renderCategorieTree();
}

/* ----------------------------------------------------------------------
   Albero Macro categorie -> Categorie.
   Per ogni macro categoria mostra le sue categorie figlie con un piccolo
   campo "+ aggiungi categoria" in fondo, e in fondo a tutto un campo
   "+ aggiungi macro categoria". Si scrive solo il nome: l'id viene
   sempre generato con uniqueId() (vedi sezione 5 UTIL).
   ---------------------------------------------------------------------- */
function renderCategorieTree(){
  const root = document.getElementById("categorieTree");

  let html = `<h3>Categorie</h3><div class="cat-tree">`;
  state.macroCategorie.forEach(macro => {
    const figlie = state.categorie.filter(c => c.macroCategoria === macro.id);
    html += `
      <div class="macro-block">
        <div class="macro-header">
          <span>${macro.nome}</span>
          <button class="btn danger small" data-del-macro="${macro.id}" title="Rimuovi macro categoria">×</button>
        </div>
        <ul class="cat-sub-list">
          ${figlie.map(c => `
            <li>
              <span>${c.nome}</span>
              <button class="btn danger small" data-del-cat="${c.id}" title="Rimuovi categoria">×</button>
            </li>`).join("")}
          <li class="add-row">
            <input type="text" placeholder="nuova categoria..." data-add-cat="${macro.id}">
            <button class="btn small" data-add-cat-btn="${macro.id}">+</button>
          </li>
        </ul>
      </div>`;
  });
  html += `
      <div class="add-row add-macro-row">
        <input type="text" placeholder="nuova macro categoria..." id="newMacroInput">
        <button class="btn small" id="newMacroBtn">Add Macro</button>
      </div>
    </div>`;
  root.innerHTML = html;

  // Elimina una macro categoria (e, di conseguenza, tutte le sue categorie figlie)
  root.querySelectorAll("[data-del-macro]").forEach(b => b.onclick = () => {
    const macroId = b.dataset.delMacro;
    const nFiglie = state.categorie.filter(c => c.macroCategoria === macroId).length;
    const msg = nFiglie > 0
      ? `Questa macro categoria contiene ${nFiglie} categorie: verranno eliminate anche loro. Continuare?`
      : "Rimuovere questa macro categoria?";
    if (!confirm(msg)) return;
    state.categorie = state.categorie.filter(c => c.macroCategoria !== macroId);
    state.macroCategorie = state.macroCategorie.filter(m => m.id !== macroId);
    renderAll(); persist();
  });

  // Elimina una singola categoria
  root.querySelectorAll("[data-del-cat]").forEach(b => b.onclick = () => {
    if (!confirm("Rimuovere questa categoria?")) return;
    state.categorie = state.categorie.filter(c => c.id !== b.dataset.delCat);
    renderAll(); persist();
  });

  // Aggiungi una categoria dentro una macro categoria specifica
  root.querySelectorAll("[data-add-cat-btn]").forEach(btn => {
    const macroId = btn.dataset.addCatBtn;
    const input = root.querySelector(`input[data-add-cat="${macroId}"]`);
    const submit = () => {
      const nome = input.value.trim();
      if (!nome) return;
      const id = uniqueId(nome, state.categorie);
      state.categorie.push({ id, nome, macroCategoria: macroId });
      renderAll(); persist();
    };
    btn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter"){ e.preventDefault(); submit(); } };
  });

  // Aggiungi una nuova macro categoria (in fondo all'albero)
  const newMacroInput = document.getElementById("newMacroInput");
  const submitMacro = () => {
    const nome = newMacroInput.value.trim();
    if (!nome) return;
    const id = uniqueId(nome, state.macroCategorie);
    state.macroCategorie.push({ id, nome });
    renderAll(); persist();
  };
  document.getElementById("newMacroBtn").onclick = submitMacro;
  newMacroInput.onkeydown = (e) => { if (e.key === "Enter"){ e.preventDefault(); submitMacro(); } };
}

/* ============================================================================
   11. EXPORT / IMPORT — backup manuale in locale (oltre a Drive)
   Utile per avere una copia di sicurezza sul tuo computer, o per
   trasferire i dati manualmente se serve.
   ============================================================================ */
document.getElementById("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = FILE_NAME; a.click();
};
document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      if (!confirm("Sovrascrivere i dati attuali con questo file?")) return;
      state = parsed;
      renderAll(); persist();
    } catch(err){ alert("File JSON non valido."); }
  };
  reader.readAsText(file);
};

/* ============================================================================
   12. TAB — cambio scheda (Bilancio / Movimenti / Trasferimenti / Impostazioni)
   ============================================================================ */
document.querySelectorAll("nav.tabs button").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
    document.getElementById("panel-"+btn.dataset.tab).classList.add("active");
  };
});

/* ============================================================================
   13. MASTER RENDER — richiamata dopo OGNI modifica ai dati
   Ridisegna tutte le viste così restano sempre sincronizzate con `state`.
   ============================================================================ */
function renderAll(){
  renderYearSelect();
  renderBilancio(Number(document.getElementById("yearSelect").value));
  renderMovTable();
  renderTraTable();
  renderImpostazioni();
}
