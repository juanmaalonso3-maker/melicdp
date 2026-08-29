/**
 * ═══════════════════════════════════════════════════════════════════════════
 * KENTA · CENTRAL DE PROMOCIONES — Backend completo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ARCHIVO ÚNICO. Reemplazá TODO el contenido de Código.gs por esto,
 * y si te quedó un archivo "Api" en el proyecto, BORRALO.
 * No puede haber dos doGet ni dos doPost.
 *
 * Los tokens ya guardados siguen ahí (viven en Script Properties),
 * así que no hace falta volver a autorizar.
 *
 * SYNC EN PARALELO (28-ago-2026): sincronizarTodo hacía ~300 llamadas HTTP una
 * atrás de otra y tardaba varios minutos. Ahora usa UrlFetchApp.fetchAll(), que
 * dispara lotes en paralelo, y cachea comisiones y costos de envío 7 días en la
 * hoja Cache (se crea sola). Quedan ~12 esperas en vez de ~300.
 *
 * VENTANA DE LAS RELÁMPAGO (28-ago-2026): la fila del ítem no trae la ventana
 * de una oferta relámpago. Vive en el listado de ítems de la campaña, con hora
 * exacta ("2026-08-31T00:00:00" a "2026-08-31T11:59:59"). Ahora se pide y se
 * completa. Ver 5.4b.
 *
 * DESPUÉS DE PEGAR:
 *   1. Guardá (Ctrl+S)
 *   2. Ejecutá  diagnostico   → tiene que loguear tu user_id y /users/me
 *   3. Ejecutá  sincronizarTodo
 *   4. Ejecutá  instalarTriggers   (una sola vez)
 *   5. Implementar → Administrar implementaciones → lápiz → Versión nueva
 * ═══════════════════════════════════════════════════════════════════════════
 */


/* ═══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const ML = {
  // Rotá este secret en devcenter cuando puedas: quedó expuesto en un chat.
  CLIENT_ID:     '5705886087448083',
  CLIENT_SECRET: 'Adtq2wuy9HRcVIpPenXjzSefmSa5D38p',
  REDIRECT_URI:  'https://script.google.com/macros/s/AKfycbzJWehK2wLID5hkB6fGLj_s57yIv04KBL5t-Runt7shM0McosTczc715L9KTPIfW4dc/exec',
  AUTH_HOST:     'https://auth.mercadolibre.com.ar',
  API_HOST:      'https://api.mercadolibre.com'
};

const SHEET_ID  = '1bx8I0r-AEBxvjNSGkDn1JKaM8fRHQq8hiewfe5jMT_c';
const CLAVE_APP = 'kenta-cdp-2026';        // ← poné una frase tuya
const TZ        = 'America/Argentina/Buenos_Aires';

const P = PropertiesService.getScriptProperties();


/* ═══════════════════════════════════════════════════════════════════════════
   2 · AUTORIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function paso1_autorizar() {
  const state = Utilities.getUuid();
  P.setProperty('ML_OAUTH_STATE', state);
  const url = ML.AUTH_HOST + '/authorization?response_type=code'
    + '&client_id='    + encodeURIComponent(ML.CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(ML.REDIRECT_URI)
    + '&state='        + encodeURIComponent(state);
  Logger.log('\nABRÍ ESTE LINK Y APROBÁ CON KENTAOFICIAL (cuenta principal):\n\n' + url + '\n');
  return url;
}

function _canjearCode(code) {
  const r = UrlFetchApp.fetch(ML.API_HOST + '/oauth/token', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    headers: { accept: 'application/json' },
    payload: {
      grant_type: 'authorization_code', client_id: ML.CLIENT_ID,
      client_secret: ML.CLIENT_SECRET, code: code, redirect_uri: ML.REDIRECT_URI
    },
    muteHttpExceptions: true
  });
  const b = JSON.parse(r.getContentText());
  if (r.getResponseCode() !== 200)
    throw new Error('oauth ' + r.getResponseCode() + ' — ' + (b.error_description || r.getContentText()));
  _guardarTokens(b);
  return b;
}

function _guardarTokens(t) {
  // El refresh_token es de UN SOLO USO: guardar el nuevo siempre, en la misma corrida.
  P.setProperties({
    ML_ACCESS_TOKEN:  t.access_token,
    ML_REFRESH_TOKEN: t.refresh_token,
    ML_USER_ID:       String(t.user_id),
    ML_EXPIRA_EN:     String(Date.now() + (t.expires_in - 600) * 1000)
  }, false);
}

function getToken() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tok = P.getProperty('ML_ACCESS_TOKEN');
    if (tok && Date.now() < Number(P.getProperty('ML_EXPIRA_EN') || 0)) return tok;
    return _refrescar();
  } finally { lock.releaseLock(); }
}

function _refrescar() {
  const rt = P.getProperty('ML_REFRESH_TOKEN');
  if (!rt) throw new Error('No hay refresh_token. Corré paso1_autorizar.');
  const r = UrlFetchApp.fetch(ML.API_HOST + '/oauth/token', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    headers: { accept: 'application/json' },
    payload: {
      grant_type: 'refresh_token', client_id: ML.CLIENT_ID,
      client_secret: ML.CLIENT_SECRET, refresh_token: rt
    },
    muteHttpExceptions: true
  });
  const b = JSON.parse(r.getContentText());
  if (r.getResponseCode() !== 200)
    throw new Error('refresh ' + r.getResponseCode() + ' — ' + (b.error_description || r.getContentText()) +
                    ' · si dice invalid_grant, corré paso1_autorizar de nuevo.');
  _guardarTokens(b);
  return b.access_token;
}

function refrescarTokenProgramado() {
  try { _refrescar(); Logger.log('Token refrescado OK'); }
  catch (e) { Logger.log('FALLÓ refresh: ' + e); }
}


/* ═══════════════════════════════════════════════════════════════════════════
   3 · CLIENTE HTTP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Meli es inconsistente: algunos endpoints devuelven un array pelado y otros
 * un objeto {results:[...]}. Esto normaliza las dos formas.
 */
function _arr(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.results))    return x.results;
  if (x && Array.isArray(x.promotions)) return x.promotions;
  return [];
}

/**
 * Meli manda algunas fechas sin huso horario ("2026-08-31T11:59:59") y otras
 * con él. Las sueltas son hora de Argentina: se les pega el -03:00 para que el
 * navegador no las interprete según dónde esté abierto.
 */
function _fechaAR(v) {
  if (!v) return '';
  const s = String(v);
  return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + '-03:00';
}

function mlGet(path, intento) {
  intento = intento || 1;
  const r = UrlFetchApp.fetch(ML.API_HOST + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + getToken(), accept: 'application/json' },
    muteHttpExceptions: true
  });
  const c = r.getResponseCode();
  if (c === 200) return JSON.parse(r.getContentText());
  if ((c === 401 || c === 429 || c === 423) && intento <= 3) {
    if (c === 401) P.setProperty('ML_EXPIRA_EN', '0');
    Utilities.sleep(1200 * intento);
    return mlGet(path, intento + 1);
  }
  throw new Error('GET ' + path + ' -> ' + c + ' ' + r.getContentText().slice(0, 300));
}

/**
 * Cuántas llamadas en paralelo por lote.
 *
 * Con 162 publicaciones: 25 son 7 vueltas (~9 s), 40 son 5 (~6 s). Más alto va
 * más rápido pero araña el rate limit de Meli. Si empezás a ver 429 en el log,
 * bajalo; mlGetMuchos reintenta solo las que fallan, así que el riesgo es
 * perder tiempo, no datos.
 */
const LOTE = 40;

/**
 * Pide muchas rutas a la vez. Devuelve {ruta: datos}, con la ruta ausente si esa
 * llamada falló — el que llama decide qué hacer con el hueco.
 *
 * Es la diferencia entre esperar 300 veces medio segundo y esperar 12 veces:
 * UrlFetchApp.fetchAll() dispara todo el lote junto y espera al más lento.
 * Los 429 (rate limit) y 401 (token vencido) se reintentan solo con las rutas
 * que fallaron, no con el lote entero.
 */
function mlGetMuchos(rutas, intento) {
  intento = intento || 1;
  const salida = {}, fallaron = [];
  const token  = getToken();          // una sola vez para todo el lote

  for (var i = 0; i < rutas.length; i += LOTE) {
    const tanda = rutas.slice(i, i + LOTE);
    const reqs  = tanda.map(function (p) {
      return {
        url: ML.API_HOST + p, method: 'get',
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
        muteHttpExceptions: true
      };
    });

    var res;
    try { res = UrlFetchApp.fetchAll(reqs); }
    catch (e) { tanda.forEach(function (p) { fallaron.push(p); }); continue; }

    res.forEach(function (r, k) {
      const c = r.getResponseCode();
      if (c === 200) {
        try { salida[tanda[k]] = JSON.parse(r.getContentText()); }
        catch (e) { fallaron.push(tanda[k]); }
      } else if (c === 401 || c === 429 || c === 423) {
        if (c === 401) P.setProperty('ML_EXPIRA_EN', '0');
        fallaron.push(tanda[k]);
      }
      // Cualquier otro código (404, 403) es una respuesta legítima de "no hay":
      // no se reintenta, queda como hueco.
    });

    if (i + LOTE < rutas.length) Utilities.sleep(120);   // respiro entre lotes
  }

  if (fallaron.length && intento <= 2) {
    Utilities.sleep(1500 * intento);
    const seg = mlGetMuchos(fallaron, intento + 1);
    Object.keys(seg).forEach(function (k) { salida[k] = seg[k]; });
  }
  return salida;
}

/**
 * Comisión de venta para un precio, categoría y tipo de publicación.
 * Devuelve el monto en pesos, o null si el endpoint no responde.
 */
function _comision(precio, categoria, listingType) {
  try {
    const r = mlGet('/sites/MLA/listing_prices?price=' + precio +
                    '&category_id=' + encodeURIComponent(categoria));
    const arr = _arr(r).length ? _arr(r) : (Array.isArray(r) ? r : [r]);
    const m = arr.filter(function (x) { return x.listing_type_id === listingType; })[0];
    return m && m.sale_fee_amount != null ? m.sale_fee_amount : null;
  } catch (e) { return null; }
}

function _mlEscribir(metodo, path, body, intento) {
  intento = intento || 1;
  const opt = {
    method: metodo,
    headers: { Authorization: 'Bearer ' + getToken(), accept: 'application/json' },
    muteHttpExceptions: true
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(ML.API_HOST + path, opt);
  const c = r.getResponseCode(), texto = r.getContentText();
  if ((c === 423 || c === 429 || c === 401) && intento <= 3) {
    if (c === 401) P.setProperty('ML_EXPIRA_EN', '0');
    Utilities.sleep(1500 * intento);
    return _mlEscribir(metodo, path, body, intento + 1);
  }
  var parsed = null; try { parsed = JSON.parse(texto); } catch (e) {}
  return { ok: c >= 200 && c < 300, code: c, texto: texto.slice(0, 400), body: parsed };
}


/* ═══════════════════════════════════════════════════════════════════════════
   4 · ENTRADA HTTP
   ═══════════════════════════════════════════════════════════════════════════ */

function doGet(e) {
  const q = (e && e.parameter) || {};

  if (q.code) {
    try {
      const esp = P.getProperty('ML_OAUTH_STATE');
      if (!esp || q.state !== esp) return _pag('State inválido', 'Corré paso1_autorizar de nuevo.');
      const t = _canjearCode(q.code);
      P.deleteProperty('ML_OAUTH_STATE');
      return _pag('Conectado', 'Tokens guardados para el usuario ' + t.user_id + '.');
    } catch (err) { return _pag('Falló el canje', String(err)); }
  }
  if (q.error) return _pag(q.error, q.error_description || '');

  if (q.accion === 'datos') {
    if (q.clave !== CLAVE_APP) return _json({ ok: false, error: 'clave_invalida' });
    try { return _json({ ok: true, data: leerSnapshot() }); }
    catch (err) { return _json({ ok: false, error: String(err) }); }
  }
  return _json({ ok: true, servicio: 'kenta-cdp', version: 1 });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}

  // Webhook de Meli
  if (body.topic) {
    try {
      _hoja('Notificaciones', ['recibido','topic','resource','user_id','application_id','sent','attempts'])
        .appendRow([new Date(), body.topic, body.resource || '', body.user_id || '',
                    body.application_id || '', body.sent || '', body.attempts || '']);
    } catch (err) { Logger.log('webhook: ' + err); }
    return ContentService.createTextOutput('OK');
  }

  if (body.clave !== CLAVE_APP) return _json({ ok: false, error: 'clave_invalida' });
  try {
    switch (body.accion) {
      case 'datos': return _json({ ok: true, data: leerSnapshot() });
      case 'sync':  return _json({ ok: true, data: sincronizarTodo() });
      case 'sku':   return _json({ ok: true, data: refrescarSku(body.sku) });
      case 'etiqueta': return _json({ ok: true, data: guardarEtiqueta(body.item_ids || body.item_id, body.texto) });
      case 'etiquetas': return _json({ ok: true, data: (body.lote || []).map(function (x) {
                          return guardarEtiqueta(x.item_ids, x.texto); }) });
      case 'sumar': return _json({ ok: true, data: sumarAPromo(body) });
      case 'salir': return _json({ ok: true, data: salirDePromo(body) });
      case 'lote':  return _json({ ok: true, data: ejecutarLote(body.acciones || []) });
      default:      return _json({ ok: false, error: 'accion_desconocida' });
    }
  } catch (err) { return _json({ ok: false, error: String(err.message || err) }); }
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function _pag(t, c) {
  return HtmlService.createHtmlOutput(
    '<div style="font:16px/1.6 system-ui;max-width:520px;margin:60px auto;padding:0 20px">' +
    '<h2>' + t + '</h2><p>' + c + '</p></div>');
}


/* ═══════════════════════════════════════════════════════════════════════════
   5 · SINCRONIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Caché de costos ────────────────────────────────────────────────────────
   La comisión de una combinación categoría+tipo y el costo de envío de un SKU
   no cambian de un día para el otro. Guardarlos saca ~130 llamadas de cada
   sincronización. Se recalculan solos a los 7 días. */

const CACHE_DIAS = 7;

/** Tipos cuya ventana se define por publicación y no por campaña: hay que
 *  pedirla al listado de ítems de la campaña. La relámpago es el caso típico
 *  —sale un día, unas horas— y la oferta del día funciona igual. */
const VENTANA_POR_ITEM = ['LIGHTNING', 'DOD'];

function _cacheLeer() {
  const sh = _hoja('Cache', ['clave', 'valor', 'calculado']);
  const m = {};
  if (sh.getLastRow() < 2) return m;
  const corte = Date.now() - CACHE_DIAS * 864e5;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (!r[0]) return;
    const t = new Date(r[2]).getTime();
    if (isNaN(t) || t < corte) return;               // vencido: se ignora
    try { m[String(r[0])] = JSON.parse(r[1]); } catch (e) {}
  });
  return m;
}

function _cacheGuardar(m) {
  const sh = _hoja('Cache', ['clave', 'valor', 'calculado']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  const ahora = new Date();
  const filas = Object.keys(m).map(function (k) { return [k, JSON.stringify(m[k]), ahora]; });
  if (filas.length) sh.getRange(2, 1, filas.length, 3).setValues(filas);
}

/** Vacía el caché a mano. Correlo si Meli te cambió una comisión o una tarifa
 *  de envío y no querés esperar los 7 días. */
function limpiarCacheCostos() {
  const sh = _hoja('Cache', ['clave', 'valor', 'calculado']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  Logger.log('Caché de costos vaciado. La próxima sync recalcula todo.');
}


function sincronizarTodo() {
  const t0  = Date.now();
  const uid = P.getProperty('ML_USER_ID');
  if (!uid) throw new Error('Sin user_id. Corré paso1_autorizar.');
  const marca = {};                       // segundos por etapa, para el log
  const paso  = function (n) { marca[n] = Math.round((Date.now() - t0) / 1000); };

  // 5.1 · Campañas abiertas (las tarjetas de la CDP, con su vencimiento)
  // Ojo: este endpoint devuelve un objeto {results:[...]}, no un array pelado.
  // Acá viven las fechas de las campañas SMART, que NO bajan al ítem: el front
  // las cruza por promo_id para poder ubicarlas en el calendario.
  var camps = [];
  try {
    const raw = mlGet('/seller-promotions/users/' + uid + '?app_version=v2');
    camps = _arr(raw);
    Logger.log('campañas: ' + camps.length);
  } catch (err) { Logger.log('campañas: ' + err); }

  _volcarHoja('Campanias',
    ['promo_id','tipo','nombre','status','inicio','fin','vence_aceptacion','beneficio','meli_%','seller_%'],
    camps.map(function (c) {
      const b = c.benefits || {};
      return [c.id || '', c.type || '', c.name || '', c.status || '',
              c.start_date || '', c.finish_date || '', c.deadline_date || '',
              b.type || '', b.meli_percent != null ? b.meli_percent : '',
              b.seller_percent != null ? b.seller_percent : ''];
    }));
  paso('campanias');

  // 5.2 · Publicaciones activas
  // El scan es secuencial por diseño: cada página depende del scroll_id anterior.
  const ids = [];
  var scroll = null, v = 0;
  do {
    const r = mlGet('/users/' + uid + '/items/search?status=active&search_type=scan&limit=100' +
                    (scroll ? '&scroll_id=' + encodeURIComponent(scroll) : ''));
    (r.results || []).forEach(function (x) { ids.push(x); });
    scroll = r.scroll_id; v++;
  } while (scroll && ids.length && v < 30);
  paso('scan');

  // 5.3 · Atributos y condiciones de venta, en paralelo
  const rutasItems = [];
  for (var i = 0; i < ids.length; i += 20) {
    rutasItems.push('/items?ids=' + ids.slice(i, i + 20).join(',') +
      '&attributes=id,title,price,available_quantity,sold_quantity,listing_type_id,' +
      'category_id,permalink,thumbnail,seller_custom_field,shipping,catalog_listing,' +
      'status,health,sale_terms,tags');
  }
  const info = {};
  const resItems = mlGetMuchos(rutasItems);
  Object.keys(resItems).forEach(function (ruta) {
    (resItems[ruta] || []).forEach(function (w) {
      if (w.code !== 200 || !w.body) return;
      const b = w.body;
      // Las cuotas viven en sale_terms, pero no siempre con la misma clave: el
      // dato bueno es INSTALLMENTS_CAMPAIGN ("6x_campaign"), y hay otros
      // términos cuyo nombre también dice "cuotas". El código viejo hacía
      // cuotas = s.value_name en cada coincidencia, así que un término posterior
      // con value_name vacío borraba el valor bueno y la publicación aparecía
      // como Contado. Ahora se elige por prioridad y nunca se pisa con vacío.
      var cuotas = '', prioCuotas = 0;
      (b.sale_terms || []).forEach(function (s) {
        const v = String(s.value_name || '').trim();
        if (!v) return;
        const id = String(s.id || ''), nom = String(s.name || '');
        var prio = 0;
        if (id === 'INSTALLMENTS_CAMPAIGN') prio = 3;                 // el canónico
        else if (/installment|cuota/i.test(id + ' ' + nom)) prio = /\d/.test(v) ? 2 : 1;
        if (prio > prioCuotas) { cuotas = v; prioCuotas = prio; }
      });
      // Respaldo: la campaña de cuotas también viaja en tags (["3x_campaign",
      // "catalog_boost", ...]). Es el mismo dato por otra puerta, y sirve si
      // alguna vez sale_terms no viene completo.
      if (!cuotas) {
        (b.tags || []).forEach(function (t) {
          const m = String(t).match(/^(\d+)x_campaign$/);
          if (m) cuotas = String(t);
        });
      }
      info[b.id] = {
        titulo: b.title || '', sku: b.seller_custom_field || '', precio: b.price,
        stock: b.available_quantity, tipo: b.listing_type_id || '',
        cat: b.category_id || '',
        link: b.permalink || '', foto: b.thumbnail || '',
        envioGratis: !!(b.shipping && b.shipping.free_shipping),
        catalogo: b.catalog_listing === true, cuotas: cuotas
      };
    });
  });
  paso('items');

  // 5.3b · COSTOS — para poder mostrar "Recibís"
  const cache = _cacheLeer();
  var golpes = 0, nuevos = 0;

  // La comisión depende de categoría + tipo de publicación, y dentro de una misma
  // combinación es lineal: comisión = pct·precio + fijo. Medido en la Freidora
  // (MLA456045): gold_pro 26,80% y gold_special 14,50%, ambos con fijo 0.
  // Se piden dos precios distintos para despejar las dos incógnitas.
  const combos = {};
  Object.keys(info).forEach(function (id) {
    const m = info[id], k = m.cat + '|' + m.tipo;
    if (!combos[k]) combos[k] = { cat: m.cat, tipo: m.tipo, precio: m.precio || 10000 };
  });

  const faltanCom = [], rutasCom = [];
  Object.keys(combos).forEach(function (k) {
    const guardado = cache['com|' + k];
    if (guardado) { combos[k].pct = guardado.pct; combos[k].fijo = guardado.fijo; golpes++; return; }
    const c = combos[k];
    c.p1 = Math.max(200, Math.round(c.precio));
    c.p2 = Math.max(100, Math.round(c.precio * 0.5));
    c.r1 = '/sites/MLA/listing_prices?price=' + c.p1 + '&category_id=' + encodeURIComponent(c.cat);
    c.r2 = '/sites/MLA/listing_prices?price=' + c.p2 + '&category_id=' + encodeURIComponent(c.cat);
    faltanCom.push(k); rutasCom.push(c.r1); rutasCom.push(c.r2);
  });

  if (rutasCom.length) {
    const resCom = mlGetMuchos(rutasCom);
    const fee = function (r, tipo) {
      if (!r) return null;
      const arr = _arr(r).length ? _arr(r) : (Array.isArray(r) ? r : [r]);
      const m = arr.filter(function (x) { return x.listing_type_id === tipo; })[0];
      return m && m.sale_fee_amount != null ? m.sale_fee_amount : null;
    };
    faltanCom.forEach(function (k) {
      const c = combos[k];
      const f1 = fee(resCom[c.r1], c.tipo), f2 = fee(resCom[c.r2], c.tipo);
      if (f1 != null && f2 != null && c.p1 !== c.p2) {
        c.pct  = (f1 - f2) / (c.p1 - c.p2);
        c.fijo = f1 - c.pct * c.p1;
        cache['com|' + k] = { pct: c.pct, fijo: c.fijo };
        nuevos++;
      }
    });
  }
  Logger.log('combos de comisión: ' + Object.keys(combos).length +
             ' (del caché: ' + golpes + ')');
  paso('comisiones');

  // El envío gratis lo paga el vendedor. Depende del producto físico, así que
  // se consulta una vez por SKU y no una por publicación.
  const porSku = {}, rutasEnv = [], claveEnv = {};
  Object.keys(info).forEach(function (id) {
    const m = info[id];
    if (!m.envioGratis) { m.envio = 0; return; }
    const k = m.sku || id;
    if (porSku[k] !== undefined) return;
    const guardado = cache['env|' + k];
    if (guardado != null) { porSku[k] = guardado; golpes++; return; }
    porSku[k] = null;
    const ruta = '/users/' + uid + '/shipping_options/free?item_id=' + id;
    rutasEnv.push(ruta); claveEnv[ruta] = k;
  });

  if (rutasEnv.length) {
    const resEnv = mlGetMuchos(rutasEnv);
    Object.keys(claveEnv).forEach(function (ruta) {
      const s = resEnv[ruta];
      const costo = (s && s.coverage && s.coverage.all_country &&
                     s.coverage.all_country.list_cost) || 0;
      porSku[claveEnv[ruta]] = costo;
      cache['env|' + claveEnv[ruta]] = costo;
      nuevos++;
    });
  }
  Object.keys(info).forEach(function (id) {
    const m = info[id];
    if (m.envio === 0) return;                       // sin envío gratis: ya está en 0
    m.envio = porSku[m.sku || id] || 0;
  });
  _cacheGuardar(cache);
  paso('envios');

  // 5.4 · Promociones por ítem, en paralelo.
  // Acá estaba el grueso del tiempo: una llamada por publicación, en fila india.
  const rutasPromo = ids.map(function (id) {
    return '/seller-promotions/items/' + id + '?app_version=v2';
  });
  const resPromo = mlGetMuchos(rutasPromo);
  paso('promos');

  // 5.4b · Ventanas que solo viven en la campaña.
  //
  // Una oferta relámpago dura unas horas y su ventana NO baja a la fila del
  // ítem: /seller-promotions/items/{id} devuelve la promo sin ninguna fecha.
  // Está en el listado de ítems de la campaña, con hora exacta:
  //
  //   {"id":"MLA2800121362","start_date":"2026-08-31T00:00:00",
  //    "finish_date":"2026-08-31T11:59:59","status":"pending","price":110000}
  //
  // Sin esto la app no puede saber cuándo la relámpago pasa a mandar en la
  // vidriera, y al ser la más barata se ponía primera todo el tiempo.
  //
  // Solo se piden los tipos cuya ventana es por ítem. Las SMART no entran acá:
  // su fecha es la de la campaña y ya está en la hoja Campanias.
  const ventanas = {};
  // Ojo con el limit: este endpoint rechaza cualquier valor de 50 o más
  // ("limit must be lower than 50"), pero SIN el parámetro devuelve la tanda
  // completa. Así que la primera vuelta va pelada y solo se pagina si hace
  // falta, con searchAfter si lo ofrece y con offset si no.
  camps.filter(function (c) { return VENTANA_POR_ITEM.indexOf(String(c.type)) >= 0; })
    .forEach(function (c) {
      var token = null, vistos = 0, total = null, vueltas = 0, lote = [];
      do {
        var ruta = '/seller-promotions/promotions/' + c.id + '/items?promotion_type=' +
                   encodeURIComponent(c.type) + '&app_version=v2';
        if (token)      ruta += '&searchAfter=' + encodeURIComponent(token);
        else if (vistos) ruta += '&limit=49&offset=' + vistos;

        var r;
        try { r = mlGet(ruta); } catch (e) { Logger.log('ventanas ' + c.id + ': ' + e); break; }

        lote = _arr(r);
        lote.forEach(function (x) {
          if (!x || !x.id) return;
          if (!x.start_date && !x.finish_date) return;
          ventanas[c.id + '|' + x.id] = [_fechaAR(x.start_date), _fechaAR(x.finish_date)];
        });
        vistos += lote.length;
        if (r && r.paging && r.paging.total != null) total = r.paging.total;
        token = (r && r.paging && (r.paging.searchAfter || r.paging.search_after)) || null;
        vueltas++;
      } while (lote.length && (token || (total != null && vistos < total)) && vueltas < 20);
      Logger.log('  ' + c.type + ' ' + c.id + ': ' + vistos + ' ítems leídos');
    });
  Logger.log('ventanas por ítem completadas: ' + Object.keys(ventanas).length);
  paso('ventanas');

  const filas = [];
  var errores = 0;
  ids.forEach(function (id) {
    const ruta = '/seller-promotions/items/' + id + '?app_version=v2';
    if (resPromo[ruta] === undefined) { errores++; return; }
    const promos = _arr(resPromo[ruta]);
    const m  = info[id] || {};
    const cc = combos[m.cat + '|' + m.tipo] || {};
    promos.forEach(function (p) {
      // Si la promo no trae fecha propia, se usa la ventana de la campaña.
      const w = ventanas[String(p.id) + '|' + id] || ['', ''];
      filas.push([
        id, m.sku || '', m.titulo || '', m.precio || '', m.stock || '',
        m.tipo || '', m.cuotas || '', m.envioGratis ? 'SI' : 'NO', m.catalogo ? 'SI' : 'NO',
        m.link || '', m.foto || '',
        p.type || '', p.id || '', p.name || '', p.status || '',
        p.price != null ? p.price : '',
        p.original_price != null ? p.original_price : '',
        p.max_discounted_price != null ? p.max_discounted_price : '',
        p.min_discounted_price != null ? p.min_discounted_price : '',
        p.suggested_discounted_price != null ? p.suggested_discounted_price : '',
        p.meli_percentage != null ? p.meli_percentage : '',
        p.seller_percentage != null ? p.seller_percentage : '',
        p.boosted_offer === true ? 'SI' : '',
        p.total_price_for_boosted_offer != null ? p.total_price_for_boosted_offer : '',
        p.start_date  || w[0] || '',
        p.finish_date || w[1] || '',
        // Ojo: no concatenar "min-max" en una celda. Sheets lo interpreta como
        // fecha ("5-22" -> 22 de mayo). Van en dos columnas numéricas.
        (p.stock && p.stock.min != null) ? p.stock.min : '',
        (p.stock && p.stock.max != null) ? p.stock.max : '',
        p.sub_type || '',
        p.fixed_amount != null ? p.fixed_amount : '',
        p.fixed_percentage != null ? p.fixed_percentage : '',
        // Costos, para el "Recibís" del front
        cc.pct  != null ? cc.pct  : '',
        cc.fijo != null ? cc.fijo : '',
        m.envio != null ? m.envio : ''
      ]);
    });
  });

  // precio_vidriera es el price que devuelve /items: cuando hay una promo activa
  // ya viene con el descuento aplicado. El precio de lista real es original_price.
  _volcarHoja('Datos',
    ['item_id','sku','titulo','precio_vidriera','stock','listing_type','cuotas','envio_gratis',
     'catalogo','link','foto','promo_tipo','promo_id','promo_nombre','status','precio_promo',
     'original_price','max_disc','min_disc','sugerido','meli_%','seller_%','boost','precio_boost',
     'inicio','fin','stock_min','stock_max','sub_type','monto_fijo','pct_fijo',
     'com_pct','com_fijo','envio_costo'], filas);
  paso('escritura');

  // 5.5 · Histórico diario — alimenta el reloj de credibilidad
  const hoy = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const activos = {};
  filas.forEach(function (f) {
    if (f[14] === 'started' && f[15]) {
      if (!activos[f[0]] || f[15] < activos[f[0]]) activos[f[0]] = f[15];
    }
  });
  const hist = _hoja('Historico', ['fecha','item_id','precio_lista','con_oferta','precio_oferta']);
  var yaHoy = false;
  if (hist.getLastRow() > 1) {
    yaHoy = hist.getRange(2, 1, hist.getLastRow() - 1, 1).getValues().some(function (r) {
      return Utilities.formatDate(new Date(r[0]), TZ, 'yyyy-MM-dd') === hoy ||
             String(r[0]).slice(0, 10) === hoy;
    });
  }
  if (!yaHoy && ids.length) {
    const nuevas = ids.map(function (id) {
      const m = info[id] || {};
      return [hoy, id, m.precio || '', activos[id] ? 'SI' : 'NO', activos[id] || ''];
    });
    hist.getRange(hist.getLastRow() + 1, 1, nuevas.length, 5).setValues(nuevas);
  }

  const res = {
    ok: true, cuando: new Date().toISOString(), publicaciones: ids.length,
    campanias: camps.length, filas: filas.length, errores: errores,
    cacheUsado: golpes, cacheNuevo: nuevos,
    segundos: Math.round((Date.now() - t0) / 1000),
    etapas: marca
  };
  P.setProperty('ULTIMA_SYNC', JSON.stringify(res));
  Logger.log(JSON.stringify(res));
  return res;
}


/* ═══════════════════════════════════════════════════════════════════════════
   6 · LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

function leerSnapshot() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const datos = _leerHoja(ss, 'Datos');
  const camps = _leerHoja(ss, 'Campanias');
  // El Histórico crece 162 filas por día y el reloj solo mira los últimos días:
  // leerlo entero hacía que cada carga fuera más lenta que la anterior.
  const hist  = _leerUltimas(ss, 'Historico', 4000);
  const log   = _leerUltimas(ss, 'Log', 80);

  // Reloj: días consecutivos sin oferta, del más reciente hacia atrás.
  const porItem = {};
  hist.forEach(function (h) { (porItem[h.item_id] = porItem[h.item_id] || []).push(h); });
  const reloj = {};
  Object.keys(porItem).forEach(function (id) {
    const serie = porItem[id].sort(function (a, b) {
      return String(b.fecha).localeCompare(String(a.fecha));
    });
    var dias = 0;
    for (var i = 0; i < serie.length; i++) {
      if (String(serie[i].con_oferta) === 'NO') dias++; else break;
    }
    reloj[id] = { diasSinOferta: dias, muestras: serie.length };
  });

  // Etiquetas de cuotas puestas a mano: la API no expone ese dato.
  const etiquetas = {};
  _leerHoja(ss, 'Etiquetas').forEach(function (e) {
    if (e.item_id) etiquetas[String(e.item_id)] = String(e.etiqueta || '');
  });

  return {
    generado: new Date().toISOString(),
    ultimaSync: JSON.parse(P.getProperty('ULTIMA_SYNC') || '{}'),
    datos: datos, campanias: camps, reloj: reloj, log: log, etiquetas: etiquetas
  };
}

/** Como _leerHoja pero solo las últimas n filas. */
function _leerUltimas(ss, nombre, n) {
  const sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 2) return [];
  const ancho = sh.getLastColumn();
  const cab   = sh.getRange(1, 1, 1, ancho).getValues()[0];
  const total = sh.getLastRow() - 1;
  const cuantas = Math.min(n, total);
  const desde = 2 + total - cuantas;
  return sh.getRange(desde, 1, cuantas, ancho).getValues().map(function (r) {
    const o = {}; cab.forEach(function (c, i) { o[c] = r[i]; }); return o;
  });
}

function _leerHoja(ss, nombre) {
  const sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues(), cab = v[0];
  return v.slice(1).map(function (r) {
    const o = {}; cab.forEach(function (c, i) { o[c] = r[i]; }); return o;
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   7 · ESCRITURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Vuelve a leer UN ítem de Meli y actualiza solo sus filas en la hoja.
 *
 * Por qué existe: después de sumarse o salirse de una campaña, la app pedía el
 * snapshot entero de nuevo — 1320 filas, el histórico y el log completos, todo
 * serializado y bajado otra vez. Eso son varios segundos por click, y el ítem
 * que cambió es uno solo. Esto refresca ese ítem con una llamada a Meli y una
 * escritura acotada, y le devuelve al front las filas nuevas para que parche en
 * memoria sin recargar nada.
 *
 * Devuelve las filas como objetos (mismas columnas que la hoja) o null si no
 * pudo, en cuyo caso el front recarga como antes.
 */
function _refrescarItem(id) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('Datos');
  if (!sh || sh.getLastRow() < 2) return null;

  const ancho = sh.getLastColumn();
  const col   = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var ini = -1, fin = -1;
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) === String(id)) { if (ini < 0) ini = i; fin = i; }
  }
  if (ini < 0) return null;

  const viejas = sh.getRange(2 + ini, 1, fin - ini + 1, ancho).getValues();
  const base   = viejas[0];      // columnas del ítem: título, sku, costos, etc.

  var promos;
  try { promos = _arr(mlGet('/seller-promotions/items/' + id + '?app_version=v2')); }
  catch (e) { Logger.log('refrescar ' + id + ': ' + e); return null; }

  // La ventana de una relámpago no baja al ítem: se pide solo si falta.
  const ventanas = {};
  promos.forEach(function (p) {
    if (p.start_date || VENTANA_POR_ITEM.indexOf(String(p.type)) < 0) return;
    try {
      _arr(mlGet('/seller-promotions/promotions/' + p.id + '/items?promotion_type=' +
                 encodeURIComponent(p.type) + '&app_version=v2')).forEach(function (x) {
        if (x && String(x.id) === String(id) && (x.start_date || x.finish_date))
          ventanas[String(p.id)] = [_fechaAR(x.start_date), _fechaAR(x.finish_date)];
      });
    } catch (e) {}
  });

  const nuevas = promos.map(function (p) {
    return _filaPromo(base, p, ventanas[String(p.id)] || ['', '']);
  });

  // Normalmente la cantidad de promos no cambia —sumarse solo mueve el status—
  // así que casi siempre es una sola escritura en el mismo lugar.
  if (nuevas.length === viejas.length) {
    sh.getRange(2 + ini, 1, nuevas.length, ancho).setValues(nuevas);
  } else if (nuevas.length < viejas.length) {
    if (nuevas.length) sh.getRange(2 + ini, 1, nuevas.length, ancho).setValues(nuevas);
    sh.deleteRows(2 + ini + nuevas.length, viejas.length - nuevas.length);
  } else {
    sh.insertRowsAfter(2 + fin, nuevas.length - viejas.length);
    sh.getRange(2 + ini, 1, nuevas.length, ancho).setValues(nuevas);
  }

  const cab = sh.getRange(1, 1, 1, ancho).getValues()[0];
  return nuevas.map(function (r) {
    const o = {}; cab.forEach(function (c, i) { o[c] = r[i]; }); return o;
  });
}

/**
 * Refresca TODAS las publicaciones de un SKU de una vez.
 *
 * El sync completo recorre las 162 publicaciones de la cuenta y tarda ~15 s.
 * Pero trabajando de a un producto, las que importan son las 10 de ese SKU:
 * esto las pide en paralelo y reescribe solo sus filas. Un segundo largo.
 *
 * Los bloques se reescriben de abajo hacia arriba: si una publicación cambia de
 * cantidad de promos, las filas de abajo se corren, y hacerlo al revés
 * invalidaría los índices que ya calculamos.
 */
function refrescarSku(sku) {
  const t0 = Date.now();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('Datos');
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'sin datos' };

  const ancho = sh.getLastColumn();
  const cab   = sh.getRange(1, 1, 1, ancho).getValues()[0];
  const todo  = sh.getRange(2, 1, sh.getLastRow() - 1, ancho).getValues();
  const cSku  = cab.indexOf('sku');

  // Bloques contiguos por publicación, en orden de aparición.
  const bloques = [];
  for (var i = 0; i < todo.length; i++) {
    if (String(todo[i][cSku]) !== String(sku)) continue;
    const id = String(todo[i][0]);
    const ult = bloques[bloques.length - 1];
    if (ult && ult.id === id) ult.fin = i;
    else bloques.push({ id: id, ini: i, fin: i, base: todo[i] });
  }
  if (!bloques.length) return { ok: false, error: 'SKU sin publicaciones' };

  // Todas las promos, de una.
  const rutas = bloques.map(function (b) {
    return '/seller-promotions/items/' + b.id + '?app_version=v2';
  });
  const res = mlGetMuchos(rutas);

  // Las ventanas que falten (relámpago), una llamada por campaña, no por ítem.
  const ventanas = {}, pendientes = {};
  bloques.forEach(function (b) {
    _arr(res['/seller-promotions/items/' + b.id + '?app_version=v2']).forEach(function (p) {
      if (p.start_date || VENTANA_POR_ITEM.indexOf(String(p.type)) < 0) return;
      pendientes[p.id] = p.type;
    });
  });
  Object.keys(pendientes).forEach(function (pid) {
    try {
      _arr(mlGet('/seller-promotions/promotions/' + pid + '/items?promotion_type=' +
                 encodeURIComponent(pendientes[pid]) + '&app_version=v2')).forEach(function (x) {
        if (x && (x.start_date || x.finish_date))
          ventanas[pid + '|' + x.id] = [_fechaAR(x.start_date), _fechaAR(x.finish_date)];
      });
    } catch (e) {}
  });

  const salida = [];
  for (var k = bloques.length - 1; k >= 0; k--) {
    const b = bloques[k];
    const promos = _arr(res['/seller-promotions/items/' + b.id + '?app_version=v2']);
    if (!promos.length) continue;                    // no vino: se deja como está
    const nuevas = promos.map(function (p) {
      return _filaPromo(b.base, p, ventanas[String(p.id) + '|' + b.id] || ['', '']);
    });
    const viejas = b.fin - b.ini + 1;
    if (nuevas.length === viejas) {
      sh.getRange(2 + b.ini, 1, nuevas.length, ancho).setValues(nuevas);
    } else if (nuevas.length < viejas) {
      sh.getRange(2 + b.ini, 1, nuevas.length, ancho).setValues(nuevas);
      sh.deleteRows(2 + b.ini + nuevas.length, viejas - nuevas.length);
    } else {
      sh.insertRowsAfter(2 + b.fin, nuevas.length - viejas);
      sh.getRange(2 + b.ini, 1, nuevas.length, ancho).setValues(nuevas);
    }
    nuevas.forEach(function (r) {
      const o = {}; cab.forEach(function (c, i) { o[c] = r[i]; }); salida.push(o);
    });
  }
  return { ok: true, sku: String(sku), publicaciones: bloques.length,
           filas: salida, segundos: Math.round((Date.now() - t0) / 1000) };
}

/** Arma una fila de Datos: columnas del ítem de `base`, columnas de promo de `p`. */
function _filaPromo(base, p, w) {
  const f = base.slice();
  f[11] = p.type || ''; f[12] = p.id || ''; f[13] = p.name || ''; f[14] = p.status || '';
  f[15] = p.price != null ? p.price : '';
  f[16] = p.original_price != null ? p.original_price : '';
  f[17] = p.max_discounted_price != null ? p.max_discounted_price : '';
  f[18] = p.min_discounted_price != null ? p.min_discounted_price : '';
  f[19] = p.suggested_discounted_price != null ? p.suggested_discounted_price : '';
  f[20] = p.meli_percentage   != null ? p.meli_percentage   : '';
  f[21] = p.seller_percentage != null ? p.seller_percentage : '';
  f[22] = p.boosted_offer === true ? 'SI' : '';
  f[23] = p.total_price_for_boosted_offer != null ? p.total_price_for_boosted_offer : '';
  f[24] = p.start_date  || w[0] || '';
  f[25] = p.finish_date || w[1] || '';
  f[26] = (p.stock && p.stock.min != null) ? p.stock.min : '';
  f[27] = (p.stock && p.stock.max != null) ? p.stock.max : '';
  f[28] = p.sub_type || '';
  f[29] = p.fixed_amount     != null ? p.fixed_amount     : '';
  f[30] = p.fixed_percentage != null ? p.fixed_percentage : '';
  return f;
}

/**
 * Etiqueta manual por publicación.
 *
 * Meli muestra "6 cuotas" en el seller center, pero ese dato NO está en la API:
 * la publicación solo trae INSTALLMENTS_CAMPAIGN cuando las cuotas las pagás
 * vos. Las que ofrece el banco no son un atributo tuyo y no hay endpoint que
 * las devuelva —/sites/MLA/search está cerrado con 403 para aplicaciones—.
 *
 * Así que la opción de cuota se escribe a mano una vez por publicación y queda
 * guardada acá. Es dato tuyo, no de Meli: la sincronización no lo pisa.
 */
function guardarEtiqueta(itemId, texto) {
  const sh = _hoja('Etiquetas', ['item_id', 'etiqueta', 'actualizado']);
  // Acepta una publicación o varias: el espejo catálogo/propia es la misma
  // oferta dos veces, así que se etiquetan juntas.
  const ids = (Array.isArray(itemId) ? itemId : [itemId])
    .map(function (x) { return String(x || '').trim(); }).filter(Boolean);
  if (!ids.length) throw new Error('falta item_id');
  const t = String(texto == null ? '' : texto).slice(0, 60).trim();

  const n = sh.getLastRow();
  var col = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const nuevas = [];
  ids.forEach(function (id) {
    const i = col.indexOf(id);
    if (i >= 0) {
      if (t) sh.getRange(2 + i, 2, 1, 2).setValues([[t, new Date()]]);
      else { sh.deleteRow(2 + i); col.splice(i, 1); }   // vacío = borrar
    } else if (t) { nuevas.push([id, t, new Date()]); col.push(id); }
  });
  if (nuevas.length) sh.getRange(sh.getLastRow() + 1, 1, nuevas.length, 3).setValues(nuevas);
  return { ok: true, item_ids: ids, etiqueta: t };
}

function sumarAPromo(a) {
  const tipo = a.promotion_type;
  const body = { promotion_type: tipo };
  if (a.promotion_id) body.promotion_id = a.promotion_id;

  if (tipo === 'PRICE_DISCOUNT') {
    delete body.promotion_id;
    body.deal_price = Number(a.deal_price);
    if (a.top_deal_price) body.top_deal_price = Number(a.top_deal_price);
    if (a.start_date)  body.start_date  = a.start_date;
    if (a.finish_date) body.finish_date = a.finish_date;
  } else if (tipo === 'LIGHTNING') {
    body.deal_price = Number(a.deal_price);
    body.stock = Number(a.stock);
  } else if (tipo === 'DEAL' || tipo === 'DOD') {
    body.deal_price = Number(a.deal_price);
  }

  const r = _mlEscribir('post', '/seller-promotions/items/' + a.item_id + '?app_version=v2', body);
  _log('sumar', a.item_id, tipo + ' ' + (a.promotion_id || '') + ' @ ' + (a.deal_price || 'acepta'),
       r.ok ? 'OK' : 'ERROR ' + r.code + ' ' + r.texto);
  if (!r.ok) throw new Error(_mensajeError(r));
  return { ok: true, body: r.body, filas: _refrescarItem(a.item_id) };
}

function salirDePromo(a) {
  var qs = '?app_version=v2&promotion_type=' + encodeURIComponent(a.promotion_type);
  if (a.promotion_id) qs += '&promotion_id=' + encodeURIComponent(a.promotion_id);
  const r = _mlEscribir('delete', '/seller-promotions/items/' + a.item_id + qs, null);
  _log('salir', a.item_id, a.promotion_type + ' ' + (a.promotion_id || ''),
       r.ok ? 'OK' : 'ERROR ' + r.code + ' ' + r.texto);
  if (!r.ok) throw new Error(_mensajeError(r));
  return { ok: true, filas: _refrescarItem(a.item_id) };
}

function ejecutarLote(acciones) {
  return acciones.map(function (a) {
    try {
      const res = a.accion === 'salir' ? salirDePromo(a) : sumarAPromo(a);
      Utilities.sleep(400);
      return { item_id: a.item_id, ok: true, res: res };
    } catch (err) {
      return { item_id: a.item_id, ok: false, error: String(err.message || err) };
    }
  });
}

function _mensajeError(r) {
  const b = r.body || {};
  const clave = (b.error || '') + ' ' + (b.message || '');
  const mapa = {
    error_credibility_price:
      'Precio no creíble. Meli compara contra tu precio de venta de los últimos ~7 días. ' +
      'Hay que sacar las ofertas, actualizar el precio y esperar la ventana.',
    buyer_discount_not_in_range:      'El descuento debe estar entre 5% y 80%.',
    best_buyer_discount_not_in_range: 'El descuento para mejores compradores debe estar entre 5% y 80%.',
    discount_below_5_percent_difference:
      'Con descuento general de hasta 35%, el tramo de mejores compradores debe ser al menos 5% mayor.',
    discount_below_10_percent_difference:
      'Con descuento general mayor a 35%, el tramo de mejores compradores debe ser al menos 10% mayor.',
    ENTITY_LOCKED: 'El ítem está bloqueado unos segundos. Reintentá.'
  };
  for (var k in mapa) if (clave.indexOf(k) >= 0) return mapa[k];
  return b.message || r.texto || ('Error ' + r.code);
}

function _log(accion, item, detalle, resultado) {
  try {
    _hoja('Log', ['ts','accion','item_id','detalle','resultado'])
      .appendRow([new Date(), accion, item, detalle, resultado]);
  } catch (e) {}
}


/* ═══════════════════════════════════════════════════════════════════════════
   8 · HOJAS
   ═══════════════════════════════════════════════════════════════════════════ */

function _hoja(nombre, cabecera) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, cabecera.length).setValues([cabecera])
      .setFontWeight('bold').setBackground('#EEF2F1');
    sh.setFrozenRows(1);
  }
  return sh;
}

function _volcarHoja(nombre, cabecera, filas) {
  const sh = _hoja(nombre, cabecera);
  sh.clear();
  sh.getRange(1, 1, 1, cabecera.length).setValues([cabecera])
    .setFontWeight('bold').setBackground('#EEF2F1');
  if (filas.length) sh.getRange(2, 1, filas.length, cabecera.length).setValues(filas);
  sh.setFrozenRows(1);
}


/* ═══════════════════════════════════════════════════════════════════════════
   9 · TRIGGERS Y DIAGNÓSTICO
   ═══════════════════════════════════════════════════════════════════════════ */

function instalarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'refrescarTokenProgramado' || f === 'sincronizarTodo') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refrescarTokenProgramado').timeBased().everyHours(4).create();
  ScriptApp.newTrigger('sincronizarTodo').timeBased().atHour(7).everyDays(1).create();
  Logger.log('Triggers instalados: refresh cada 4h, sync diaria 07:00.');
}

function diagnostico() {
  Logger.log('user_id: ' + P.getProperty('ML_USER_ID'));
  Logger.log('clave app: ' + CLAVE_APP);
  Logger.log('/users/me -> ' + JSON.stringify(mlGet('/users/me')).slice(0, 250));
  Logger.log('última sync: ' + (P.getProperty('ULTIMA_SYNC') || 'nunca'));
}
