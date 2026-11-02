"use strict";
/* Cran mobile.
   Les données vivent sur le téléphone (stockage du navigateur).
   La synchronisation passe par un seul fichier de ton Google Drive : Cran-synchro/cran-sync.json.
   Droit demandé à Google : « drive.file » = uniquement les fichiers créés par cette appli, rien d'autre de ton Drive. */

const ORDER = ["projets", "fournisseurs", "jalons", "documents", "taches"];
const PRIO = { 3: "Bloquant", 2: "Important", 1: "Normal" };
const REG = { bloc: 25, pause: 5 };
const KEY = "cranm.v1";
const API = "https://www.googleapis.com/drive/v3/files", UP = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

/* ---------- utilitaires ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = () => { const d = new Date(); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const daysTo = (s) => Math.round((parseDay(s) - parseDay(ymd())) / 864e5);
const fr = (s) => (s ? parseDay(s).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "");
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const steps = (t) => { try { return JSON.parse(t.etapes || "[]"); } catch { return []; } };
let tt;
function toast(m) { const el = $("#toast"); el.textContent = m; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("show"), 2600); }

/* ---------- données locales ---------- */
const vide = () => ({ items: Object.fromEntries(ORDER.map((t) => [t, []])), supprimes: {}, drive: {}, clientId: "", projet: "" });
let DB = (() => { try { const d = JSON.parse(localStorage.getItem(KEY) || "null"); if (d && d.items) return { ...vide(), ...d }; } catch {} return vide(); })();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch { toast("Stockage du téléphone indisponible"); } }
function save() { persist(); planSync(); }
const L = (t) => DB.items[t] || (DB.items[t] = []);
const get = (t, u) => (u ? L(t).find((x) => x.uid === u) : undefined);
function upsert(t, it) {
  it.uid = it.uid || newId(); it.maj = Date.now();
  const i = L(t).findIndex((x) => x.uid === it.uid);
  if (i >= 0) L(t)[i] = it; else L(t).push(it);
  save(); return it;
}
function supprimer(t, u) {
  const out = new Set([u]);
  if (t === "projets") { L("fournisseurs").filter((f) => f.projet === u).forEach((f) => out.add(f.uid)); L("taches").filter((x) => x.projet === u).forEach((x) => out.add(x.uid)); }
  L("jalons").filter((j) => out.has(j.fournisseur)).forEach((j) => out.add(j.uid));
  L("taches").filter((x) => out.has(x.fournisseur) || out.has(x.jalon)).forEach((x) => out.add(x.uid));
  L("documents").filter((d) => out.has(d.jalon)).forEach((d) => out.add(d.uid));
  for (const k of ORDER) DB.items[k] = L(k).filter((x) => !out.has(x.uid));
  const m = Date.now(); out.forEach((x) => { DB.supprimes[x] = m; });
  save();
}

/* ---------- logique Cran ---------- */
const fourOf = (t) => get("fournisseurs", t.fournisseur) || get("fournisseurs", get("jalons", t.jalon)?.fournisseur);
const projOf = (t) => fourOf(t)?.projet || t.projet || null;
const projets = () => L("projets").filter((p) => !p.archive).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
const projetCible = () => (get("projets", DB.projet) ? DB.projet : projets()[0]?.uid || null);
const where = (t) => { const f = fourOf(t), j = get("jalons", t.jalon); return f ? `${f.nom}${j ? " · " + j.nom : ""}` : get("projets", projOf(t))?.nom || ""; };
function score(t) {
  let s = (t.priorite || 2) * 10; const why = [];
  const j = get("jalons", t.jalon);
  if (t.priorite === 3) why.push("<b>bloquant</b>");
  if (t.echeance) {
    const d = daysTo(t.echeance);
    if (d < 0) { s += 50; why.push(`<b>à rendre depuis ${-d} j</b>`); }
    else if (d <= 7) { s += 35 - 3 * d; why.push(d === 0 ? "<b>à rendre aujourd'hui</b>" : `à rendre dans <b>${d} j</b>`); }
    else if (d <= 21) { s += 8; why.push(`à rendre le ${fr(t.echeance)}`); }
  }
  if (j && j.date_prevue && !j.date_reelle) {
    const d = daysTo(j.date_prevue);
    if (d < 0) { s += 45; why.push(`<b>${esc(j.nom)}</b> en retard de ${-d} j`); }
    else if (d <= 21) { s += 30 - d; why.push(`<b>${esc(j.nom)}</b> dans ${d} j`); }
  }
  if (t.reprise) { s += 6; why.push("déjà entamée"); }
  const h = new Date().getHours();
  if (t.lourde && h < 12) { s += 8; why.push("tâche lourde, et c'est le matin"); }
  if (!t.lourde && h >= 14) s += 4;
  if (!why.length) why.push("rien de plus urgent pour l'instant");
  return { t, s, why: why.slice(0, 2).join(" · ") };
}
const ranked = (p) => L("taches").filter((t) => t.statut !== "fait" && (!p || projOf(t) === p)).map(score).sort((a, b) => b.s - a.s);
const doneToday = (p) => L("taches").filter((t) => t.statut === "fait" && (t.fait_le || "").startsWith(ymd()) && (!p || projOf(t) === p));

/* ---------- affichage ---------- */
let VUE = "jour";
function render() {
  if (DB.projet && !get("projets", DB.projet)) DB.projet = "";
  $("#projet").innerHTML = `<option value="">Tous les projets</option>${projets().map((p) => `<option value="${p.uid}" ${p.uid === DB.projet ? "selected" : ""}>${esc(p.nom)}</option>`).join("")}`;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === VUE));
  $("#vue").innerHTML = { projets: vueProjets, jour: vueJour, fournisseurs: vueFournisseurs, reglages: vueReglages }[VUE]();
}
function row(x, opts = {}) {
  const t = x.t || x;
  return `<div class="trow ${t.statut === "fait" ? "done" : ""}">
    ${opts.rang ? `<span class="rang">${opts.rang}</span>` : `<button class="check" data-act="toggle" data-id="${t.uid}" aria-label="Marquer comme fait">✓</button>`}
    <div class="t"><a href="#" data-act="edit" data-id="${t.uid}">${esc(t.titre)}</a><span>${opts.why ? x.why.replace(/<[^>]+>/g, "") : esc(where(t))}${t.echeance && t.statut !== "fait" ? ` · pour le ${fr(t.echeance)}` : ""}</span></div>
    ${opts.rang ? `<button class="btn ghost" data-act="start" data-id="${t.uid}">Go</button>` : `<span class="prio p${t.priorite || 2}">${PRIO[t.priorite || 2]}</span>`}</div>`;
}
function vueProjets() {
  const ps = projets();
  if (!ps.length) return `<div class="empty">Aucun projet sur ce téléphone.<br><br>Sur le PC, coche « Sur le téléphone » sur tes projets perso, puis touche « Synchro ». Ou crée un projet ici.</div>${formProjet()}`;
  return ps.map((p) => {
    const r = ranked(p.uid), tot = L("taches").filter((t) => projOf(t) === p.uid), faites = tot.filter((t) => t.statut === "fait").length;
    const pct = tot.length ? Math.round((100 * faites) / tot.length) : 0;
    return `<section class="card"><div class="row"><h1 class="grow">${esc(p.nom)}</h1><span class="mono muted">${pct} %</span></div>
      <div class="gauge"><u style="width:${pct}%"></u></div>
      <h2>Top 3 de la semaine</h2>
      <div>${r.slice(0, 3).map((x, i) => row(x, { rang: i + 1, why: true })).join("") || `<div class="muted">Rien à faire pour l'instant.</div>`}</div>
      <button class="btn primary" data-act="ouvrir" data-id="${p.uid}">Ouvrir</button></section>`;
  }).join("") + formProjet();
}
const formProjet = () => `<form class="card add" data-form="projet"><input type="text" name="nom" placeholder="Nouveau projet" required autocomplete="off"><button class="btn">Créer</button></form>`;
function vueJour() {
  const p = get("projets", DB.projet), r = ranked(DB.projet || null), top = r[0];
  const last = L("taches").filter((t) => t.statut !== "fait" && t.reprise && (!DB.projet || projOf(t) === DB.projet)).sort((a, b) => b.maj - a.maj)[0];
  const n = doneToday(DB.projet || null).length;
  return `${p ? `<h1>${esc(p.nom)}</h1>` : ""}
  ${last ? `<section class="card" style="border-left:4px solid var(--accent)"><b>Tu en étais là sur « ${esc(last.titre)} »</b><div>${esc(last.reprise)}</div><button class="btn primary" data-act="start" data-id="${last.uid}">Reprendre</button></section>` : ""}
  ${top ? `<section class="card">
    <div class="eyebrow">Prochain cran${where(top.t) ? " · " + esc(where(top.t)) : ""}</div>
    <h1 style="font-size:26px">${esc(top.t.titre)}</h1>
    ${top.t.termine_quand ? `<div class="muted">Terminé quand : ${esc(top.t.termine_quand)}</div>` : ""}
    <div class="why">Pourquoi maintenant : ${top.why}</div>
    <button class="go" data-act="start" data-id="${top.t.uid}"><i></i>Commencer</button>
    <div class="row"><button class="btn" data-act="toggle" data-id="${top.t.uid}">Déjà fait</button><button class="btn ghost" data-act="edit" data-id="${top.t.uid}">Modifier</button></div>
  </section>` : `<div class="empty">Rien en attente${p ? " sur ce projet" : ""}. Ajoute une tâche ci-dessous.</div>`}
  ${r.length > 1 ? `<section class="card"><h2>Ensuite cette semaine</h2><div>${r.slice(1, 3).map((x) => row(x)).join("")}</div></section>` : ""}
  ${r.length > 3 ? `<details class="card"><summary><h2 style="display:inline">Toutes les tâches ouvertes (${r.length})</h2></summary><div>${r.slice(3).map((x) => row(x)).join("")}</div></details>` : ""}
  <form class="card add" data-form="tache"><input type="text" name="titre" placeholder="Nouvelle tâche…" required autocomplete="off"><button class="btn">Ajouter</button></form>
  <section class="card"><h2>Fait aujourd'hui</h2><div class="mono" style="font-size:32px;font-weight:700">${n}</div>
    ${doneToday(DB.projet || null).map((t) => row(t)).join("")}</section>`;
}
/* Vue Fournisseurs : même organisation que sur le PC (liste, frise des jalons, détail du jalon), en lecture seule. */
let FID = "", JID = "";
const docDone = (d) => d.statut === "Accepté" || (d.sens === "fournir" && d.statut === "Envoyé");
const jalonsOf = (f) => L("jalons").filter((j) => j.fournisseur === f).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
const tasksOfJ = (j) => L("taches").filter((t) => t.jalon === j);
const docsOfJ = (j, sens) => L("documents").filter((d) => d.jalon === j && (!sens || d.sens === sens));
const aClasser = (f) => L("taches").filter((t) => t.fournisseur === f && !get("jalons", t.jalon));
function pctItems(t, d) { const n = t.length + d.length; return n ? Math.round((100 * (t.filter((x) => x.statut === "fait").length + d.filter(docDone).length)) / n) : null; }
const pctJalon = (j) => pctItems(tasksOfJ(j.uid), docsOfJ(j.uid));
const pctFour = (f) => { const js = jalonsOf(f.uid); return pctItems([...js.flatMap((j) => tasksOfJ(j.uid)), ...aClasser(f.uid)], js.flatMap((j) => docsOfJ(j.uid))); };
const jalonOuvert = (f) => jalonsOf(f.uid).find((j) => !j.date_reelle && pctJalon(j) !== 100);
function frise(f) {
  const js = jalonsOf(f.uid); if (!js.length) return `<div class="empty">Aucun jalon.</div>`;
  const W = Math.max(300, js.length * 84), x0 = 44, x1 = W - 44, y = 92, R = 15, C = 2 * Math.PI * R;
  const X = (i) => (js.length === 1 ? W / 2 : x0 + (i * (x1 - x0)) / (js.length - 1));
  const split = (s) => { if (s.length <= 13) return [s]; const m = s.lastIndexOf(" ", 13); return m > 0 ? [s.slice(0, m), s.slice(m + 1)] : [s]; };
  const nodes = js.map((j, i) => {
    const p = pctJalon(j), sel = j.uid === JID, full = p === 100 || !!j.date_reelle, x = X(i), up = i % 2 === 1;
    const late = j.date_prevue && !j.date_reelle && daysTo(j.date_prevue) < 0;
    const lines = split(j.nom), dateTxt = j.date_reelle ? "fait " + fr(j.date_reelle) : fr(j.date_prevue) || "date ?";
    const ys = up ? lines.map((_, k) => y - 30 - (lines.length - 1 - k) * 14) : lines.map((_, k) => y + 38 + k * 14);
    const yd = up ? y - 30 - lines.length * 14 : y + 38 + lines.length * 14;
    return `<g class="node" data-act="pick-jalon" data-id="${j.uid}">
      <rect x="${x - 40}" y="0" width="80" height="184" fill="transparent"/>
      <line x1="${x}" y1="${up ? y - R - 4 : y + R + 4}" x2="${x}" y2="${up ? y - 24 : y + 24}" stroke="var(--line)"/>
      ${sel ? `<circle cx="${x}" cy="${y}" r="${R + 6}" fill="none" stroke="var(--accent)" stroke-width="2"/>` : ""}
      <circle cx="${x}" cy="${y}" r="${R}" fill="${full ? "var(--ink)" : "var(--surface)"}" stroke="var(--line)" stroke-width="5"/>
      ${!full && p ? `<circle cx="${x}" cy="${y}" r="${R}" fill="none" stroke="var(--accent)" stroke-width="5" stroke-dasharray="${(C * p) / 100} ${C}" transform="rotate(-90 ${x} ${y})"/>` : ""}
      <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="10" ${full ? 'style="fill:var(--surface)"' : ""}>${full ? "✓" : p === null ? "" : p}</text>
      ${lines.map((l, k) => `<text x="${x}" y="${ys[k]}" text-anchor="middle" font-size="12" font-weight="${sel ? 700 : 500}">${esc(l)}</text>`).join("")}
      <text x="${x}" y="${yd}" text-anchor="middle" font-size="10.5" ${late ? 'style="fill:var(--bad)"' : 'style="fill:var(--muted)"'}>${esc(dateTxt)}</text></g>`;
  }).join("");
  return `<div class="frise"><svg viewBox="0 0 ${W} 184" width="${W}" height="184" style="fill:var(--ink)"><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="var(--line)" stroke-width="2"/>${nodes}</svg></div>`;
}
function docListM(j, sens) {
  const ds = docsOfJ(j.uid, sens);
  return `<div><h2>${sens === "fournir" ? "À fournir" : "À recevoir"}</h2>${ds.length ? ds.map((d) => `<div class="trow"><div class="t ${docDone(d) ? "ok" : ""}">${esc(d.nom)}${d.version ? ` · ${esc(d.version)}` : ""}</div><span class="pill">${esc(d.statut || "")}</span></div>`).join("") : `<div class="muted" style="font-size:13px">Aucun document.</div>`}</div>`;
}
function vueFournisseurs() {
  const pid = DB.projet || projets()[0]?.uid;
  const fs = L("fournisseurs").filter((f) => !f.archive && (!pid || f.projet === pid));
  if (!fs.length) return `<div class="empty">Aucun fournisseur sur ce projet.<br><br>Sur le PC, ajoute-les dans l'onglet Fournisseurs, puis touche « Synchro ».</div>`;
  if (!fs.some((f) => f.uid === FID)) FID = fs[0].uid;
  const f = get("fournisseurs", FID);
  if (!JID || get("jalons", JID)?.fournisseur !== f.uid) JID = (jalonOuvert(f) || jalonsOf(f.uid)[0])?.uid || "";
  const j = get("jalons", JID), pj = j ? pctJalon(j) : null;
  const list = `<div class="flist">${fs.map((x) => { const p = pctFour(x);
    return `<button class="fitem ${x.uid === FID ? "on" : ""}" data-act="pick-four" data-id="${x.uid}"><b>${esc(x.nom)}</b><div class="gauge"><u style="width:${p ?? 0}%"></u></div><span class="mono muted" style="font-size:12px">${p === null ? "–" : p + " %"}</span></button>`; }).join("")}</div>`;
  const ac = aClasser(f.uid).filter((t) => t.statut !== "fait");
  return `${list}
  <section class="card"><div class="row"><div style="flex:1;min-width:0"><h1>${esc(f.nom)}</h1>${f.objet ? `<div class="muted">${esc(f.objet)}</div>` : ""}</div><span class="mono muted">${pctFour(f) ?? 0} %</span></div>${frise(f)}</section>
  ${ac.length ? `<section class="card"><h2>À classer dans un jalon (${ac.length})</h2>${ac.map((t) => `<div class="trow"><div class="t">${esc(t.titre)}</div></div>`).join("")}</section>` : ""}
  ${j ? `<section class="card"><div class="row"><h1 style="flex:1;font-size:20px">${esc(j.nom)}</h1><span class="mono">${pj === null ? "Vide" : pj + " %"}</span></div>
    <div class="gauge"><u style="width:${pj ?? 0}%"></u></div>
    <div class="muted" style="font-size:13px">${j.date_reelle ? "Fait le " + fr(j.date_reelle) : j.date_prevue ? "Prévu le " + fr(j.date_prevue) : "Date prévue non renseignée"}</div>
    <div><h2>Tâches</h2>${tasksOfJ(j.uid).map((t) => `<div class="trow ${t.statut === "fait" ? "done" : ""}"><div class="t">${esc(t.titre)}</div></div>`).join("") || `<div class="muted" style="font-size:13px">Aucune tâche.</div>`}</div>
    ${docListM(j, "fournir")}${docListM(j, "recevoir")}</section>` : ""}`;
}
function vueReglages() {
  const origin = location.origin;
  return `<section class="card"><h1>Synchronisation</h1>
    <div class="muted">${esc(DB.drive.dernier || "Pas encore synchronisé.")}</div>
    <button class="go" data-act="sync"><i></i>Synchroniser maintenant</button>
    <p class="muted" style="margin:0;font-size:14px">Cran mobile n'a accès qu'aux fichiers qu'il crée dans ton Google Drive : un dossier « Cran-synchro » et un fichier. Rien d'autre de ton Drive.</p></section>
  <section class="card"><h2>Identifiant Google de l'appli</h2>
    <form class="add" data-form="client"><input type="text" name="client" value="${esc(DB.clientId)}" placeholder="xxxxxxxx.apps.googleusercontent.com" required autocomplete="off" spellcheck="false"><button class="btn">OK</button></form>
    <div class="muted" style="font-size:13px">Origine à déclarer chez Google : <code>${esc(origin)}</code></div></section>
  <section class="card"><h2>Ce téléphone</h2>
    <div class="muted" style="font-size:14px">${L("projets").length} projet(s), ${L("taches").length} tâche(s).</div>
    <button class="btn" data-act="effacer">Effacer les données de ce téléphone</button>
    <div class="muted" style="font-size:13px">Efface seulement ce téléphone. Ton Google Drive et ton PC ne sont pas touchés ; une nouvelle synchro recharge tout.</div></section>`;
}

/* ---------- modale de tâche ---------- */
function editTask(t) {
  const pid = projOf(t) || projetCible();
  const fours = L("fournisseurs").filter((f) => f.projet === pid && !f.archive);
  const d = $("#modale");
  d.innerHTML = `<form method="dialog">
    <label>Titre<input type="text" name="titre" value="${esc(t.titre)}" required></label>
    <label>À rendre le<input type="date" name="echeance" value="${esc(t.echeance || "")}"></label>
    <label>Priorité<select name="priorite">${[3, 2, 1].map((p) => `<option value="${p}" ${p === (t.priorite || 2) ? "selected" : ""}>${PRIO[p]}</option>`).join("")}</select></label>
    ${fours.length ? `<label>Fournisseur<select name="four"><option value="">Aucun</option>${fours.map((f) => `<option value="${f.uid}" ${f.uid === (fourOf(t)?.uid) ? "selected" : ""}>${esc(f.nom)}</option>`).join("")}</select></label>` : ""}
    <label>Terminé quand…<input type="text" name="termine_quand" value="${esc(t.termine_quand || "")}"></label>
    ${t.notes ? `<label>Notes<textarea name="notes" rows="3">${esc(t.notes)}</textarea></label>` : ""}
    <div class="row" style="justify-content:space-between"><button class="btn ghost" value="delete" style="color:var(--bad)">Supprimer</button>
      <span class="row"><button class="btn" value="cancel" formnovalidate>Annuler</button><button class="btn primary" value="save">OK</button></span></div></form>`;
  d.querySelector("form").addEventListener("submit", (e) => {
    const v = e.submitter?.value; if (v === "cancel") return;
    e.preventDefault();
    if (v === "delete") { const b = e.submitter; if (!b.dataset.arm) { b.dataset.arm = 1; b.textContent = "Confirmer"; return; } supprimer("taches", t.uid); d.close(); return render(); }
    const fd = new FormData(e.target);
    const four = fd.has("four") ? fd.get("four") || null : t.fournisseur;
    upsert("taches", { ...t, titre: String(fd.get("titre")).trim(), echeance: fd.get("echeance") || "", priorite: Number(fd.get("priorite")),
      fournisseur: four, jalon: four === t.fournisseur ? t.jalon : null, termine_quand: fd.get("termine_quand") || "", ...(fd.has("notes") ? { notes: fd.get("notes") } : {}) });
    d.close(); render();
  });
  d.showModal();
}

/* ---------- focus ---------- */
const F = { t: null, phase: null, end: 0, total: 0, timer: null, lock: null };
const fmt = (ms) => { const s = Math.ceil(Math.max(0, ms) / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
function notif(t, b) { try { if (Notification.permission === "granted") new Notification(t, { body: b, tag: "cran" }); } catch {} if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
async function startFocus(u) {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch {}
  F.t = get("taches", u); if (!F.t) return;
  try { F.lock = await navigator.wakeLock?.request("screen"); } catch {}
  $("#focus").hidden = false; bloc();
}
function bloc() { F.total = REG.bloc * 60e3; F.end = Date.now() + F.total; phase("focus"); }
function pause() { F.total = REG.pause * 60e3; F.end = Date.now() + F.total; phase("pause"); }
function phase(p) { F.phase = p; drawFocus(); clearInterval(F.timer); if (p === "focus" || p === "pause") F.timer = setInterval(tick, 1000); tick(); }
function tick() {
  const r = F.end - Date.now(), c = $("#clock"), bar = $("#ring");
  if (c) c.textContent = fmt(r); if (bar) bar.style.width = `${100 - (100 * Math.max(0, r)) / F.total}%`;
  if (r <= 0 && F.phase === "focus") { notif("Bloc terminé", "Pause : bois un verre d'eau, lève-toi."); pause(); }
  else if (r <= 0 && F.phase === "pause") { notif("Pause terminée", `On reprend : ${F.t.titre}`); phase("apres"); }
}
function closeFocus() { clearInterval(F.timer); try { F.lock?.release(); } catch {} $("#focus").hidden = true; F.t = null; F.phase = null; render(); }
function drawFocus() {
  const t = F.t, st = steps(t), cur = st.findIndex((s) => !s.f), el = $("#focus");
  el.className = "focus" + (F.phase === "pause" || F.phase === "apres" ? " pause" : "");
  const titres = { focus: "Concentration", pause: "Pause", apres: "Pause terminée", stop: "Avant de t'arrêter" };
  let b = "";
  if (F.phase === "focus") b = `<div class="clock" id="clock"></div><div class="ring"><u id="ring"></u></div>
    ${cur >= 0 ? `<div class="card" style="width:100%;max-width:520px;text-align:left"><span class="muted" style="font-size:12px">Étape ${cur + 1} / ${st.length}</span>${esc(st[cur].t)}<button class="btn primary" data-act="f-step">Étape faite</button></div>` : ""}
    <div class="row" style="justify-content:center"><button class="btn" data-act="f-done">Tâche terminée</button><button class="btn" data-act="f-pause">Pause</button><button class="btn ghost" data-act="f-stop">M'arrêter</button></div>`;
  if (F.phase === "pause") b = `<div class="clock" id="clock"></div><div class="ring"><u id="ring"></u></div>
    <div>Bois un verre d'eau · lève-toi · regarde au loin · respire</div>
    <div class="row" style="justify-content:center"><button class="btn" data-act="f-resume">Reprendre</button><button class="btn ghost" data-act="f-stop">M'arrêter</button></div>`;
  if (F.phase === "apres") b = `<button class="go" data-act="f-resume"><i></i>Reprendre</button><button class="btn ghost" data-act="f-stop">M'arrêter</button>`;
  if (F.phase === "stop") b = `<label for="rep" style="max-width:520px">Où en es-tu, et quelle est la suite ?</label><textarea id="rep" rows="3">${esc(t.reprise || "")}</textarea>
    <div class="row" style="justify-content:center"><button class="btn primary" data-act="f-save">Enregistrer et quitter</button><button class="btn" data-act="f-resume">Continuer</button></div>`;
  el.innerHTML = `<div class="phase">${titres[F.phase]}</div><h1>${esc(t.titre)}</h1>${b}`;
}

/* ---------- synchronisation Google Drive ---------- */
let TOK = (() => { try { return JSON.parse(sessionStorage.getItem("cranm.tok") || "null"); } catch { return null; } })();
const tokOk = () => TOK && TOK.exp > Date.now() + 60e3;
let BUSY = false, planT = null;
function setSync(etat) { const b = $("#sync"); b.className = "sync " + etat; b.querySelector("span").textContent = etat === "busy" ? "…" : "Synchro"; }
function getToken(interactif) {
  return new Promise((res, rej) => {
    if (tokOk()) return res(TOK.access);
    if (!interactif) return rej(new Error("connexion"));
    if (!DB.clientId) { VUE = "reglages"; render(); return rej(new Error("Renseigne d'abord l'identifiant Google dans Réglages")); }
    if (!window.google?.accounts?.oauth2) return rej(new Error("Connexion Google indisponible : vérifie ta connexion Internet"));
    const c = google.accounts.oauth2.initTokenClient({
      client_id: DB.clientId, scope: SCOPE, prompt: DB.drive.consenti ? "" : "consent",
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        TOK = { access: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        try { sessionStorage.setItem("cranm.tok", JSON.stringify(TOK)); } catch {}
        DB.drive.consenti = true; persist(); res(TOK.access);
      },
      error_callback: (e) => rej(new Error(e?.type === "popup_closed" ? "Connexion annulée" : "Connexion Google impossible")),
    });
    c.requestAccessToken();
  });
}
async function gfetch(url, opt, tok) {
  let r;
  try { r = await fetch(url, { ...opt, headers: { ...(opt?.headers || {}), Authorization: "Bearer " + tok } }); }
  catch { throw new Error("Pas de connexion Internet : la synchro attendra"); }
  if (r.status === 401) { TOK = null; try { sessionStorage.removeItem("cranm.tok"); } catch {} throw new Error("Session Google expirée : touche Synchro"); }
  if (!r.ok) throw new Error(`Google Drive a répondu ${r.status}`);
  return r;
}
const docOf = (d) => ({ format: "cran-sync", version: 1, ecrit_le: Date.now(), ecrit_par: "telephone", items: d.items, supprimes: d.supprimes });
async function fichier(tok) {
  if (DB.drive.file) {
    const r = await fetch(`${API}/${DB.drive.file}?fields=id,trashed`, { headers: { Authorization: "Bearer " + tok } }).catch(() => null);
    if (r && r.ok && !(await r.json()).trashed) return DB.drive.file;
  }
  const q = (s) => encodeURIComponent(s);
  let d = await (await gfetch(`${API}?q=${q("name='Cran-synchro' and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id)`, {}, tok)).json();
  let dossier = d.files?.[0]?.id;
  if (!dossier) dossier = (await (await gfetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Cran-synchro", mimeType: "application/vnd.google-apps.folder" }) }, tok)).json()).id;
  d = await (await gfetch(`${API}?q=${q(`name='cran-sync.json' and '${dossier}' in parents and trashed=false`)}&fields=files(id)`, {}, tok)).json();
  let id = d.files?.[0]?.id;
  if (!id) {
    const b = "cran" + newId();
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: "cran-sync.json", parents: [dossier], mimeType: "application/json" })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(docOf(DB))}\r\n--${b}--`;
    id = (await (await gfetch(`${UP}?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body }, tok)).json()).id;
  }
  DB.drive.file = id; persist(); return id;
}
function merge(a, b) { // même règle que sur le PC : la modification la plus récente gagne, une suppression plus récente efface
  const supp = { ...(a.supprimes || {}) };
  for (const [u, m] of Object.entries(b.supprimes || {})) supp[u] = Math.max(m, supp[u] || 0);
  const items = {};
  for (const t of ORDER) {
    const best = new Map();
    for (const src of [a, b]) for (const it of src.items?.[t] || []) {
      if (!it || !it.uid) continue;
      const c = best.get(it.uid); if (!c || (it.maj || 0) > (c.maj || 0)) best.set(it.uid, it);
    }
    items[t] = [...best.values()].filter((it) => (supp[it.uid] ?? -1) < (it.maj || 0));
  }
  return { items, supprimes: supp };
}
const canon = (d) => JSON.stringify(ORDER.map((t) => (d.items?.[t] || []).map((it) => Object.keys(it).sort().map((k) => [k, it[k]])).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))))
  + JSON.stringify(Object.entries(d.supprimes || {}).sort());
async function synchroniser(interactif = false) {
  if (BUSY) return; BUSY = true; setSync("busy");
  try {
    const tok = await getToken(interactif), id = await fichier(tok);
    const txt = await (await gfetch(`${API}/${id}?alt=media`, {}, tok)).text();
    let distant = {}; try { distant = txt.trim() ? JSON.parse(txt) : {}; } catch {}
    const fusion = merge(distant, DB);
    const limite = Date.now() - 90 * 864e5;
    fusion.supprimes = Object.fromEntries(Object.entries(fusion.supprimes).filter(([, m]) => m > limite));
    DB.items = fusion.items; DB.supprimes = fusion.supprimes;
    if (canon(distant) !== canon(fusion))
      await gfetch(`${UP}/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(docOf(fusion)) }, tok);
    DB.drive.dernier = `Synchronisé à ${hhmm()}`; persist(); setSync("ok");
    if (!F.phase && !$("#modale").open) render();
  } catch (e) {
    setSync(e.message === "connexion" ? "" : "err");
    if (e.message !== "connexion") toast(e.message);
  }
  BUSY = false;
}
function planSync() { clearTimeout(planT); if (tokOk()) planT = setTimeout(() => synchroniser(false), 4000); }

/* ---------- événements ---------- */
document.addEventListener("click", async (e) => {
  const v = e.target.closest("#tabs [data-view]"); if (v) { VUE = v.dataset.view; return render(); }
  if (e.target.closest("#sync")) return synchroniser(true);
  const b = e.target.closest("[data-act]"); if (!b) return;
  e.preventDefault();
  const id = b.dataset.id, t = get("taches", id);
  switch (b.dataset.act) {
    case "toggle": upsert("taches", { ...t, statut: t.statut === "fait" ? "a_faire" : "fait", fait_le: t.statut === "fait" ? "" : stamp(), reprise: t.statut === "fait" ? t.reprise : "" }); if (t.statut !== "fait") toast("Cran franchi."); return render();
    case "edit": return editTask(t);
    case "start": return startFocus(id);
    case "pick-four": FID = id; JID = ""; return render();
    case "pick-jalon": JID = id; return render();
    case "ouvrir": DB.projet = id; persist(); VUE = "jour"; return render();
    case "sync": return synchroniser(true);
    case "effacer": if (!b.dataset.arm) { b.dataset.arm = 1; b.textContent = "Confirmer : tout effacer sur ce téléphone"; return; }
      { const cid = DB.clientId; DB = vide(); DB.clientId = cid; persist(); toast("Téléphone vidé"); return render(); }
    case "f-step": { const st = steps(F.t), i = st.findIndex((s) => !s.f); if (i >= 0) st[i].f = true; F.t = upsert("taches", { ...F.t, etapes: JSON.stringify(st) }); return drawFocus(), tick(); }
    case "f-done": upsert("taches", { ...F.t, statut: "fait", fait_le: stamp(), reprise: "" }); toast("Cran franchi."); return closeFocus();
    case "f-pause": return pause();
    case "f-resume": return bloc();
    case "f-stop": clearInterval(F.timer); return phase("stop");
    case "f-save": upsert("taches", { ...F.t, reprise: $("#rep").value.trim() }); return closeFocus();
  }
});
document.addEventListener("change", (e) => { if (e.target.id === "projet") { DB.projet = e.target.value; persist(); if (DB.projet) VUE = "jour"; render(); } });
document.addEventListener("submit", (e) => {
  const f = e.target, k = f.dataset.form; if (!k) return;
  e.preventDefault();
  const v = (n) => String(new FormData(f).get(n) || "").trim();
  if (k === "projet") { const p = upsert("projets", { nom: v("nom"), ordre: L("projets").length, archive: 0 }); DB.projet = p.uid; persist(); VUE = "jour"; return render(); }
  if (k === "tache") {
    const pid = projetCible(); if (!pid) return toast("Crée d'abord un projet");
    upsert("taches", { titre: v("titre"), projet: pid, fournisseur: null, jalon: null, priorite: 2, lourde: 0, repetitive: 0, etapes: "[]", statut: "a_faire",
      reprise: "", notes: "", termine_quand: "", echeance: "", cree_le: stamp(), fait_le: "" });
    return render();
  }
  if (k === "client") { DB.clientId = v("client"); persist(); toast("Identifiant enregistré : touche « Synchroniser maintenant »"); return render(); }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tokOk()) synchroniser(false); });
setInterval(() => { if (document.visibilityState === "visible" && tokOk()) synchroniser(false); }, 120e3);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (!projets().length && !DB.drive.file) VUE = "projets";
render();
if (tokOk()) synchroniser(false);
