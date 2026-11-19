# NEF Trailer Cash

Watch 5 trailers a day (Mon-Fri, South Africa time), rate them, earn 10 coins each, +25 for finishing all 5 in a day, +50 for 5 full days in one week; withdraw (100 coins = R1) once the account has 5 full days (free unlock, no deposit).

Live (main branch): https://brendan-kue.github.io/nef-trailer-cash/

This `firebase` branch moves accounts and coins to Firebase Authentication (email/password + email-link verification) and Cloud Firestore. Until `config.js` is filled in, the app shows "Setup pending: Firebase not connected yet" and sign-up/log-in are disabled.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.js` | The app (sign up, verify email, log in, play, cashout, withdraw + history) |
| `admin.html`, `admin.js` | Admin payouts page (not linked anywhere) |
| `privacy.html` | Privacy notice, linked from the footer |
| `config.js` | Firebase web config (`firebaseConfig`), placeholders until set up |
| `styles.css` | Shared app styles (with `hark.css`, `hark-hero.css`) |
| `firestore.rules` | Security rules (the client writes exactly what these accept) |
| `firestore.indexes.json`, `firebase.json` | Index for the admin collection-group query; config for the Firebase CLI |

## Setup checklist

1. **Create a Firebase project** at https://console.firebase.google.com (the free Spark plan is enough).
2. **Enable Email/Password sign-in**: Build > Authentication > Get started > Sign-in method > Email/Password > Enable (leave "Email link (passwordless)" off). Phone/SMS sign-in is not used.
3. **Authorise the domain**: Authentication > Settings > Authorized domains > Add domain > `brendan-kue.github.io`.
4. **Create Firestore**: Build > Firestore Database > Create database > location **africa-south1 (Johannesburg)** > start in production mode.
5. **Paste the rules**: Firestore > Rules > replace everything with the contents of `firestore.rules` > Publish.
6. **Register a web app**: Project settings (gear) > General > Your apps > Web (`</>`) > register (no Hosting needed) > copy the `firebaseConfig` values into `config.js`, replacing every `REPLACE_ME`. Commit and push.
7. **Make yourself an admin**: sign up on the site, verify your email, then in Authentication > Users copy your **User UID**. In Firestore > Start collection `admins` > Document ID = that UID > add any field (e.g. `role` = `admin`) > Save. Then open `/admin.html` and log in.
8. **Index for the admin page** (recommended): Firestore > Indexes > Single field > Add exemption: collection `withdrawals`, field `createdAt`, enable **Collection group** scope ascending and descending. Or with the Firebase CLI: `firebase deploy --only firestore:indexes`. Until it's built, the admin page still works: it falls back to an unordered query and sorts in the browser (the browser console also prints a one-click link to create the index).
9. Optional: Authentication > Templates > customise the verification and password-reset emails (sender name, "NEF Trailer Cash").

## How the data looks

- `users/{uid}`: `{name, email, phone, coins, day, ratings, createdAt, updatedAt, lastWithdrawal?, week?, weekFull?, fullDays?}`. `week` is the Monday-start week number (SA time), `weekFull` the full days in that week, `fullDays` the lifetime full days (withdrawals need 5). `day` is a number `yyyymmdd` in South Africa time (UTC+2); `ratings` holds today's ratings only, `[{id: youtubeId, stars: 1-5}]`.
- `users/{uid}/withdrawals/{wid}`: `{method: 'airtime'|'ewallet'|'bank', detail, amountCents, coinsCost, status: 'Pending'|'Paid'|'Rejected', createdAt, processedAt?, note?}`.
- `admins/{uid}`: exists = admin. Created by hand only.

Notes:
- Rejecting a withdrawal does **not** give the coins back (the rules don't let admins change a user's balance). Refund by editing `coins` on the user's doc in the console if needed.
- The day and weekday are checked by the rules against the server clock in UTC+2, so a phone with a wrong date can't earn.
