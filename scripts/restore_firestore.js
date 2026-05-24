#!/usr/bin/env node
/**
 * restore_firestore.js — restaura Firestore desde un JSON de backup_firestore.js.
 *
 * ⚠️  SOLO MANUAL y DESTRUCTIVO. Pide confirmación escribiendo exactamente RESTAURAR.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
 *     node scripts/restore_firestore.js backups/2026-05-25.json
 *
 * Comportamiento:
 *   - dogs y walks → escritura por OVERWRITE (set sin merge) con los datos del backup.
 *   - meta → merge.
 *   - NO borra documentos que existan en producción y no estén en el backup
 *     (una restauración no debería hacer desaparecer marcas más nuevas en silencio).
 */
const fs = require('fs');
const readline = require('readline');
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

// ISO 8601 (string) → Timestamp de Firestore, para markedAt / lastWrite.
function fromISO(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
  }
  return v;
}
function denormalize(data) {
  const out = {};
  for (const [k, val] of Object.entries(data)) out[k] = fromISO(val);
  return out;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim()); }));
}

async function commitInChunks(db, ops) {
  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + CHUNK)) batch.set(op.ref, op.data, op.opts || {});
    await batch.commit();
    process.stdout.write(`   …${Math.min(i + CHUNK, ops.length)}/${ops.length}\r`);
  }
  process.stdout.write('\n');
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node scripts/restore_firestore.js <backup.json>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`❌ No existe el archivo ${file}`);
    process.exit(1);
  }
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dogs = backup.dogs || {};
  const walks = backup.walks || {};
  const meta = backup.meta || {};
  const walkDocs = Object.values(walks).reduce((n, day) => n + Object.keys(day).length, 0);

  console.log(`Restaurar desde: ${file}`);
  console.log(`  exportado: ${backup.exportedAt || '(desconocido)'}`);
  console.log(`  dogs=${Object.keys(dogs).length} · días=${Object.keys(walks).length} · ` +
              `walkDocs=${walkDocs} · meta=${Object.keys(meta).length}`);
  console.log('');
  console.log('⚠️  Esto SOBRESCRIBE dogs/walks/meta en PRODUCCIÓN (cayedjb-3d151).');

  const ans = await ask('Escribe RESTAURAR para continuar (cualquier otra cosa cancela): ');
  if (ans !== 'RESTAURAR') {
    console.log('Cancelado. No se escribió nada.');
    process.exit(0);
  }

  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();
  const ops = [];

  for (const [id, d] of Object.entries(dogs)) {
    ops.push({ ref: db.collection('dogs').doc(id), data: denormalize(d) });
  }
  for (const [date, day] of Object.entries(walks)) {
    for (const [id, v] of Object.entries(day)) {
      ops.push({ ref: db.collection('walks').doc(date).collection('dogs').doc(id), data: denormalize(v) });
    }
  }
  for (const [id, d] of Object.entries(meta)) {
    ops.push({ ref: db.collection('meta').doc(id), data: denormalize(d), opts: { merge: true } });
  }

  console.log(`Escribiendo ${ops.length} documentos…`);
  await commitInChunks(db, ops);
  console.log('✅ Restauración completada.');
}

main().catch(e => {
  console.error('❌ Restore falló:', e);
  process.exit(1);
});
