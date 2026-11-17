// NEF Trailer Cash: Firebase Auth + Firestore client.
// Every Firestore write below is shaped to match firestore.rules exactly; see README.md.
import { firebaseConfig } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

/* ---------- Game constants ---------- */
const TRAILERS = [
  { title: "Avatar: Fire and Ash", id: "V9uJ3mcOFA0" },
  { title: "The Running Man", id: "KD18ddeFuyM" },
  { title: "How to Train Your Dragon", id: "22w7z_lT6YM" },
  { title: "The Super Mario Galaxy Movie", id: "GuCejewteF8" },
  { title: "F1 The Movie", id: "CT2_P2DZBR0" }
];
const DAILY = 5;
const REWARD = 50;
const WORDS = ["", "Not for me", "It's okay", "Pretty good", "Really good", "Must see"];
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
const METHODS = {
  airtime: { label: "Airtime", min: 5 },
  ewallet: { label: "Mobile money / eWallet", min: 20 },
  bank: { label: "Bank transfer", min: 50 }
};
const RESEND_COOLDOWN = 60;

/* ---------- South Africa time (fixed UTC+2, no DST), same as the rules ---------- */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function saDate(ms) { return new Date((ms === undefined ? Date.now() : ms) + 2 * 3600 * 1000); } // read with getUTC*
function dayNum(d) { return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }
function todayNum() { return dayNum(saDate()); }
function isWeekendDate(d) { const w = d.getUTCDay(); return w === 0 || w === 6; }
function isWeekend() { return isWeekendDate(saDate()); }
function nextWeekday() {
  const d = saDate();
  do { d.setUTCDate(d.getUTCDate() + 1); } while (isWeekendDate(d));
  return d;
}
function fmtDay(d) { return DAYS[d.getUTCDay()] + ", " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); }

/* ---------- DOM helpers ---------- */
const $ = (id) => document.getElementById(id);
const screens = {};
["loading", "verify", "signup", "login", "withdraw", "start", "play", "cashout"].forEach((k) => { screens[k] = $(k); });
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s-]{9,16}$/;

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 3600);
}
function setErr(id, msg) {
  const e = $(id + "-err");
  if (e) e.textContent = msg || "";
  const input = $(id);
  if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
  return !msg;
}
function val(id) { return $(id).value.trim(); }
function focusFirstError(form) {
  const bad = form.querySelector('[aria-invalid="true"]');
  if (bad) bad.focus();
}
function busy(btn, on, text) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = text || "Please wait…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}
function rand(coins) { return "R" + (coins / 100).toFixed(2); }

/* ---------- App state ---------- */
const state = { screen: "loading", back: "start", playIndex: 0, current: 0 };
let fb = null;          // loaded Firebase modules
let auth = null, db = null;
let sessionUid = null;  // uid whose listeners are attached
let udoc = null;        // live users/{uid} data
let history = [];       // live withdrawals
let unsubs = [];
let shownCoins = null;  // what the HUD currently shows
let signingUp = false;
let firstAuthEvent = true;
let resendTimer = null;

function verifiedUser() { return !!(auth && auth.currentUser && auth.currentUser.emailVerified); }
function todaysRatings() {
  if (!udoc) return [];
  return udoc.day === todayNum() && Array.isArray(udoc.ratings) ? udoc.ratings : [];
}

function show(name) {
  Object.keys(screens).forEach((k) => { screens[k].hidden = k !== name; });
  if (name !== "play") $("player").src = "about:blank";
  state.screen = name;
  $("hud").hidden = !(verifiedUser() && udoc && ["start", "play", "cashout", "withdraw"].includes(name));
  if (name === "start") renderStart();
  if (name === "withdraw") updateWithdraw();
  renderHud();
  const h = screens[name].querySelector("h2");
  if (name !== "loading") screens[name].scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (h) h.focus({ preventScroll: true });
}

/* ---------- HUD and coins ---------- */
function animateCoins(from, to) {
  const pill = $("coins");
  pill.classList.remove("is-bump");
  void pill.offsetWidth;
  pill.classList.add("is-bump");
  const plus = document.createElement("span");
  plus.className = "x-plus";
  plus.textContent = "+" + (to - from);
  pill.appendChild(plus);
  setTimeout(() => plus.remove(), 1200);
  if (reduce) { $("coin-count").textContent = to; return; }
  let start = null;
  const dur = 600;
  function step(ts) {
    if (!start) start = ts;
    const p = Math.min(1, (ts - start) / dur);
    $("coin-count").textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function renderCoins() {
  if (!udoc) return;
  const c = udoc.coins || 0;
  if (shownCoins !== null && c > shownCoins) animateCoins(shownCoins, c);
  else $("coin-count").textContent = c;
  shownCoins = c;
}
function renderHud() {
  const n = todaysRatings().length;
  const name = (udoc && udoc.name) || (auth && auth.currentUser && auth.currentUser.displayName) || "there";
  $("hud-name").textContent = String(name).split(/\s+/)[0];
  $("progress-label").textContent = "Trailer " + n + " of " + DAILY;
  $("progress-bar").style.width = (n / DAILY) * 100 + "%";
}

/* ---------- Start screen ---------- */
function renderStart() {
  const btn = $("start-btn"), msg = $("start-msg");
  const n = todaysRatings().length;
  msg.hidden = true;
  btn.disabled = false;
  btn.textContent = "Start Earning";
  if (!udoc) {
    btn.disabled = true;
    msg.textContent = "Loading your account…";
    msg.hidden = false;
  } else if (isWeekend()) {
    btn.disabled = true;
    msg.textContent = "Trailers are available Monday to Friday. Next trailers: " + fmtDay(nextWeekday());
    msg.hidden = false;
  } else if (n >= DAILY) {
    btn.disabled = true;
    btn.textContent = "Come back tomorrow";
    msg.textContent = "Your 5 trailers for today are done. Next trailers: " + fmtDay(nextWeekday());
    msg.hidden = false;
  } else if (n > 0) {
    btn.textContent = "Resume: trailer " + (n + 1) + " of " + DAILY;
  }
}

$("start-btn").addEventListener("click", () => {
  if (!verifiedUser()) { show("verify"); return; }
  const n = todaysRatings().length;
  if (!udoc || isWeekend() || n >= DAILY) { renderStart(); return; }
  state.playIndex = n;
  loadTrailer();
  show("play");
});

/* ---------- Play screen ---------- */
const stars = [];
for (let i = 1; i <= 5; i++) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "x-star";
  b.setAttribute("aria-label", i + (i === 1 ? " star" : " stars"));
  b.setAttribute("aria-pressed", "false");
  b.innerHTML = STAR_SVG;
  b.dataset.value = i;
  b.addEventListener("click", () => { if (!watch.unlocked) return; pick(i); });
  $("stars").appendChild(b);
  stars.push(b);
}
function pick(v) {
  state.current = v;
  stars.forEach((s, n) => {
    s.classList.toggle("is-on", n < v);
    s.setAttribute("aria-pressed", n < v ? "true" : "false");
  });
  $("rate-pick").textContent = v + (v === 1 ? " star" : " stars") + " · " + WORDS[v];
  $("collect-btn").disabled = false;
}
/* ---------- Watch gate: stars unlock near the end of the trailer ---------- */
const UNLOCK_SHARE = 0.85;      // must have actually watched 85% of the trailer
const END_WINDOW = 15;          // and be within the last 15 seconds
const FALLBACK_SECS = 120;      // if the YouTube API can't load, unlock after 2 minutes
const watch = { unlocked: false, watched: 0, last: null, timer: null, player: null, fallback: null };
let ytReady = null;
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => reject(new Error("yt"));
    document.head.appendChild(tag);
    setTimeout(() => reject(new Error("yt-timeout")), 10000);
  });
  return ytReady;
}
function fmt(sec) { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
function setLocked(locked, msg) {
  watch.unlocked = !locked;
  $("stars").classList.toggle("is-locked", locked);
  stars.forEach((s) => { s.disabled = locked; });
  $("rate-label").textContent = locked ? "Watch to the end to rate" : "Rate this trailer";
  if (locked) $("rate-pick").textContent = msg || "Stars unlock as the trailer ends";
  else if (!state.current) $("rate-pick").textContent = "Stars unlocked. How was it?";
}
function stopWatch() {
  clearInterval(watch.timer); watch.timer = null;
  clearTimeout(watch.fallback); watch.fallback = null;
}
function unlockStars() { if (watch.unlocked) return; stopWatch(); setLocked(false); }
function tick() {
  const pl = watch.player;
  if (!pl || typeof pl.getCurrentTime !== "function") return;
  const dur = pl.getDuration() || 0, cur = pl.getCurrentTime() || 0;
  const playing = pl.getPlayerState && pl.getPlayerState() === 1;
  if (playing && watch.last !== null) {
    const d = cur - watch.last;
    if (d > 0 && d < 1.5) watch.watched += d;   // count only real playback, not skips
  }
  watch.last = cur;
  if (!dur) return;
  const need = dur * UNLOCK_SHARE;
  if (watch.watched >= need && cur >= dur - END_WINDOW) { unlockStars(); return; }
  if (watch.watched < need) $("rate-pick").textContent = "Keep watching · stars unlock in " + fmt(need - watch.watched);
  else $("rate-pick").textContent = "Almost there · watch to the end";
}
function startWatch(id) {
  stopWatch();
  watch.watched = 0; watch.last = null;
  setLocked(true);
  loadYT().then((YT) => {
    const opts = { videoId: id, playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
      events: { onStateChange: (e) => { if (e.data === 0) unlockStars(); } } };
    if (watch.player && typeof watch.player.loadVideoById === "function") {
      watch.player.cueVideoById(id);
    } else {
      const old = $("player");
      if (old && old.tagName === "IFRAME") { const d = document.createElement("div"); d.id = "player"; old.replaceWith(d); }
      watch.player = new YT.Player("player", opts);
    }
    watch.timer = setInterval(tick, 500);
  }).catch(() => {
    // API blocked: plain embed, unlock after a fixed time
    const f = $("player");
    if (f && f.tagName === "IFRAME") f.src = "https://www.youtube-nocookie.com/embed/" + id + "?rel=0&playsinline=1";
    $("rate-pick").textContent = "Stars unlock in " + fmt(FALLBACK_SECS);
    watch.fallback = setTimeout(unlockStars, FALLBACK_SECS * 1000);
  });
}
function loadTrailer() {
  const t = TRAILERS[state.playIndex];
  state.current = 0;
  $("play-eyebrow").textContent = "Trailer " + (state.playIndex + 1) + " of " + DAILY;
  $("play-title").textContent = t.title;
  const f = $("player");
  if (f && f.tagName === "IFRAME") f.title = t.title + " trailer";
  stars.forEach((s) => { s.classList.remove("is-on"); s.setAttribute("aria-pressed", "false"); });
  const c = $("collect-btn");
  c.disabled = true;
  c.textContent = "Collect " + REWARD + " coins";
  startWatch(t.id);
}

class GameError extends Error { constructor(code) { super(code); this.code = code; } }

// One rated trailer = one transaction on users/{uid}: day, coins+50, ratings+1, updatedAt.
async function collect() {
  if (!state.current || !auth.currentUser || !watch.unlocked) return;
  const { runTransaction, doc, serverTimestamp } = fb.fs;
  const c = $("collect-btn");
  c.disabled = true;
  c.textContent = "Saving…";
  const t = TRAILERS[state.playIndex];
  const starsGiven = state.current;
  const ref = doc(db, "users", auth.currentUser.uid);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new GameError("no-doc");
      const d = snap.data();
      const today = todayNum();
      if (isWeekend()) throw new GameError("weekend");
      const sameDay = d.day === today;
      const prev = sameDay && Array.isArray(d.ratings) ? d.ratings : [];
      if (prev.length >= DAILY) throw new GameError("done");
      if (prev.length !== state.playIndex) throw new GameError("out-of-sync");
      const entry = { id: t.id, stars: starsGiven };
      tx.update(ref, {
        day: today,
        coins: d.coins + REWARD,
        ratings: sameDay ? prev.concat([entry]) : [entry],
        updatedAt: serverTimestamp()
      });
    });
  } catch (e) {
    const code = e && e.code;
    let msg = "Couldn't save your rating. Check your connection and try again.";
    if (code === "weekend") msg = "Trailers are available Monday to Friday.";
    else if (code === "done") msg = "You've already rated today's 5 trailers.";
    else if (code === "out-of-sync") msg = "Your progress changed on another device. Picking up where you left off.";
    else if (code === "permission-denied") msg = "Couldn't save: check your email is verified and your device's date is correct.";
    toast(msg);
    if (code === "weekend" || code === "done" || code === "out-of-sync") { show("start"); return; }
    c.disabled = false;
    c.textContent = "Collect " + REWARD + " coins";
    return;
  }
  c.textContent = "+" + REWARD + " coins!";
  setTimeout(() => {
    state.playIndex++;
    if (state.playIndex < DAILY) { loadTrailer(); show("play"); }
    else cashout();
  }, reduce ? 300 : 900);
}
$("collect-btn").addEventListener("click", collect);

/* ---------- Cashout ---------- */
function miniStars(n) {
  let s = "";
  for (let k = 1; k <= 5; k++) s += k <= n ? "★" : '<span class="x-off">★</span>';
  return '<span class="x-mini" aria-label="' + n + ' of 5 stars">' + s + "</span>";
}
function cashout() {
  const r = todaysRatings();
  const sum = r.reduce((a, x) => a + x.stars, 0);
  $("cash-total").textContent = r.length * REWARD;
  $("cash-avg").textContent = r.length ? (sum / r.length).toFixed(1) : "0.0";
  const body = $("recap");
  body.innerHTML = "";
  r.forEach((x) => {
    const t = TRAILERS.find((m) => m.id === x.id);
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = t ? t.title : x.id;
    tr.appendChild(th);
    tr.insertAdjacentHTML("beforeend", '<td data-label="Your stars">' + miniStars(x.stars) + '</td><td class="num" data-label="Coins">+' + REWARD + "</td>");
    body.appendChild(tr);
  });
  $("cash-next").textContent = "Your 5 trailers for today are done. Next trailers: " + fmtDay(nextWeekday());
  show("cashout");
}

/* ---------- Withdraw ---------- */
function method() {
  const m = document.querySelector('input[name="wd-method"]:checked');
  return m ? m.value : "";
}
function updateWithdraw() {
  const coins = udoc ? udoc.coins || 0 : 0;
  $("wd-coins").textContent = coins;
  $("wd-rand").textContent = rand(coins);
  const m = method();
  $("wd-details").hidden = !m;
  if (!m) return;
  document.querySelectorAll("#wd-details [data-for]").forEach((f) => {
    f.hidden = f.dataset.for.split(" ").indexOf(m) < 0;
  });
  const min = METHODS[m].min;
  const need = min * 100 - coins;
  $("wd-amount").min = min;
  $("wd-amount").max = (coins / 100).toFixed(2);
  $("wd-amount-hint").textContent = "Minimum R" + min.toFixed(2) + " · up to " + rand(coins);
  $("wd-short").textContent = need > 0 ? "You need " + need + " more coins" : "";
  $("wd-submit").disabled = need > 0;
}
function openWithdraw() {
  if (!verifiedUser()) { show("verify"); return; }
  if (state.screen !== "withdraw") state.back = state.screen;
  show("withdraw");
}
$("hud-withdraw").addEventListener("click", openWithdraw);
$("cash-withdraw").addEventListener("click", openWithdraw);
$("wd-back").addEventListener("click", () => {
  const to = state.back || "start";
  if (to === "play" && state.playIndex < DAILY && todaysRatings().length === state.playIndex) { loadTrailer(); show("play"); }
  else if (to === "cashout") cashout();
  else show("start");
});
document.querySelectorAll('input[name="wd-method"]').forEach((r) => {
  r.addEventListener("change", () => {
    $("wd-method-err").textContent = "";
    ["wd-network", "wd-phone", "wd-bank", "wd-holder", "wd-account", "wd-amount"].forEach((id) => setErr(id, ""));
    updateWithdraw();
  });
});

function fmtWhen(ts) {
  const d = ts && typeof ts.toDate === "function" ? ts.toDate() : new Date();
  return d.toLocaleString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
}
function statusChip(status) {
  const s = ["Pending", "Paid", "Rejected"].includes(status) ? status : "Pending";
  const span = document.createElement("span");
  span.className = "chip x-st-" + s.toLowerCase();
  span.textContent = s;
  return span;
}
function renderHistory() {
  const body = $("wd-history");
  body.innerHTML = "";
  history.forEach((h) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = fmtWhen(h.createdAt);
    tr.appendChild(th);
    const m = METHODS[h.method];
    [["Method", m ? m.label : h.method], ["Amount", rand(h.amountCents || 0)]].forEach(([label, text]) => {
      const td = document.createElement("td");
      td.dataset.label = label;
      td.textContent = text;
      if (label === "Amount") td.className = "num";
      tr.appendChild(td);
    });
    const st = document.createElement("td");
    st.dataset.label = "Status";
    st.appendChild(statusChip(h.status));
    tr.appendChild(st);
    body.appendChild(tr);
  });
  $("wd-history-wrap").hidden = history.length === 0;
  $("wd-empty").hidden = history.length > 0;
}

// Withdrawal = one atomic commit: create users/{uid}/withdrawals/{wid} and
// update users/{uid} {coins: old - cost, lastWithdrawal: wid, updatedAt}.
$("wd-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!verifiedUser()) { show("verify"); return; }
  const m = method();
  if (!m) { $("wd-method-err").textContent = "Choose a withdrawal method"; return; }
  let ok = true;
  let detail = "";
  if (m === "airtime") {
    ok = setErr("wd-network", val("wd-network") ? "" : "Choose a network") && ok;
  }
  if (m === "airtime" || m === "ewallet") {
    const p = val("wd-phone");
    ok = setErr("wd-phone", !p ? "Enter a cellphone number" : PHONE_RE.test(p) ? "" : "Enter a valid cellphone number") && ok;
    detail = m === "airtime" ? val("wd-network") + " · " + p : p;
  }
  if (m === "bank") {
    const acc = val("wd-account").replace(/\s/g, "");
    ok = setErr("wd-bank", val("wd-bank") ? "" : "Choose a bank") && ok;
    ok = setErr("wd-holder", val("wd-holder") ? "" : "Enter the account holder's name") && ok;
    ok = setErr("wd-account", !acc ? "Enter an account number" : /^\d{6,16}$/.test(acc) ? "" : "Enter a valid account number (digits only)") && ok;
    detail = val("wd-bank") + " · " + val("wd-holder") + " · " + acc;
  }
  const coins = udoc ? udoc.coins || 0 : 0;
  const raw = $("wd-amount").value.trim();
  const amt = parseFloat(raw);
  const cost = Math.round(amt * 100);
  const min = METHODS[m].min;
  const amtErr = !raw || isNaN(amt) || amt <= 0 ? "Enter an amount in rand"
    : !/^\d+(\.\d{1,2})?$/.test(raw) ? "Use up to 2 decimal places"
    : cost < min * 100 ? "Minimum for " + METHODS[m].label + " is R" + min.toFixed(2)
    : cost > coins ? "That's more than your balance of " + rand(coins)
    : "";
  ok = setErr("wd-amount", amtErr) && ok;
  if (!ok) { focusFirstError(form); return; }
  if (!Number.isInteger(cost) || cost < 500) { setErr("wd-amount", "Minimum withdrawal is R5.00"); return; }

  const { runTransaction, doc, collection, serverTimestamp } = fb.fs;
  const uid = auth.currentUser.uid;
  const uref = doc(db, "users", uid);
  const wref = doc(collection(db, "users", uid, "withdrawals")); // pre-generated id
  const btn = $("wd-submit");
  busy(btn, true, "Sending request…");
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(uref);
      if (!snap.exists()) throw new GameError("no-doc");
      const d = snap.data();
      if (d.coins < cost) throw new GameError("insufficient");
      tx.set(wref, {
        method: m,
        detail: detail,
        amountCents: cost,
        coinsCost: cost,
        status: "Pending",
        createdAt: serverTimestamp()
      });
      tx.update(uref, {
        coins: d.coins - cost,
        lastWithdrawal: wref.id,
        updatedAt: serverTimestamp()
      });
    });
  } catch (e) {
    busy(btn, false);
    const code = e && e.code;
    if (code === "insufficient") setErr("wd-amount", "That's more than your balance");
    toast(code === "insufficient" ? "Not enough coins for that amount." : "Couldn't send your request. Please try again.");
    updateWithdraw();
    return;
  }
  busy(btn, false);
  $("wd-amount").value = "";
  updateWithdraw();
  toast("Request received. Payouts are processed within 48 hours on weekdays.");
});

/* ---------- Auth: helpers ---------- */
function authMessage(e) {
  const code = (e && e.code) || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
      return "Wrong email or password.";
    case "auth/user-not-found": return "No account found for that email. Please sign up first.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a few minutes and try again, or reset your password.";
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/user-disabled": return "This account has been disabled. Contact rangariraimutasa@gmail.com.";
    case "auth/email-already-in-use": return "An account already exists for that email. Log in instead.";
    case "auth/weak-password": return "Password must be at least 6 characters.";
    case "auth/network-request-failed": return "Network problem. Check your connection and try again.";
    case "auth/operation-not-allowed": return "Email sign-in isn't enabled yet. Please try again later.";
    case "auth/configuration-not-found": return "Sign-in isn't set up on the server yet. Please try again later.";
    case "auth/unauthorized-domain": return "This website isn't authorised for sign-in yet.";
    case "auth/missing-email": return "Enter your email first.";
    default: return "Something went wrong. Please try again.";
  }
}

function teardown() {
  unsubs.forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
  unsubs = [];
  sessionUid = null;
  udoc = null;
  history = [];
  shownCoins = null;
  renderHistory();
}

// Creates users/{uid} if it is missing (e.g. a sign-up that was interrupted).
async function ensureUserDoc(user) {
  const { doc, getDoc, setDoc, serverTimestamp } = fb.fs;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    name: user.displayName || "",
    email: (user.email || "").toLowerCase(),
    phone: "",
    coins: 100,
    day: 0,
    ratings: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

// Live listeners: the user doc and the withdrawal history. Resolves on the first user snapshot.
function subscribe(uid) {
  const { doc, onSnapshot, collection, query, orderBy } = fb.fs;
  return new Promise((resolve) => {
    let first = true;
    unsubs.push(onSnapshot(doc(db, "users", uid), (snap) => {
      udoc = snap.exists() ? snap.data() : null;
      renderCoins();
      renderHud();
      if (state.screen === "withdraw") updateWithdraw();
      if (state.screen === "start") renderStart();
      if (first) { first = false; resolve(); }
    }, (err) => {
      console.error("user doc listener", err);
      toast("Couldn't load your account. Please refresh.");
      if (first) { first = false; resolve(); }
    }));
    unsubs.push(onSnapshot(
      query(collection(db, "users", uid, "withdrawals"), orderBy("createdAt", "desc")),
      (qs) => {
        history = qs.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
        renderHistory();
      },
      (err) => { console.error("withdrawals listener", err); }
    ));
  });
}

// Makes sure the ID token carries email_verified=true, which the rules check.
async function freshToken(user) {
  try {
    const r = await user.getIdTokenResult();
    if (!r.claims.email_verified) await user.getIdToken(true);
  } catch (e) { /* offline: Firestore will refresh later */ }
}

async function enterApp(user) {
  if (sessionUid !== user.uid) {
    teardown();
    sessionUid = user.uid;
    $("loading-msg").textContent = "Loading your account…";
    if (state.screen === "loading") show("loading");
    try { await ensureUserDoc(user); } catch (e) { console.error("ensureUserDoc", e); }
    await subscribe(user.uid);
  }
  if (!user.emailVerified) { try { await user.reload(); } catch (e) { /* ignore */ } }
  const cur = auth.currentUser;
  if (!cur || cur.uid !== user.uid) return;
  if (cur.emailVerified) {
    await freshToken(cur);
    show("start");
  } else {
    showVerify();
  }
}

/* ---------- Verify email screen ---------- */
function showVerify() {
  $("verify-email").textContent = (auth.currentUser && auth.currentUser.email) || "your email";
  $("verify-err").textContent = "";
  show("verify");
}
function startResendCooldown() {
  const b = $("verify-resend");
  let left = RESEND_COOLDOWN;
  clearInterval(resendTimer);
  b.disabled = true;
  b.textContent = "Resend email (" + left + "s)";
  resendTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(resendTimer); b.disabled = false; b.textContent = "Resend email"; }
    else b.textContent = "Resend email (" + left + "s)";
  }, 1000);
}
$("verify-check").addEventListener("click", async () => {
  const user = auth && auth.currentUser;
  if (!user) { show("login"); return; }
  const b = $("verify-check");
  $("verify-err").textContent = "";
  $("verify-ok").textContent = "";
  busy(b, true, "Checking…");
  try {
    await user.reload();
    if (auth.currentUser.emailVerified) {
      await auth.currentUser.getIdToken(true); // new token with email_verified=true for the rules
      busy(b, false);
      toast("Email verified. Let's earn!");
      show("start");
      return;
    }
    $("verify-err").textContent = "Not verified yet. Open the link in the email we sent, then tap I've verified.";
  } catch (e) {
    $("verify-err").textContent = authMessage(e);
  }
  busy(b, false);
});
$("verify-resend").addEventListener("click", async () => {
  const user = auth && auth.currentUser;
  if (!user) return;
  $("verify-err").textContent = "";
  $("verify-ok").textContent = "";
  try {
    await fb.auth.sendEmailVerification(user);
    $("verify-ok").textContent = "Sent. Check your inbox for a new link.";
    startResendCooldown();
  } catch (e) {
    $("verify-err").textContent = authMessage(e);
    if (e && e.code === "auth/too-many-requests") startResendCooldown();
  }
});
async function logOut() {
  state.back = "start";
  teardown();
  try { await fb.auth.signOut(auth); } catch (e) { /* ignore */ }
  $("li-err").textContent = "";
  show("login");
}
$("verify-logout").addEventListener("click", logOut);
$("hud-logout").addEventListener("click", logOut);

/* ---------- Screen links ---------- */
document.querySelectorAll("[data-go]").forEach((b) => {
  b.addEventListener("click", () => show(b.dataset.go));
});

/* ---------- Sign up ---------- */
$("signup-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!auth) return;
  const name = val("su-name"), email = val("su-email").toLowerCase(), phone = val("su-phone");
  const pass = $("su-pass").value, pass2 = $("su-pass2").value;
  let ok = true;
  $("su-err").textContent = "";
  ok = setErr("su-name", name ? "" : "Enter your full name") && ok;
  ok = setErr("su-email", !email ? "Enter your email" : EMAIL_RE.test(email) ? "" : "Enter a valid email address") && ok;
  ok = setErr("su-phone", !phone ? "Enter your cellphone number" : PHONE_RE.test(phone) ? "" : "Enter a valid cellphone number") && ok;
  ok = setErr("su-pass", !pass ? "Enter a password" : pass.length < 6 ? "Password must be at least 6 characters" : "") && ok;
  ok = setErr("su-pass2", !pass2 ? "Confirm your password" : pass2 !== pass ? "Passwords don't match" : "") && ok;
  ok = setErr("su-terms", $("su-terms").checked ? "" : "Please confirm you're 18 or older and accept the Terms") && ok;
  if (!ok) { focusFirstError(form); return; }

  const { createUserWithEmailAndPassword, updateProfile, sendEmailVerification } = fb.auth;
  const { doc, setDoc, serverTimestamp } = fb.fs;
  const btn = $("su-submit");
  busy(btn, true, "Creating account…");
  signingUp = true;
  let user = null;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    user = cred.user;
  } catch (e) {
    signingUp = false;
    busy(btn, false);
    const msg = authMessage(e);
    if (e && (e.code === "auth/email-already-in-use" || e.code === "auth/invalid-email")) setErr("su-email", msg);
    else if (e && e.code === "auth/weak-password") setErr("su-pass", msg);
    else $("su-err").textContent = msg;
    return;
  }
  try {
    try { await updateProfile(user, { displayName: name }); } catch (e) { console.warn("updateProfile", e); }
    await setDoc(doc(db, "users", user.uid), {
      name: name,
      email: email,
      phone: phone,
      coins: 100,
      day: 0,
      ratings: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    try {
      await sendEmailVerification(user);
      startResendCooldown();
    } catch (e) {
      console.warn("sendEmailVerification", e);
      toast("Couldn't send the verification email. Tap Resend email.");
    }
    form.reset();
    shownCoins = 0; // the first snapshot animates the +100 bonus
    toast("Welcome bonus +100 coins");
  } catch (e) {
    console.error("sign-up profile", e);
    toast("Account created, but your profile didn't save. We'll retry when you continue.");
  } finally {
    signingUp = false;
    busy(btn, false);
  }
  await enterApp(user);
});

/* ---------- Log in ---------- */
$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  if (!auth) return;
  const email = val("li-email").toLowerCase(), pass = $("li-pass").value;
  const liErr = $("li-err");
  liErr.textContent = "";
  $("forgot-note").textContent = "";
  let err = !email ? "Enter your email" : !EMAIL_RE.test(email) ? "Enter a valid email address" : !pass ? "Enter your password" : "";
  if (!err) {
    const btn = $("li-submit");
    busy(btn, true, "Logging in…");
    try {
      await fb.auth.signInWithEmailAndPassword(auth, email, pass);
      form.reset();
    } catch (e) {
      err = authMessage(e);
    }
    busy(btn, false);
  }
  liErr.textContent = err;
  $("li-email").setAttribute("aria-invalid", err ? "true" : "false");
  $("li-pass").setAttribute("aria-invalid", err ? "true" : "false");
  // Success: onAuthStateChanged routes to start or verify.
});
$("forgot-btn").addEventListener("click", async () => {
  if (!auth) return;
  const email = val("li-email").toLowerCase();
  const note = $("forgot-note");
  const liErr = $("li-err");
  note.textContent = "";
  liErr.textContent = "";
  if (!email || !EMAIL_RE.test(email)) {
    liErr.textContent = "Enter your email above, then tap Forgot password?";
    $("li-email").setAttribute("aria-invalid", "true");
    $("li-email").focus();
    return;
  }
  $("li-email").setAttribute("aria-invalid", "false");
  const b = $("forgot-btn");
  b.disabled = true;
  try {
    await fb.auth.sendPasswordResetEmail(auth, email);
    note.textContent = "If an account exists for " + email + ", we've sent a password reset link. Check your inbox and spam folder.";
  } catch (e) {
    if (e && e.code === "auth/user-not-found") note.textContent = "If an account exists for " + email + ", we've sent a password reset link.";
    else liErr.textContent = authMessage(e);
  }
  b.disabled = false;
});

/* ---------- Boot ---------- */
function setupPending(msg) {
  $("setup-banner").textContent = msg || "Setup pending: Firebase not connected yet";
  $("setup-banner").hidden = false;
  document.querySelectorAll("[data-auth]").forEach((b) => { b.disabled = true; });
  show("signup");
}

async function boot() {
  renderHistory();
  const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey !== "REPLACE_ME");
  if (!configured) { setupPending(); return; }
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-firestore.js")
    ]);
    fb = { app: appMod, auth: authMod, fs: fsMod };
    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    db = fsMod.getFirestore(app);
  } catch (e) {
    console.error("Firebase failed to load", e);
    setupPending("Couldn't connect to the server. Check your connection and refresh.");
    return;
  }
  watchAuth();
}

function watchAuth() {
  fb.auth.onAuthStateChanged(auth, async (user) => {
    const wasFirst = firstAuthEvent;
    firstAuthEvent = false;
    if (signingUp) return; // the sign-up handler routes when it finishes
    if (!user) {
      teardown();
      if (["loading", "start", "play", "cashout", "withdraw", "verify"].includes(state.screen)) {
        show(wasFirst ? "signup" : "login");
      }
      return;
    }
    await enterApp(user);
  });
}

boot();
