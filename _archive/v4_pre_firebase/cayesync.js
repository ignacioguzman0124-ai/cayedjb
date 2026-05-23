// FIREBASE v4 — ver BRIEF_CLAUDE_CODE_v4_firebase.md
// CayeSync — capa cliente compartida (móvil + PC)
//
// Modelo pure event-sourced:
//   - state/main:        config (CUSTOM_DOGS, CUSTOM_BD, CUSTOM_DAYS,
//                        CUSTOM_RATES, TEMP_RATES, WR, BR, INACTIVE_DOGS, pay)
//   - events/{id}:       log append-only (att, shift, boarding, expense, rate, dog)
//   - expenses/{id}:     gastos individuales
//   - invoices/{YYYYMM}: facturas
//   - archive/{YYYYMM}/: snapshot del mes al cerrar
//
// att y shiftDone son MAPAS DERIVADOS del listener de events con LWW por key.
// EXPENSES es un ARRAY DERIVADO del listener de expenses/.
// El resto del state se merge-actualiza en state/main.
//
// API expuesta en window.CayeSync:
//   addEvent({type,key,value,prev})    — escribe evento (no espera respuesta)
//   updateState(patch)                 — merge en state/main
//   archiveMonth(YYYYMM)               — mueve eventos del mes a /archive (Fase 6)
//   diag()                             — datos para pestaña diagnóstico
//   bootstrap({onState, onEvents, onExpenses}) — inicia listeners, llama callbacks
//   syncFromGlobals({att, shiftDone, state, expenses}) — diff-and-emit (lo usa syncPush)
//
// La integración con los HTML legacy se hace re-escribiendo el cuerpo de
// syncPush/syncPull (móvil) y pcSyncPush/pcSyncPull (PC) para que deleguen aquí.

(function(){
  "use strict";

  // ─── Estado interno ──────────────────────────────────────────────────
  var ready = false;
  var pendingOps = [];               // ops encoladas mientras CayeDB carga
  var DB = null;                     // window.CayeDB (set al estar ready)
  var applyingRemoteSnapshot = false; // true durante callbacks de listeners,
                                      // syncFromGlobals lo respeta para no
                                      // re-emitir si el render del HTML
                                      // accidentalmente disparase saveS

  // Última snapshot reducida del server — usada para diff-and-emit.
  // Tras cada snapshot del listener, se actualiza con lo que llega.
  // El diff de syncPush compara los globals actuales contra esto.
  var lastSyncedAtt = {};
  var lastSyncedShift = {};
  var lastSyncedState = {};          // state/main (sin att/shift)
  var lastSyncedExpensesById = {};   // id → expense

  // Diagnóstico
  var diag = {
    lastAddEventAt: 0,
    lastStateSnapAt: 0,
    lastEventsSnapAt: 0,
    lastExpensesSnapAt: 0,
    pendingEventCount: 0,
    eventsToday: []
  };

  var DEVICE = (function(){
    // El HTML define window.CAYE_DEVICE = "mobile" | "pc"
    return (typeof window!=="undefined" && window.CAYE_DEVICE) || "mobile";
  })();

  // ─── Espera a que window.CayeDB esté listo ──────────────────────────
  function awaitDB(cb){
    if (window.CayeDB && window.CayeDB.auth && window.CayeDB.auth.currentUser) {
      DB = window.CayeDB; ready = true;
      cb(); return;
    }
    var tries = 0;
    var tick = setInterval(function(){
      tries++;
      if (window.CayeDB && window.CayeDB.auth && window.CayeDB.auth.currentUser) {
        clearInterval(tick);
        DB = window.CayeDB; ready = true;
        // Drena las ops encoladas
        var ops = pendingOps.slice(); pendingOps = [];
        ops.forEach(function(op){ try{ op(); }catch(e){ console.error("CayeSync queued op failed", e); } });
        cb();
      } else if (tries > 400) { // ~40s timeout
        clearInterval(tick);
        console.error("CayeSync: window.CayeDB nunca estuvo listo (¿firebase-config.js cargado?)");
      }
    }, 100);
  }

  // ─── addEvent ────────────────────────────────────────────────────────
  function addEvent(evt){
    if (!ready) { pendingOps.push(function(){ addEvent(evt); }); return; }
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
           : (Date.now()+"-"+Math.random().toString(36).slice(2,10));
    var doc = {
      id: id,
      ts: DB.serverTimestamp(),
      clientTs: Date.now(),
      device: DEVICE,
      type: evt.type,
      key: evt.key,
      value: (evt.value === undefined) ? null : evt.value
    };
    if (evt.prev !== undefined) doc.prev = evt.prev;
    diag.lastAddEventAt = Date.now();
    var evRef = DB.doc(DB.db, "events", id);
    DB.setDoc(evRef, doc).catch(function(e){
      console.error("CayeSync.addEvent failed", e, doc);
    });
  }

  // ─── updateState (merge en state/main) ──────────────────────────────
  function updateState(patch){
    if (!ready) { pendingOps.push(function(){ updateState(patch); }); return; }
    var stateRef = DB.doc(DB.db, "state", "main");
    var payload = {};
    Object.keys(patch).forEach(function(k){
      if (patch[k] !== undefined) payload[k] = patch[k];
    });
    payload.updatedAt = DB.serverTimestamp();
    payload.updatedBy = DEVICE;
    DB.setDoc(stateRef, payload, { merge: true }).catch(function(e){
      console.error("CayeSync.updateState failed", e, payload);
    });
  }

  // ─── Reductor LWW de events ──────────────────────────────────────────
  // Recibe el array completo de events del snapshot y produce
  // { att: {...}, shiftDone: {...} }.
  function reduceEvents(events){
    var bestByKey = {}; // type|key → evento ganador (mayor clientTs)
    events.forEach(function(e){
      var k = e.type + "::" + e.key;
      var cur = bestByKey[k];
      if (!cur || (e.clientTs||0) > (cur.clientTs||0)) bestByKey[k] = e;
    });
    var att = {}, shiftDone = {};
    Object.keys(bestByKey).forEach(function(k){
      var e = bestByKey[k];
      if (e.value === null) return; // null = deleted, omitir
      if (e.type === "att")   att[e.key] = e.value;
      if (e.type === "shift") shiftDone[e.key] = e.value;
      // boarding/expense/rate/dog se manejan por otras colecciones o vía state
    });
    return { att: att, shiftDone: shiftDone };
  }

  // ─── bootstrap: arranca listeners ───────────────────────────────────
  // callbacks: { onState(stateDoc), onEvents({att,shiftDone}), onExpenses(arr) }
  function bootstrap(callbacks){
    if (!ready) { pendingOps.push(function(){ bootstrap(callbacks); }); return; }
    callbacks = callbacks || {};

    // 1. Listener state/main
    var stateRef = DB.doc(DB.db, "state", "main");
    DB.onSnapshot(stateRef, function(snap){
      diag.lastStateSnapAt = Date.now();
      var data = snap.exists() ? snap.data() : {};
      lastSyncedState = JSON.parse(JSON.stringify(data));
      if (callbacks.onState) {
        applyingRemoteSnapshot = true;
        try { callbacks.onState(data); }
        catch(e){ console.error("onState handler failed", e); }
        finally { applyingRemoteSnapshot = false; }
      }
    }, function(err){ console.error("state listener error", err); });

    // 2. Listener events (últimos 90 días)
    // - clientTs (number) en lugar de ts (serverTimestamp): los writes pendientes
    //   tienen ts=null hasta que el server los resuelve, y filtrarían off los
    //   propios escritos del usuario del snapshot local — UX rota.
    // - SIN limit(): el filtro de 90 días acota naturalmente (~30 perros × 2
    //   toggles/día = ~5.4k docs de techo). Los archivados >90d se mueven a
    //   /archive/{YYYYMM}/ en Fase 6. El tope duro de Firestore es 10k.
    var ts90 = new Date(Date.now() - 90*86400000);
    var eventsQ = DB.query(
      DB.collection(DB.db, "events"),
      DB.where("clientTs", ">=", ts90.getTime()),
      DB.orderBy("clientTs", "desc")
    );
    DB.onSnapshot(eventsQ, function(snap){
      diag.lastEventsSnapAt = Date.now();
      var arr = [];
      snap.forEach(function(d){ arr.push(d.data()); });
      // Cuenta los pending (los que aún no tienen ts del server)
      diag.pendingEventCount = arr.filter(function(e){ return !e.ts; }).length;
      // Lista colapsable de eventos de hoy
      var todayKey = (new Date()).toISOString().slice(0,10);
      diag.eventsToday = arr.filter(function(e){
        return typeof e.key === "string" && e.key.indexOf(todayKey) === 0;
      }).slice(0, 50);
      var reduced = reduceEvents(arr);
      // CRÍTICO: clonar antes de guardar como baseline del diff.
      // El callback hace `att = reduced.att` (alias por referencia). Si
      // guardamos `lastSyncedAtt = reduced.att`, cuando el usuario muta
      // att[k] = v también muta lastSyncedAtt[k] = v, y el diff en
      // syncFromGlobals nunca detecta cambio → cero events emitidos.
      // Shallow es suficiente: los values son primitivos (true/false).
      lastSyncedAtt = Object.assign({}, reduced.att);
      lastSyncedShift = Object.assign({}, reduced.shiftDone);
      if (callbacks.onEvents) {
        applyingRemoteSnapshot = true;
        try { callbacks.onEvents(reduced); }
        catch(e){ console.error("onEvents handler failed", e); }
        finally { applyingRemoteSnapshot = false; }
      }
    }, function(err){ console.error("events listener error", err); });

    // 3. Listener expenses
    var expQ = DB.collection(DB.db, "expenses");
    DB.onSnapshot(expQ, function(snap){
      diag.lastExpensesSnapAt = Date.now();
      var arr = [];
      var byId = {};
      snap.forEach(function(d){ var x = d.data(); arr.push(x); byId[x.id||d.id] = x; });
      lastSyncedExpensesById = byId;
      if (callbacks.onExpenses) {
        applyingRemoteSnapshot = true;
        try { callbacks.onExpenses(arr); }
        catch(e){ console.error("onExpenses handler failed", e); }
        finally { applyingRemoteSnapshot = false; }
      }
    }, function(err){ console.error("expenses listener error", err); });
  }

  // ─── syncFromGlobals: diff-and-emit ─────────────────────────────────
  // Compara los globals actuales contra lastSynced* y emite los cambios.
  // Lo invoca syncPush (móvil) y pcSyncPush (PC) tras saveS().
  function syncFromGlobals(g){
    if (!ready) { pendingOps.push(function(){ syncFromGlobals(g); }); return; }
    // Anti-loop: si render() durante un listener disparase saveS y este llamase
    // a syncFromGlobals, el diff vería los cambios recién aplicados contra
    // lastSynced* (que el listener ya actualizó) y emitiría duplicados.
    if (applyingRemoteSnapshot) return;

    // --- att: diff por key ---
    // Tras emitir un evento actualizamos prev optimísticamente para evitar
    // re-emisión si syncFromGlobals se llama de nuevo antes de que el listener
    // refleje el cambio. El listener al final sobreescribe lastSyncedAtt con
    // el reducido del server (con clone), así que esto es seguro.
    if (g.att) {
      var att = g.att, prev = lastSyncedAtt || {};
      var seen = {};
      Object.keys(att).forEach(function(k){
        seen[k] = true;
        if (att[k] !== prev[k]) {
          addEvent({ type:"att", key:k, value:att[k], prev:prev[k] });
          prev[k] = att[k];
        }
      });
      var deletes = Object.keys(prev).filter(function(k){ return !seen[k]; });
      deletes.forEach(function(k){
        addEvent({ type:"att", key:k, value:null, prev:prev[k] });
        delete prev[k];
      });
    }

    // --- shiftDone: diff por key ---
    if (g.shiftDone) {
      var sd = g.shiftDone, sprev = lastSyncedShift || {};
      var sseen = {};
      Object.keys(sd).forEach(function(k){
        sseen[k] = true;
        if (sd[k] !== sprev[k]) {
          addEvent({ type:"shift", key:k, value:sd[k], prev:sprev[k] });
          sprev[k] = sd[k];
        }
      });
      var sdeletes = Object.keys(sprev).filter(function(k){ return !sseen[k]; });
      sdeletes.forEach(function(k){
        addEvent({ type:"shift", key:k, value:null, prev:sprev[k] });
        delete sprev[k];
      });
    }

    // --- state/main: merge si cambió algo del config ---
    if (g.state) {
      var patch = {};
      var changed = false;
      Object.keys(g.state).forEach(function(k){
        if (JSON.stringify(g.state[k]) !== JSON.stringify(lastSyncedState[k])) {
          patch[k] = g.state[k]; changed = true;
        }
      });
      if (changed) updateState(patch);
    }

    // --- expenses: diff por id ---
    if (g.expenses && g.expenses.length) {
      g.expenses.forEach(function(exp){
        if (!exp.id) exp.id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now()+"-"+Math.random().toString(36).slice(2,8));
        var prevExp = lastSyncedExpensesById[exp.id];
        if (!prevExp || JSON.stringify(prevExp) !== JSON.stringify(exp)) {
          if (!ready) { pendingOps.push(function(){ syncFromGlobals({expenses:[exp]}); }); return; }
          var doc = JSON.parse(JSON.stringify(exp));
          doc.createdBy = DB.auth.currentUser ? DB.auth.currentUser.uid : null;
          doc.updatedAt = DB.serverTimestamp();
          DB.setDoc(DB.doc(DB.db, "expenses", exp.id), doc, { merge: true })
            .catch(function(e){ console.error("expense write failed", e, doc); });
        }
      });
    }
  }

  // ─── archiveMonth (Fase 6 stub) ─────────────────────────────────────
  function archiveMonth(YYYYMM){
    if (!ready) { return Promise.reject(new Error("CayeSync not ready")); }
    // Implementación completa en Fase 6. Esta es la entrada de la API.
    console.warn("CayeSync.archiveMonth("+YYYYMM+") — stub Fase 2, implementación real en Fase 6");
    return Promise.resolve({ stub: true, month: YYYYMM });
  }

  // ─── diag() ─────────────────────────────────────────────────────────
  function diagSnapshot(){
    return {
      online: (typeof navigator!=="undefined" ? navigator.onLine : true),
      uid: ready && DB.auth.currentUser ? DB.auth.currentUser.uid : null,
      device: DEVICE,
      ready: ready,
      applyingRemoteSnapshot: applyingRemoteSnapshot,
      lastAddEventAt: diag.lastAddEventAt,
      lastStateSnapAt: diag.lastStateSnapAt,
      lastEventsSnapAt: diag.lastEventsSnapAt,
      lastExpensesSnapAt: diag.lastExpensesSnapAt,
      pendingEventCount: diag.pendingEventCount,
      eventsToday: diag.eventsToday.slice(),
      version: "v4.0"
    };
  }

  // ─── localStorage cache (snapshot completo state derivado) ──────────
  // Tras cada listener update, el HTML llamará a writeCache() con su snapshot.
  function writeCache(snapshot){
    try { localStorage.setItem("caye_v4_cache", JSON.stringify(snapshot)); }
    catch(e){ /* storage full */ }
  }
  function readCache(){
    try { var s = localStorage.getItem("caye_v4_cache"); return s ? JSON.parse(s) : null; }
    catch(e){ return null; }
  }

  // ─── Exporta API ────────────────────────────────────────────────────
  window.CayeSync = {
    addEvent: addEvent,
    updateState: updateState,
    archiveMonth: archiveMonth,
    diag: diagSnapshot,
    bootstrap: function(cb){ awaitDB(function(){ bootstrap(cb); }); },
    syncFromGlobals: syncFromGlobals,
    writeCache: writeCache,
    readCache: readCache,
    isReady: function(){ return ready; },
    waitForReady: function(cb){ awaitDB(cb); }
  };
})();
