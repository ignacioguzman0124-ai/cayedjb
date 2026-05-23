#!/usr/bin/env node
/**
 * backup_firestore.js — exporta /dogs, /walks/{fecha}/dogs y /meta a un único JSON.
 *
 * Uso local:
 *   FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
 *     node scripts/backup_firestore.js [archivo_salida.json]
 *
 * En CI lo invoca .github/workflows/firestore_backup.yml con el secret
 * FIREBASE_SERVICE_ACCOUNT_JSON. Sin argumento escribe a backups/YYYY-MM-DD.json (UTC).
 *
 * Usa el Admin SDK: ignora las Security Rules (acceso total de servidor).
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.error('❌ Falta la variable FIREBASE_SERVICE_ACCOUNT_JSON (secret/env).');
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido:', e.message);
    process.exit(1);
  }
}

// Timestamps de Firestore → ISO 8601 (string); el resto se deja igual.
function tsToISO(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  return v;
}
function normalize(data) {
  const out = {};
  for (const [k, val] of Object.entries(data)) out[k] = tsToISO(val);
  return out;
}

async function main() {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();

  const backup = {
    exportedAt: new Date().toISOString(),
    schemaVersion: 5,
    dogs: {},
    walks: {},
    meta: {},
  };

  // /dogs/{dogId}
  const dogsSnap = await db.collection('dogs').get();
  dogsSnap.forEach(d => { backup.dogs[d.id] = normalize(d.data()); });

  // /walks/{fecha}/dogs/{dogId} — listDocuments() devuelve también los "phantom"
  // (fechas que solo existen como padre de la subcolección dogs).
  const dateRefs = await db.collection('walks').listDocuments();
  for (const dateRef of dateRefs) {
    const daySnap = await dateRef.collection('dogs').get();
    if (daySnap.empty) continue;
    const day = {};
    daySnap.forEach(d => { day[d.id] = normalize(d.data()); });
    backup.walks[dateRef.id] = day;
  }

  // /meta/{doc}
  const metaSnap = await db.collection('meta').get();
  metaSnap.forEach(d => { backup.meta[d.id] = normalize(d.data()); });

  backup.counts = {
    dogs: Object.keys(backup.dogs).length,
    walkDays: Object.keys(backup.walks).length,
    walkDocs: Object.values(backup.walks).reduce((n, day) => n + Object.keys(day).length, 0),
    meta: Object.keys(backup.meta).length,
  };

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const outFile = process.argv[2] || path.join('backups', `${today}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(backup, null, 2));

  console.log(`✅ Backup escrito en ${outFile}`);
  console.log(`   dogs=${backup.counts.dogs} · días=${backup.counts.walkDays} · ` +
              `walkDocs=${backup.counts.walkDocs} · meta=${backup.counts.meta}`);
}

main().catch(e => {
  console.error('❌ Backup falló:', e);
  process.exit(1);
});
