# CayeDJB v5 — sistema simple

Control diario de paseos y boarding + facturación, sobre **Firebase Firestore**.
**Un solo HTML responsive** (`index.html`) sirve móvil y PC con el mismo URL.

- **Proyecto Firebase:** `cayedjb-3d151` (region `eur3`)
- **Auth:** anónimo
- **Hosting:** GitHub Pages
- **Rama:** `firebase-v5-simple`

---

## Modelo de datos (Firestore)

```
/dogs/{dogId}
  name: string          // "Pierre", "Old Coco"
  walkRate: number      // £ por paseo
  boardingRate: number  // £ por noche
  active: boolean

/walks/{YYYY-MM-DD}/dogs/{dogId}
  status: "walked" | "boarding"   // estado ÚNICO del día
  markedAt: timestamp
  markedBy: string                // uid (o "seed" para el histórico cargado)

/meta/main
  lastWrite: timestamp
  schemaVersion: 5
```

- `status` es un **estado único mutuamente excluyente**: un perro está `walked` o `boarding` ese día, nunca ambos.
- **Boarding gana sobre paseo**: si un perro se pasea y además se queda a dormir, cuenta como `boarding`.
- Un día **sin estado** = **no hay documento** (la app borra el doc al dejar el perro en vacío).
- **LWW nativo** vía `serverTimestamp()`: si dos dispositivos escriben a la vez, gana el último timestamp del servidor.
- Persistencia offline activada: las marcas hechas sin conexión se sincronizan al reconectar.

---

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La app completa (HOY · Factura · Perros) + **gate de PIN**. Único archivo para móvil y PC. |
| `firebase-config.js` | Claves públicas del Web App. **No tocar.** |
| `firestore.rules` | Security Rules v5 endurecidas (`dogs`, `walks`, `meta`). |
| `firebase.json` / `firestore.indexes.json` | Config de despliegue de reglas. |
| `seed.html` | Script **temporal** para cargar los datos iniciales (perros + walks abril/mayo). Borrar tras usar. |
| `scripts/backup_firestore.js` | Exporta toda la base a JSON (Admin SDK). Lo usa el workflow. |
| `scripts/restore_firestore.js` | Restaura la base desde un JSON. Manual, pide confirmación. |
| `package.json` | Dependencias de los scripts (`firebase-admin`). La app no necesita build. |
| `.github/workflows/firestore_backup.yml` | Backup automático semanal (lunes 03:00 UTC) a la rama `backups`. |

---

## Cómo desplegar

### App (GitHub Pages)
1. `git push` de la rama a publicar.
2. En GitHub Pages el sitio sirve `index.html` en la raíz → ese es el URL único (móvil y PC).

### Security Rules
Con [Firebase CLI](https://firebase.google.com/docs/cli) instalado y logueado:

```bash
firebase deploy --only firestore:rules --project cayedjb-3d151
```

(o pega el contenido de `firestore.rules` en la consola: Firestore → Rules → Publish).

---

## Cómo correr el seed (una sola vez)

Carga los 26 perros y el histórico de mayo 2026.

1. Asegúrate de que las **Security Rules v5 ya están desplegadas** (el seed escribe como usuario anónimo autenticado).
2. Abre `seed.html` servido desde el mismo origen que `firebase-config.js`
   (vía GitHub Pages, o `python3 -m http.server` en esta carpeta y abre `http://localhost:8000/seed.html`).
3. Espera al mensaje `✅ Auth OK`.
4. Pulsa **▶ Sembrar TODO** (perros + walks + meta).
5. Verifica en la consola de Firestore que existen `/dogs` (26) y `/walks/2026-05-01…30`.
6. **Borra `seed.html`** del repo para que nadie lo re-ejecute por error.

> ⚠️ El seed escribe por **overwrite** (un solo campo `status`, descarta `walked/boarding`
> antiguos). Re-ejecutarlo pisa con los valores del histórico cualquier marca hecha a mano
> sobre esas mismas fechas.

---

## Uso diario

### Pestaña HOY
- Lista alfabética de los perros **activos**, con la fecha de hoy por defecto.
- Cada perro tiene **✅ Paseado** y **🏠 Boarding**, que son **mutuamente excluyentes**
  (3 estados: vacío → ✅ → 🏠 → vacío):
  - Pulsar ✅ con boarding activo → pasa a *walked* (desactiva boarding).
  - Pulsar 🏠 con walked activo → pasa a *boarding* (desactiva walked).
  - Pulsar el botón ya activo → vuelve a **vacío** (borra el documento del día).
- Pulsar guarda **automáticamente** (optimista, con indicador “Guardando…→Guardado ✓”).
- Cambia la fecha arriba para corregir un día pasado.
- Por defecto todo en blanco; no se pre-rellena nada.

### Cómo facturar
1. Pestaña **Factura**.
2. Elige el perro, la fecha **Desde** y **Hasta** (por defecto, el mes actual).
3. Pulsa **Calcular**.
4. Verás: nº de paseos × tarifa, nº de boardings × tarifa, **TOTAL**, y el desglose de
   fechas exactas (paseos y boarding por separado).
5. **Sin overlap posible**: cada día cuenta como paseo *o* boarding (nunca ambos), porque
   el boarding tiene prioridad sobre el paseo.

### Cómo añadir / desactivar un perro
- Pestaña **Perros**.
- **Añadir:** nombre + £ paseo + £ noche → *Añadir perro*. El `dogId` se genera del nombre
  (minúsculas, sin acentos, espacios → `_`).
- **Editar tarifa:** *Editar* → cambia los importes → *Guardar*.
- **Eliminar (soft-delete):** *Eliminar* → confirma en el modal. **No borra el documento**:
  pone `active:false`. El perro sale de HOY y de la lista de activos, y pasa a la sección
  **Histórico** (colapsable, al final de la pestaña Perros).
- **Reactivar:** abre **Histórico** → *Reactivar*. Vuelve a HOY.
- Las facturas históricas de un perro eliminado se siguen pudiendo calcular (sale como
  *(inactivo)* en el selector de la pestaña Factura).

---

## PIN de entrada

Al abrir la app aparece un **gate de PIN** (pantalla "Introduce el PIN") antes de la app.

- PIN por defecto: **241333** (válidos 4 a 8 dígitos).
- Acertar guarda un flag en `sessionStorage` → no vuelve a pedirlo en esa sesión, pero
  **sí lo pide otra vez si se cierra el navegador** (no usa `localStorage`).
- 3 intentos fallidos seguidos → **bloqueo de 30 segundos**.
- El PIN **no se guarda en claro**: en `index.html` solo está su hash **SHA-256** y se compara
  el hash de lo tecleado. El gate es local al dispositivo+sesión: **no protege Firestore**
  (eso lo hacen Auth + Security Rules), solo evita que cualquiera con la URL abra la app.

### Cómo cambiar el PIN

1. Genera el hash SHA-256 (hex) del PIN nuevo. Opciones:
   - Terminal: `printf '%s' '1234' | shasum -a 256` (el primer campo es el hash).
   - O en la consola del navegador:
     ```js
     crypto.subtle.digest('SHA-256', new TextEncoder().encode('1234'))
       .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')));
     ```
2. En `index.html`, sustituye el valor de la constante `PIN_HASH` por el hash nuevo
   (busca `const PIN_HASH =`). No hace falta tocar nada más.
3. `git push` para publicar.

---

## Backups

Hay **dos** mecanismos, independientes:

### 1. Backup manual desde la app (rápido)
Pestaña **Perros** → **💾 Descargar backup JSON**. Descarga `cayedjb_AAAA-MM-DD.json` con
toda la base (perros + paseos + meta). Útil antes de tocar algo o como copia de bolsillo.

### 2. Backup automático semanal (GitHub Actions)
`.github/workflows/firestore_backup.yml` corre **cada lunes 03:00 UTC** (y se puede lanzar a
mano desde la pestaña **Actions → Firestore weekly backup → Run workflow**):
- Exporta `/dogs`, `/walks`, `/meta` con el Admin SDK (usa el secret
  `FIREBASE_SERVICE_ACCOUNT_JSON`).
- Hace commit de `backups/AAAA-MM-DD.json` en la rama **`backups`** (la crea si no existe).
- Conserva los **últimos 12** backups y borra los más antiguos.
- Si falla, **abre un issue** en el repo con el enlace al run.

### Cómo restaurar un backup
Necesitas Node 18+ y el JSON de la service account.

```bash
npm install   # solo la primera vez (instala firebase-admin)
FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
  node scripts/restore_firestore.js backups/2026-05-25.json
```

El script pide confirmación (hay que escribir `RESTAURAR`). Sobrescribe `dogs`/`walks`/`meta`
con el contenido del backup; **no borra** documentos que existan en producción y no estén en
el backup. Para bajar un backup concreto desde la rama `backups`:
`git show backups:backups/2026-05-25.json > 2026-05-25.json`.

---

## Si la app no carga / se comporta raro

1. **Hard refresh** (recarga forzada): `Cmd/Ctrl + Shift + R`.
2. **Re-pedir PIN / limpiar sesión:** en la consola del navegador (F12 → Console):
   `sessionStorage.clear()` y recarga. Esto borra el flag del PIN y los contadores de bloqueo.
3. **Mira la píldora de estado** (esquina superior derecha):
   - 🟢 **Conectado** — todo bien.
   - 🔵 **Guardando…** — escribiendo; espera a que pase a verde.
   - 🟡 **Offline** — sin conexión; las marcas quedan guardadas en local y se sincronizan al volver.
   - 🔴 **Error** — haz click para ver el detalle. Suele ser conexión o reglas.
4. Si sigue sin cargar, comprueba que las **Security Rules** estén publicadas (la app necesita
   Auth anónimo + permisos de lectura).

---

## Notas

- Pares que solían facturarse juntos (Balu&Maya, Lara&River) ahora van **separados a £32.40 c/u**.
  El hermano marca a ambos cuando los pasea juntos; si uno no va, marca solo el otro.
- Notificaciones Gmail (17:30 / 21:00) las gestiona Ignacio aparte; este repo no las toca.
