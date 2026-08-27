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

function sincronizarTodo() {
  const t0  = Date.now();
  const uid = P.getProperty('ML_USER_ID');
  if (!uid) throw new Error('Sin user_id. Corré paso1_autorizar.');

  // 5.1 · Campañas abiertas (las tarjetas de la CDP, con su vencimiento)
  // Ojo: este endpoint devuelve un objeto {results:[...]}, no un array pelado.
  var camps = [];
  try {
    const raw = mlGet('/seller-promotions/users/' + uid + '?app_version=v2');
    camps = _arr(raw);
    Logger.log('campañas: ' + camps.length + ' — crudo: ' + JSON.stringify(raw).slice(0, 400));
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

  // 5.2 · Publicaciones activas
  const ids = [];
  var scroll = null, v = 0;
  do {
    const r = mlGet('/users/' + uid + '/items/search?status=active&search_type=scan&limit=100' +
                    (scroll ? '&scroll_id=' + encodeURIComponent(scroll) : ''));
    (r.results || []).forEach(function (x) { ids.push(x); });
    scroll = r.scroll_id; v++;
  } while (scroll && ids.length && v < 30);

  // 5.3 · Atributos y condiciones de venta
  const info = {};
  for (var i = 0; i < ids.length; i += 20) {
    mlGet('/items?ids=' + ids.slice(i, i + 20).join(',') +
          '&attributes=id,title,price,available_quantity,sold_quantity,listing_type_id,' +
          'category_id,permalink,thumbnail,seller_custom_field,shipping,catalog_listing,' +
          'status,health,sale_terms')
      .forEach(function (w) {
        if (w.code !== 200 || !w.body) return;
        const b = w.body;
        var cuotas = '';
        (b.sale_terms || []).forEach(function (s) {
          if (s.id === 'INSTALLMENTS_INFORMATION' || /cuota/i.test(s.name || '')) cuotas = s.value_name || '';
        });
        info[b.id] = {
          titulo: b.title || '', sku: b.seller_custom_field || '', precio: b.price,
          stock: b.available_quantity, tipo: b.listing_type_id || '',
          link: b.permalink || '', foto: b.thumbnail || '',
          envioGratis: !!(b.shipping && b.shipping.free_shipping),
          catalogo: b.catalog_listing === true, cuotas: cuotas
        };
      });
  }

  // 5.4 · Promociones por ítem
  const filas = [];
  var errores = 0;
  ids.forEach(function (id, n) {
    var promos;
    try { promos = _arr(mlGet('/seller-promotions/items/' + id + '?app_version=v2')); }
    catch (err) { errores++; return; }
    const m = info[id] || {};
    promos.forEach(function (p) {
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
        p.start_date || '', p.finish_date || '',
        // Ojo: no concatenar "min-max" en una celda. Sheets lo interpreta como
        // fecha ("5-22" -> 22 de mayo). Van en dos columnas numéricas.
        (p.stock && p.stock.min != null) ? p.stock.min : '',
        (p.stock && p.stock.max != null) ? p.stock.max : '',
        p.sub_type || '',
        p.fixed_amount != null ? p.fixed_amount : '',
        p.fixed_percentage != null ? p.fixed_percentage : ''
      ]);
    });
    if (n % 10 === 9) Utilities.sleep(250);
  });

  // precio_vidriera es el price que devuelve /items: cuando hay una promo activa
  // ya viene con el descuento aplicado. El precio de lista real es original_price.
  _volcarHoja('Datos',
    ['item_id','sku','titulo','precio_vidriera','stock','listing_type','cuotas','envio_gratis',
     'catalogo','link','foto','promo_tipo','promo_id','promo_nombre','status','precio_promo',
     'original_price','max_disc','min_disc','sugerido','meli_%','seller_%','boost','precio_boost',
     'inicio','fin','stock_min','stock_max','sub_type','monto_fijo','pct_fijo'], filas);

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
    segundos: Math.round((Date.now() - t0) / 1000)
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
  const hist  = _leerHoja(ss, 'Historico');
  const log   = _leerHoja(ss, 'Log').slice(-60);

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

  return {
    generado: new Date().toISOString(),
    ultimaSync: JSON.parse(P.getProperty('ULTIMA_SYNC') || '{}'),
    datos: datos, campanias: camps, reloj: reloj, log: log
  };
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
  return r.body;
}

function salirDePromo(a) {
  var qs = '?app_version=v2&promotion_type=' + encodeURIComponent(a.promotion_type);
  if (a.promotion_id) qs += '&promotion_id=' + encodeURIComponent(a.promotion_id);
  const r = _mlEscribir('delete', '/seller-promotions/items/' + a.item_id + qs, null);
  _log('salir', a.item_id, a.promotion_type + ' ' + (a.promotion_id || ''),
       r.ok ? 'OK' : 'ERROR ' + r.code + ' ' + r.texto);
  if (!r.ok) throw new Error(_mensajeError(r));
  return { ok: true };
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
