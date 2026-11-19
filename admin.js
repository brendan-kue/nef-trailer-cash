// NEF Trailer Cash admin: list every withdrawal and mark it Paid or Rejected.
// Access: a doc admins/{uid} must exist (created by hand in the Firebase console).
import { firebaseConfig } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const METHODS = { airtime: "Airtime", ewallet: "Mobile money / eWallet", bank: "Bank transfer" };

const $ = (id) => document.getElementById(id);
const screens = { loading: $("loading"), login: $("login"), denied: $("denied"), admin: $("admin") };
let fb = null, auth = null, db = null;
let unsub = null;
let rows = [];
const users = new Map(); // uid -> {name, email} | Promise

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 3600);
}
function show(name) {
  Object.keys(screens).forEach((k) => { screens[k].hidden = k !== name; });
  $("hud").hidden = !(name === "admin" || name === "denied");
  const h = screens[name].querySelector("h2");
  if (h) h.focus({ preventScroll: true });
}
function rand(cents) { return "R" + ((cents || 0) / 100).toFixed(2); }
function fmtWhen(ts) {
  if (!ts || typeof ts.toDate !== "function") return "—";
  return ts.toDate().toLocaleString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
}
function millis(ts) { return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0; }

function authMessage(e) {
  switch ((e && e.code) || "") {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password": return "Wrong email or password.";
    case "auth/user-not-found": return "No account found for that email.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/network-request-failed": return "Network problem. Check your connection and try again.";
    default: return "Something went wrong. Please try again.";
  }
}

/* ---------- User lookup (parent path users/{uid}) ---------- */
function loadUser(uid) {
  if (users.has(uid)) return users.get(uid);
  const p = fb.fs.getDoc(fb.fs.doc(db, "users", uid))
    .then((s) => { const d = s.exists() ? s.data() : {}; const u = { name: d.name || "", email: d.email || "", phone: d.phone || "" }; users.set(uid, u); return u; })
    .catch(() => { const u = { name: "", email: "(unreadable)", phone: "" }; users.set(uid, u); return u; });
  users.set(uid, p);
  return p;
}

/* ---------- Table ---------- */
function statusChip(status) {
  const s = ["Pending", "Paid", "Rejected"].includes(status) ? status : "Pending";
  const span = document.createElement("span");
  span.className = "chip x-st-" + s.toLowerCase();
  span.textContent = s;
  return span;
}
function cell(tr, label, text, cls) {
  const td = document.createElement("td");
  td.dataset.label = label;
  if (cls) td.className = cls;
  if (text instanceof Node) td.appendChild(text); else td.textContent = text;
  tr.appendChild(td);
  return td;
}
function render() {
  const body = $("admin-rows");
  body.innerHTML = "";
  let pending = 0, pendingAmt = 0;
  rows.forEach((r) => {
    const d = r.data;
    if (d.status === "Pending") { pending++; pendingAmt += d.amountCents || 0; }
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = fmtWhen(d.createdAt);
    tr.appendChild(th);

    const who = document.createElement("div");
    const u = users.get(r.uid);
    if (u && !(u instanceof Promise)) {
      const n = document.createElement("div"); n.textContent = u.name || "(no name)";
      const e = document.createElement("div"); e.className = "x-small"; e.textContent = u.email + (u.phone ? " · " + u.phone : "");
      who.append(n, e);
    } else {
      who.textContent = "Loading…";
      loadUser(r.uid).then(render);
    }
    cell(tr, "User", who);
    cell(tr, "Method", METHODS[d.method] || d.method || "");
    cell(tr, "Detail", d.detail || "", "x-small");
    cell(tr, "Amount", rand(d.amountCents), "num");
    const st = document.createElement("div");
    st.appendChild(statusChip(d.status));
    if (d.note) { const nt = document.createElement("div"); nt.className = "x-small"; nt.textContent = d.note; st.appendChild(nt); }
    if (d.processedAt) { const pt = document.createElement("div"); pt.className = "x-small"; pt.textContent = fmtWhen(d.processedAt); st.appendChild(pt); }
    cell(tr, "Status", st);

    const act = document.createElement("div");
    act.className = "x-admin-actions";
    if (d.status === "Pending") {
      const paid = document.createElement("button");
      paid.type = "button"; paid.className = "x-ghost x-ghost--gold"; paid.textContent = "Mark paid";
      paid.addEventListener("click", () => setStatus(r, "Paid", paid));
      const rej = document.createElement("button");
      rej.type = "button"; rej.className = "x-ghost"; rej.textContent = "Reject";
      rej.addEventListener("click", () => setStatus(r, "Rejected", rej));
      act.append(paid, rej);
    } else {
      act.textContent = "—";
    }
    cell(tr, "Action", act);
    body.appendChild(tr);
  });
  $("st-pending").textContent = pending;
  $("st-pending-amt").textContent = rand(pendingAmt);
  $("admin-wrap").hidden = rows.length === 0;
  $("admin-empty").hidden = rows.length > 0;
}

// Admin update: only status, processedAt and note change (matches the rules).
async function setStatus(r, status, btn) {
  let note = "";
  if (status === "Rejected") {
    const n = window.prompt("Reason for rejecting (optional, the user won't see it in the app):", "");
    if (n === null) return;
    note = n.trim().slice(0, 500);
  } else {
    if (!window.confirm("Mark " + rand(r.data.amountCents) + " (" + (METHODS[r.data.method] || r.data.method) + ") as paid?")) return;
  }
  btn.disabled = true;
  try {
    await fb.fs.updateDoc(r.ref, { status: status, processedAt: fb.fs.serverTimestamp(), note: note });
    toast(status === "Paid" ? "Marked paid." : "Rejected.");
  } catch (e) {
    console.error(e);
    toast("Couldn't update: " + ((e && e.code) || "error"));
    btn.disabled = false;
  }
}

/* ---------- Listing: ordered query, with a fallback if the index is missing ---------- */
function setRows(qs) {
  rows = qs.docs.map((d) => ({ ref: d.ref, uid: d.ref.parent.parent.id, data: d.data({ serverTimestamps: "estimate" }) }));
  rows.sort((a, b) => millis(b.data.createdAt) - millis(a.data.createdAt));
  render();
}
function listen() {
  const { collectionGroup, query, orderBy, onSnapshot } = fb.fs;
  $("admin-err").textContent = "";
  if (unsub) unsub();
  unsub = onSnapshot(query(collectionGroup(db, "withdrawals"), orderBy("createdAt", "desc")), setRows, (err) => {
    console.warn("ordered collectionGroup query failed", err);
    if (err && err.code === "failed-precondition") {
      $("admin-sub").textContent = "Newest first (sorted in the browser: the createdAt collection-group index isn't built yet, see README).";
      unsub = onSnapshot(collectionGroup(db, "withdrawals"), setRows, (e2) => {
        $("admin-err").textContent = "Couldn't load withdrawals: " + ((e2 && e2.code) || "error");
      });
    } else {
      $("admin-err").textContent = "Couldn't load withdrawals: " + ((err && err.code) || "error");
    }
  });
}

/* ---------- Sponsored-ad report ---------- */
async function loadAds() {
  const { collection, getDocs } = fb.fs;
  const body = $("ads-rows");
  try {
    const qs = await getDocs(collection(db, "adviews"));
    const agg = new Map();
    qs.forEach((d) => {
      const v = d.data();
      const g = agg.get(v.sponsor) || { views: 0, stars: 0, first: v.day, last: v.day };
      g.views++; g.stars += v.stars || 0;
      g.first = Math.min(g.first, v.day); g.last = Math.max(g.last, v.day);
      agg.set(v.sponsor, g);
    });
    body.innerHTML = "";
    const day = (n) => String(n).replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
    agg.forEach((g, k) => {
      const tr = document.createElement("tr");
      [k, g.views, (g.stars / g.views).toFixed(1) + " / 5", day(g.first) + " – " + day(g.last)].forEach((t, i) => {
        const c = document.createElement(i ? "td" : "th");
        if (!i) c.scope = "row";
        c.textContent = t;
        tr.appendChild(c);
      });
      body.appendChild(tr);
    });
    $("ads-empty").hidden = agg.size > 0;
    $("ads-wrap").hidden = agg.size === 0;
  } catch (e) {
    $("ads-empty").textContent = "Couldn't load ad views: " + ((e && e.code) || "error");
  }
}
$("ads-refresh").addEventListener("click", loadAds);

/* ---------- Auth ---------- */
$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!auth) return;
  const email = $("li-email").value.trim().toLowerCase(), pass = $("li-pass").value;
  const err = $("li-err");
  err.textContent = "";
  if (!email || !pass) { err.textContent = "Enter your email and password."; return; }
  const b = $("li-submit");
  b.disabled = true;
  try {
    await fb.auth.signInWithEmailAndPassword(auth, email, pass);
    form.reset();
  } catch (e) {
    err.textContent = authMessage(e);
  }
  b.disabled = false;
});
async function logOut() {
  if (unsub) { unsub(); unsub = null; }
  rows = []; users.clear(); render();
  try { await fb.auth.signOut(auth); } catch (e) { /* ignore */ }
}
$("hud-logout").addEventListener("click", logOut);
$("denied-logout").addEventListener("click", logOut);

async function boot() {
  const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey !== "REPLACE_ME");
  if (!configured) {
    $("setup-banner").hidden = false;
    document.querySelectorAll("[data-auth]").forEach((b) => { b.disabled = true; });
    show("login");
    return;
  }
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-firestore.js")
    ]);
    fb = { auth: authMod, fs: fsMod };
    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    db = fsMod.getFirestore(app);
  } catch (e) {
    console.error(e);
    $("setup-banner").textContent = "Couldn't connect to the server. Check your connection and refresh.";
    $("setup-banner").hidden = false;
    show("login");
    return;
  }
  fb.auth.onAuthStateChanged(auth, async (user) => {
    if (!user) { show("login"); return; }
    $("hud-email").textContent = user.email || "";
    $("loading-msg").textContent = "Checking admin access…";
    show("loading");
    let isAdmin = false;
    try {
      const s = await fb.fs.getDoc(fb.fs.doc(db, "admins", user.uid));
      isAdmin = s.exists();
    } catch (e) {
      console.error(e);
      $("denied-msg").textContent = "Couldn't check admin access (" + ((e && e.code) || "error") + ").";
    }
    if (!isAdmin) { show("denied"); return; }
    show("admin");
    loadAds();
    listen();
  });
}

boot();
