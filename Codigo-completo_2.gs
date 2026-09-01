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
 * EL TOKEN QUE SE VENCÍA (01-sep-2026): la cadena del refresh_token se cortaba
 * cada tanto y había que volver a autorizar a mano. Eran dos cosas, las dos
 * arregladas acá: el trigger renovaba sin tomar el lock (chocaba con la app y
 * uno de los dos se comía un invalid_grant) y renovaba siempre, aunque al token
 * le quedaran horas. Ahora hay un solo camino, con lock, que renueva solo si
 * hace falta, y guarda el refresh anterior como respaldo. Ver la sección de
 * TOKENS y la función estadoToken().
 *
 * SIN refresh_token (01-sep-2026, medido): el canje devolvía un access_token y
 * nada más, y _guardarTokens escribía ese vacío ENCIMA del refresh_token bueno.
 * O sea que una autorización fallida rompía la cadena que andaba. Ahora el
 * refresh_token solo se escribe si vino de verdad, y el link de autorización
 * pide scope=offline_access explícitamente, que es lo que Meli necesita para
 * devolver la cadena.
 *
 * DESPUÉS DE PEGAR — EL ORDEN IMPORTA:
 *   1. Guardá (Ctrl+S)
 *   2. Implementar → Administrar implementaciones → lápiz → Versión nueva
 *      ↑ ESTO ANTES DE AUTORIZAR. Meli vuelve al /exec, y el /exec corre la
 *        última versión IMPLEMENTADA, no la que ves en el editor.
 *   3. Ejecutá  instalarTriggers   ← CORRELO DE NUEVO, cambió el del token
 *   4. Ejecutá  paso1_autorizar    y aprobá el link con KENTAOFICIAL
 *   5. Ejecutá  estadoToken        → tiene que decir "refresh_token: guardado"
 *
 * SI EL PASO 5 FALLA:
 *   · revisarPermisos()  → le pregunta a Meli qué scopes tiene la app
 *   · revocarPermiso()   → borra el permiso vigente para forzar uno nuevo
 *                          (desconecta la app: seguí YA con paso1_autorizar)
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

/**
 * Versión del backend. Subila cuando cambies este archivo.
 *
 * El editor ejecuta SIEMPRE el código que ves; el /exec ejecuta la última
 * VERSIÓN IMPLEMENTADA, que puede ser mucho más vieja. Eso hacía que el mismo
 * sync tardara 15 segundos desde el editor y 33 desde la app, sin ninguna
 * pista de por qué. Ahora la app muestra las dos versiones y el desfasaje se ve.
 */
const VERSION_BACK = '2026.09.01-50';

/**
 * Contrato: qué sabe responder este backend.
 *   1 · datos, sync, sumar, salir, lote
 *   2 · sku, etiqueta, etiquetas
 *   3 · precios
 *   4 · cupones, cupon_crear, cupon_editar, cupon_borrar
 * El front avisa si lo implementado tiene un contrato menor al que necesita.
 * Subir SOLO al agregar o cambiar una acción, no en cada retoque.
 */
const CONTRATO = 4;


/* ═══════════════════════════════════════════════════════════════════════════
   2 · AUTORIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * El link para autorizar.
 *
 * DOS COSAS ANTES DE CORRERLO:
 *
 *   · Publicá la versión nueva. Meli te devuelve al /exec, y el /exec corre la
 *     última versión IMPLEMENTADA, no la del editor. Si autorizás sin publicar,
 *     el canje lo hace el código viejo y el arreglo no participa.
 *
 *   · Aprobá con la cuenta ADMINISTRADORA (KENTAOFICIAL). Con un colaborador
 *     el permiso no vale y Meli devuelve invalid_operator_user_id.
 *
 * El link lleva scope=offline_access read write. Eso está documentado: la
 * referencia de errores de Meli dice que los valores permitidos del parámetro
 * son exactamente "offline_access", "write" y "read". Pedirlo explícitamente
 * es lo que hace que el canje devuelva refresh_token; sin él, Meli concede lo
 * que la aplicación tenga configurado y nada más.
 */
function paso1_autorizar() {
  const state = Utilities.getUuid();
  P.setProperty('ML_OAUTH_STATE', state);
  const base = ML.AUTH_HOST + '/authorization?response_type=code'
    + '&client_id='    + encodeURIComponent(ML.CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(ML.REDIRECT_URI)
    + '&state='        + encodeURIComponent(state);
  const conScope = base + '&scope=' + encodeURIComponent('offline_access read write');

  Logger.log('\nABRÍ ESTE LINK Y APROBÁ CON KENTAOFICIAL (cuenta principal):\n');
  Logger.log(conScope);
  Logger.log('\nDespués corré  estadoToken.  Tiene que decir "refresh_token: guardado".');
  Logger.log('');
  Logger.log('Si Meli rechaza el link de arriba, el error dice qué pasa:');
  Logger.log('  · invalid_scope       → el parámetro está mal escrito, avisame.');
  Logger.log('  · unauthorized_client → la aplicación no tiene habilitado el');
  Logger.log('    flujo. devcenter → tu app → Editar → Configuración y scopes →');
  Logger.log('    Flujos Oauth → tildá "Refresh Token" → GUARDAR (no "Volver").');
  Logger.log('');
  Logger.log('Y este es el link sin el scope, por si querés comparar:');
  Logger.log(base);
  return conScope;
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

/* ═══════════════════════════════════════════════════════════════════════════
   LOS TOKENS
   El refresh_token de Meli es de UN SOLO USO: cada vez que lo usás, Meli te
   devuelve uno nuevo y mata el anterior. Es una cadena — si se corta un
   eslabón, no hay forma de recuperarla salvo autorizar a mano de nuevo.

   Había dos formas de cortarla, y por eso se vencía cada tanto:

     1. refrescarTokenProgramado() llamaba a _refrescar() SIN tomar el lock.
        Si el trigger caía junto con una llamada de la app, los dos pedían el
        refresh con el MISMO token: uno ganaba y el otro se comía un
        invalid_grant.

     2. Ese trigger refrescaba SIEMPRE, aunque al token le quedaran horas de
        vida. Cada refresh de más es una rotación de más, y otra chance de que
        la ejecución muera entre que Meli rota y el script guarda —ahí Meli
        queda con el nuevo, el script con el viejo, y se acabó—.

   Lo que se hace ahora:
     · Un solo camino para refrescar, siempre con el lock tomado.
     · Se refresca solo si al token le queda menos de MARGEN_REFRESH.
     · El token nuevo se guarda ANTES de devolverlo, y el anterior queda como
       respaldo: si un refresh falla con invalid_grant, se reintenta una vez
       con el respaldo. Eso rescata justo el caso de "Meli rotó y nosotros no
       llegamos a anotarlo".
   ═══════════════════════════════════════════════════════════════════════════ */

/* Si al access_token le queda menos que esto, se renueva. Dura 6 h; con dos
   horas de colchón el trigger de cada 2 h lo mantiene vivo sin rotar de más:
   pasa a mirarlo tres veces por vida y renueva solo en la última. */
const MARGEN_REFRESH = 2 * 60 * 60 * 1000;

/**
 * Guarda lo que devolvió Meli.
 *
 * OJO con el refresh_token: antes se guardaba SIEMPRE, viniera o no. Si Meli
 * contestaba sin él —y contesta sin él cuando la aplicación no tiene
 * offline_access— se pisaba el que había con una cadena vacía. Es decir: una
 * autorización fallida destruía la cadena que funcionaba. Eso explica el
 * "ML_REFRESH_TOKEN = (vacío)" del 01-sep.
 *
 * Ahora solo se escribe si de verdad vino uno, y si no vino queda anotado en el
 * log y en ML_SIN_REFRESH para que estadoToken lo pueda decir.
 */
function _guardarTokens(t) {
  const previo = P.getProperty('ML_REFRESH_TOKEN');
  const props = {
    ML_ACCESS_TOKEN:  t.access_token,
    ML_USER_ID:       String(t.user_id),
    // Si Meli no manda expires_in, 6 h es lo que dura siempre en la práctica.
    ML_EXPIRA_EN:     String(Date.now() + ((t.expires_in || 21600) - 600) * 1000),
    ML_TOKEN_FECHA:   new Date().toISOString()
  };

  if (t.refresh_token) {
    props.ML_REFRESH_TOKEN = t.refresh_token;
    props.ML_SIN_REFRESH   = '';
    // El anterior se guarda como respaldo: es el único salvavidas si alguna vez
    // Meli rota y nosotros no llegamos a anotar el nuevo.
    if (previo && previo !== t.refresh_token) props.ML_REFRESH_PREV = previo;
  } else {
    props.ML_SIN_REFRESH = new Date().toISOString();
    Logger.log('OJO: Meli contestó SIN refresh_token. Las claves que mandó: ' +
               Object.keys(t || {}).join(', ') + '. Casi siempre es que la ' +
               'aplicación no tiene offline_access habilitado en devcenter. ' +
               'No piso el refresh_token que ya estaba.');
  }

  /* Qué contestó Meli, para no tener que adivinar la próxima vez. El canje
     corre en el /exec y su Logger no se ve desde el editor, así que el dato
     se guarda acá y estadoToken lo muestra. Nunca el token: solo el scope
     concedido y los nombres de los campos. */
  props.ML_ULTIMO_SCOPE   = String(t.scope || '(Meli no mandó scope)');
  props.ML_ULTIMAS_CLAVES = Object.keys(t || {}).join(', ');

  P.setProperties(props, false);
}

function getToken() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tok = P.getProperty('ML_ACCESS_TOKEN');
    const vence = Number(P.getProperty('ML_EXPIRA_EN') || 0);
    if (tok && Date.now() < vence) return tok;
    return _refrescar();
  } finally { lock.releaseLock(); }
}

/**
 * Renueva el token. OJO: asume que quien llama YA tiene el lock tomado.
 * No lo tomes acá adentro: getToken lo tiene y Apps Script no reentra.
 */
function _refrescar() {
  const rt = P.getProperty('ML_REFRESH_TOKEN');
  if (!rt) throw new Error('No hay refresh_token. Corré paso1_autorizar.');

  var res = _pedirRefresh(rt);
  if (!res.ok) {
    /* invalid_grant quiere decir que ese refresh_token ya se usó. Casi siempre
       es porque Meli rotó y la ejecución anterior no llegó a guardar el nuevo.
       El respaldo es el que estaba antes; si el que falló es el nuevo, el
       viejo no sirve, pero si el que falló era el viejo —porque se guardó a
       medias— el respaldo puede ser el bueno. Cuesta una llamada probarlo y
       ahorra tener que reautorizar a mano. */
    const prev = P.getProperty('ML_REFRESH_PREV');
    if (prev && prev !== rt && /invalid_grant/i.test(res.texto)) {
      Logger.log('refresh: invalid_grant con el token actual, pruebo el respaldo');
      res = _pedirRefresh(prev);
    }
  }
  if (!res.ok)
    throw new Error('refresh ' + res.code + ' — ' + res.motivo +
      ' · si dice invalid_grant, la cadena se cortó: corré paso1_autorizar de nuevo.');

  _guardarTokens(res.body);
  return res.body.access_token;
}

/** Una llamada de refresh, sin decidir nada. */
function _pedirRefresh(refreshToken) {
  const r = UrlFetchApp.fetch(ML.API_HOST + '/oauth/token', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    headers: { accept: 'application/json' },
    payload: {
      grant_type: 'refresh_token', client_id: ML.CLIENT_ID,
      client_secret: ML.CLIENT_SECRET, refresh_token: refreshToken
    },
    muteHttpExceptions: true
  });
  const texto = r.getContentText();
  var body = null; try { body = JSON.parse(texto); } catch (e) {}
  return {
    ok: r.getResponseCode() === 200 && body && body.access_token,
    code: r.getResponseCode(), texto: texto, body: body,
    motivo: (body && (body.error_description || body.error)) || texto.slice(0, 200)
  };
}

/**
 * El trigger que vigila el token.
 *
 * Toma el lock —antes no lo hacía, y ese era el choque— y solo renueva si al
 * token de verdad le queda poco. Renovar uno sano no sirve de nada y suma
 * rotaciones que pueden romper la cadena.
 */
function refrescarTokenProgramado() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('token: hay otra ejecución, no toco nada'); return; }
  try {
    const vence = Number(P.getProperty('ML_EXPIRA_EN') || 0);
    const queda = vence - Date.now();
    if (queda > MARGEN_REFRESH) {
      Logger.log('token: le quedan ' + Math.round(queda / 60000) + ' min, no hace falta renovar');
      return;
    }
    _refrescar();
    Logger.log('token: renovado, vence en ' +
               Math.round((Number(P.getProperty('ML_EXPIRA_EN')) - Date.now()) / 60000) + ' min');
  } catch (e) { Logger.log('token: FALLÓ la renovación — ' + e); }
  finally { lock.releaseLock(); }
}

/**
 * Cómo está la conexión con Meli. No escribe nada, no rota nada.
 * Corré esto cuando dudes, en vez de reautorizar por las dudas.
 */
function estadoToken() {
  const vence = Number(P.getProperty('ML_EXPIRA_EN') || 0);
  const queda = vence - Date.now();
  Logger.log('user_id           : ' + (P.getProperty('ML_USER_ID') || '(sin autorizar)'));
  Logger.log('access_token      : ' + (P.getProperty('ML_ACCESS_TOKEN') ? 'guardado' : 'NO HAY'));
  Logger.log('vence             : ' + (vence ? new Date(vence).toLocaleString('es-AR') : '—'));
  Logger.log('le queda          : ' + (queda > 0 ? Math.round(queda / 60000) + ' min' : 'VENCIDO'));
  Logger.log('refresh_token     : ' + (P.getProperty('ML_REFRESH_TOKEN') ? 'guardado' : 'NO HAY'));
  Logger.log('respaldo          : ' + (P.getProperty('ML_REFRESH_PREV') ? 'guardado' : 'todavía no hay'));
  Logger.log('última renovación : ' + (P.getProperty('ML_TOKEN_FECHA') || '—'));

  Logger.log('scope concedido   : ' + (P.getProperty('ML_ULTIMO_SCOPE') || '(sin registrar)'));

  const sinRt = P.getProperty('ML_SIN_REFRESH');
  if (sinRt && !P.getProperty('ML_REFRESH_TOKEN')) {
    Logger.log('');
    Logger.log('✗ SIN CADENA. La última autorización (' + sinRt + ') volvió sin');
    Logger.log('  refresh_token. Este access_token se muere cuando venza y hay que');
    Logger.log('  autorizar a mano de nuevo. Se arregla en devcenter, no acá:');
    Logger.log('  developers.mercadolibre.com.ar → tu aplicación → que tenga');
    Logger.log('  offline_access entre los permisos → y volver a autorizar.');
  }
  Logger.log('\nSe renueva sola cuando le quedan menos de ' +
             (MARGEN_REFRESH / 3600000) + ' h. Si acá dice VENCIDO y aun así la app anda,');
  Logger.log('es porque se renovó en la primera llamada: es lo esperado.');
  var t = null;
  try { t = getToken(); } catch (e) { Logger.log('\n✗ No pude obtener token: ' + e); return; }
  Logger.log('\n✔ Token vivo. Probando una llamada real...');
  try { Logger.log('  /users/me → ' + (mlGet('/users/me').nickname || 'ok')); }
  catch (e) { Logger.log('  ✗ la llamada falló: ' + e); }
}

/**
 * Qué permisos le diste realmente a la aplicación.
 *
 * Le pregunta a Meli, no a la pantalla de devcenter: es la única forma de
 * saber si el tilde de "Refresh Token" quedó guardado o no. No escribe nada.
 */
function revisarPermisos() {
  const uid = P.getProperty('ML_USER_ID');
  const at  = P.getProperty('ML_ACCESS_TOKEN');
  if (!uid || !at) { Logger.log('Sin token guardado. Corré paso1_autorizar.'); return; }

  const pedir = function (ruta) {
    try {
      const r = UrlFetchApp.fetch(ML.API_HOST + ruta, {
        headers: { Authorization: 'Bearer ' + at, accept: 'application/json' },
        muteHttpExceptions: true });
      return { code: r.getResponseCode(), texto: r.getContentText() };
    } catch (e) { return { code: 0, texto: String(e) }; }
  };

  Logger.log('══════════ EL PERMISO QUE LE DISTE A LA APP ══════════');
  const g = pedir('/users/' + uid + '/applications/' + ML.CLIENT_ID);
  Logger.log('  ' + g.code + ' · ' + g.texto.slice(0, 900));
  var grant = null; try { grant = JSON.parse(g.texto); } catch (e) {}

  const scopes = (grant && grant.scopes) || [];
  const offline = /offline_access/i.test(JSON.stringify(scopes));
  Logger.log('\n  creado el : ' + ((grant && grant.date_created) || '—'));
  Logger.log('  scopes    : ' + scopes.length);
  Logger.log('  OFFLINE   : ' + (offline ? '✔ SÍ' : '✗ NO — es lo que falta'));

  // La doc avisa: las apps tienen que estar separadas entre Mercado Libre y
  // Mercado Pago. Si hay scopes urn:mp: hay que ajustarlos en el devcenter de
  // Mercado Pago o se pierde el acceso a las APIs de Meli.
  const mp = scopes.filter(function (s) { return /^urn:mp:/i.test(String(s)); });
  Logger.log('  scopes de Mercado Pago: ' + (mp.length ? '⚠ ' + mp.join(', ') : 'ninguno (bien)'));

  Logger.log('\n══════════ LA FICHA DE LA APLICACIÓN ══════════');
  const a = pedir('/applications/' + ML.CLIENT_ID);
  var app = null; try { app = JSON.parse(a.texto); } catch (e) {}

  /* allow_flow es EL campo. Son las casillas de "Flujos Oauth" en devcenter,
     tal cual: authorization_code, client_credentials, refresh_token. Si
     refresh_token no está en esta lista, Meli no va a mandar la cadena por más
     que se la pidas en el link — no es el permiso del usuario, es lo que la
     aplicación tiene permitido pedir. */
  const flujos = (app && app.allow_flow) || [];
  const puedeRefresh = flujos.indexOf('refresh_token') >= 0;
  Logger.log('  Flujos Oauth habilitados : ' + (flujos.join(', ') || '(no se pudo leer)'));
  Logger.log('  ¿incluye refresh_token?  : ' + (puedeRefresh ? '✔ SÍ' : '✗ NO — es esto'));
  Logger.log('  PKCE                     : ' + ((app && app.use_pkce) ? '⚠ activado' : 'no (bien)'));
  Logger.log('  última vez que se guardó : ' +
    ((app && app.traceability_updated && app.traceability_updated.date) || '—'));
  Logger.log('  (si esa fecha no es de hoy, el cambio en devcenter no se guardó)');

  Logger.log('\n  ── la ficha cruda ──');
  for (var i = 0; i < a.texto.length && i < 2000; i += 450)
    Logger.log('  │ ' + a.texto.slice(i, i + 450));

  Logger.log('\n══════════ EL ÚLTIMO CANJE ══════════');
  Logger.log('  scope concedido : ' + (P.getProperty('ML_ULTIMO_SCOPE') || '(sin registrar)'));
  Logger.log('  campos devueltos: ' + (P.getProperty('ML_ULTIMAS_CLAVES') || '(sin registrar)'));

  Logger.log('\n══════════ QUÉ HACER ══════════');
  if (offline) {
    Logger.log('  ►► Está todo bien. La cadena se mantiene sola.');
  } else if (!puedeRefresh) {
    Logger.log('  ►► La aplicación NO tiene habilitado el flujo refresh_token.');
    Logger.log('     Autorizar de nuevo no sirve de nada hasta arreglar esto:');
    Logger.log('');
    Logger.log('     developers.mercadolibre.com.ar → tu aplicación → Editar →');
    Logger.log('     "Configuración y scopes" → Flujos Oauth → tildá');
    Logger.log('     "Refresh Token" → BAJÁ HASTA EL FINAL Y GUARDÁ.');
    Logger.log('     El botón "Volver" de arriba NO guarda: sale sin aplicar.');
    Logger.log('');
    Logger.log('     Después volvé a correr revisarPermisos(): la lista de');
    Logger.log('     flujos tiene que decir tres, y la fecha de guardado, hoy.');
  } else {
    Logger.log('  ►► La aplicación ya puede pedir el refresh, pero el permiso');
    Logger.log('     que tenés concedido es viejo y no lo incluye. Corré:');
    Logger.log('       1. revocarPermiso()   (desconecta la app)');
    Logger.log('       2. paso1_autorizar    (seguí en el momento)');
    Logger.log('       3. estadoToken');
  }
}

/**
 * Borra el permiso que tu cuenta le dio a la aplicación.
 *
 * ⚠ Esto DESCONECTA la app: el token actual deja de servir y la página web va
 * a tirar error hasta que autorices de nuevo. No se pierde nada más —ni
 * publicaciones, ni promociones, ni la planilla—, pero seguí con
 * paso1_autorizar en el momento, no lo dejes para después.
 *
 * Para qué sirve: mientras haya un permiso vigente, Meli no vuelve a
 * preguntar nada y reusa el que ya diste, con los scopes que tenía. Borrarlo
 * es lo que lo obliga a armar uno nuevo.
 */
function revocarPermiso() {
  const uid = P.getProperty('ML_USER_ID');
  if (!uid) { Logger.log('No hay user_id guardado. Corré paso1_autorizar.'); return; }

  const ruta = '/users/' + uid + '/applications/' + ML.CLIENT_ID;
  Logger.log('DELETE ' + ruta);
  const r = _mlEscribir('delete', ruta, null);
  Logger.log('  ' + r.code + ' · ' + String(r.texto || '(vacía)').slice(0, 200));

  if (!r.ok) {
    Logger.log('\n✗ Meli no lo aceptó: ' + _mensajeError(r));
    Logger.log('  A mano: mercadolibre.com.ar → Mi cuenta → Seguridad →');
    Logger.log('  aplicaciones conectadas → tu app → quitar permiso.');
    return;
  }

  // El token viejo muere con el permiso: se limpia para no dejar basura que
  // después confunda al diagnóstico.
  P.setProperties({ ML_ACCESS_TOKEN: '', ML_EXPIRA_EN: '0',
                    ML_REFRESH_TOKEN: '', ML_REFRESH_PREV: '' }, false);

  Logger.log('\n✔ Permiso borrado. La app está desconectada.');
  Logger.log('  SEGUÍ YA con paso1_autorizar y después estadoToken.');
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
/**
 * La ventana de una publicación dentro de una campaña, como [inicio, fin].
 *
 * Ojo: Meli usa DOS nombres distintos para el mismo campo según el tipo de
 * campaña. Las relámpago mandan "finish_date"; los acuerdos PRE_NEGOTIATED
 * mandan "end_date". Leer solo uno dejaba el cierre vacío y la app terminaba
 * completándolo con la fecha de la campaña — mostraba "01-sept → 05-oct"
 * cuando la oferta era de un solo día.
 */
function _ventanaDe(x) {
  if (!x) return ['', ''];
  return [_fechaAR(x.start_date), _fechaAR(x.finish_date || x.end_date)];
}

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
// Contadores de la última corrida, para saber si Meli nos está frenando.
var _RATE = { r429: 0, reintentos: 0, lotes: 0, menorTam: 0 };

function mlGetMuchos(rutas, intento) {
  intento = intento || 1;
  if (intento === 1) _RATE = { r429: 0, reintentos: 0, lotes: 0, menorTam: LOTE };
  const salida = {}, fallaron = [];
  const token  = getToken();          // una sola vez para todo el lote

  // El tamaño del lote se achica solo si Meli empieza a rechazar.
  //
  // Subirlo de 25 a 40 parecía gratis, pero si Meli contesta 429 el precio es
  // carísimo: se duerme 1,5 s y se reintenta. Cuarenta llamadas juntas que
  // rebotan cuestan más que dos tandas de veinte que pasan. Ante el primer 429
  // se parte el lote al medio y se sigue con ese tamaño.
  var tam = LOTE;

  for (var i = 0; i < rutas.length; ) {
    const tanda = rutas.slice(i, i + tam);
    const reqs  = tanda.map(function (p) {
      return {
        url: ML.API_HOST + p, method: 'get',
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
        muteHttpExceptions: true
      };
    });

    var res;
    try { res = UrlFetchApp.fetchAll(reqs); }
    catch (e) { tanda.forEach(function (p) { fallaron.push(p); }); i += tanda.length; continue; }
    _RATE.lotes++;

    var freno = false;
    res.forEach(function (r, k) {
      const c = r.getResponseCode();
      if (c === 200) {
        try { salida[tanda[k]] = JSON.parse(r.getContentText()); }
        catch (e) { fallaron.push(tanda[k]); }
      } else if (c === 401 || c === 429 || c === 423) {
        if (c === 401) P.setProperty('ML_EXPIRA_EN', '0');
        if (c === 429) { _RATE.r429++; freno = true; }
        fallaron.push(tanda[k]);
      }
      // Cualquier otro código (404, 403) es una respuesta legítima de "no hay":
      // no se reintenta, queda como hueco.
    });

    i += tanda.length;
    if (freno) {
      tam = Math.max(10, Math.floor(tam / 2));
      _RATE.menorTam = Math.min(_RATE.menorTam, tam);
      Utilities.sleep(700);
    } else if (i < rutas.length) {
      Utilities.sleep(120);                              // respiro entre lotes
    }
  }

  if (fallaron.length && intento <= 2) {
    _RATE.reintentos += fallaron.length;
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
      // Que el cartel diga la verdad: sin refresh_token esto dura 6 horas y
      // vuelve a caerse. Antes decía "Conectado" igual y no te enterabas.
      if (!t.refresh_token) return _pag('Conectado, pero a medias',
        'El token quedó guardado para el usuario ' + t.user_id + ', pero Meli ' +
        'no mandó refresh_token: en unas 6 horas hay que autorizar de nuevo. ' +
        'Se arregla habilitando <b>offline_access</b> en la aplicación, en ' +
        'developers.mercadolibre.com.ar, y volviendo a autorizar.');
      return _pag('Conectado', 'Tokens guardados para el usuario ' + t.user_id +
        '. La renovación automática queda andando.');
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
      case 'precios':  return _json({ ok: true, data: actualizarPrecios(body.cambios || []) });
      case 'sumar': return _json({ ok: true, data: sumarAPromo(body) });
      case 'salir': return _json({ ok: true, data: salirDePromo(body) });
      case 'lote':  return _json({ ok: true, data: ejecutarLote(body.acciones || []) });
      case 'cupones':      return _json({ ok: true, data: leerCupones() });
      case 'cupon_crear':  return _json({ ok: true, data: crearCupon(body.cupon || {}) });
      case 'cupon_editar': return _json({ ok: true, data: editarCupon(body.promotion_id, body.cambios || {}) });
      case 'cupon_borrar': return _json({ ok: true, data: borrarCupon(body.promotion_id) });
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

/**
 * Tipos cuya ventana se define por publicación y no por campaña.
 *
 * En estos, la fila del ítem viene sin fechas y la de la campaña miente: la
 * campaña "Ofertas Expansion Sept" corre del 31-ago al 05-oct, pero a ESTA
 * publicación se la ofrecen solo el 1/sep. Hay que pedir el listado de ítems de
 * la campaña, que trae la ventana real de cada una.
 *
 * LIGHTNING y DOD por definición (duran horas). PRE_NEGOTIATED se sumó el
 * 29-ago: Meli propone acuerdos con fecha propia por publicación.
 */
const VENTANA_POR_ITEM = ['LIGHTNING', 'DOD', 'PRE_NEGOTIATED'];

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
  //
  // Las primeras páginas de todas las campañas van en un solo lote paralelo:
  // con tres tipos en la lista, hacerlas en fila costaba varios segundos.
  const campsVentana = camps.filter(function (c) {
    return VENTANA_POR_ITEM.indexOf(String(c.type)) >= 0;
  });
  const _ruta1 = function (c) {
    return '/seller-promotions/promotions/' + c.id + '/items?promotion_type=' +
           encodeURIComponent(c.type) + '&app_version=v2';
  };
  const primeras = mlGetMuchos(campsVentana.map(_ruta1));

  campsVentana.forEach(function (c) {
      var token = null, vistos = 0, total = null, vueltas = 0, lote = [];
      do {
        var ruta = _ruta1(c);
        if (token)      ruta += '&searchAfter=' + encodeURIComponent(token);
        else if (vistos) ruta += '&limit=49&offset=' + vistos;

        var r;
        if (!vueltas && primeras[ruta] !== undefined) r = primeras[ruta];   // ya vino en el lote
        else { try { r = mlGet(ruta); } catch (e) { Logger.log('ventanas ' + c.id + ': ' + e); break; } }

        lote = _arr(r);
        lote.forEach(function (x) {
          if (!x || !x.id) return;
          const w = _ventanaDe(x);
          if (!w[0] && !w[1]) return;
          ventanas[c.id + '|' + x.id] = w;
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
        m.envio != null ? m.envio : '',
        // El id de la oferta, última columna. Agregué la columna a la cabecera
        // y me olvidé de agregarle el valor acá: la fila quedó con 34 valores
        // contra 35 títulos, setValues tiró error, y como _volcarHoja limpiaba
        // ANTES de escribir, la hoja quedó vacía. Ver la nota en _volcarHoja.
        p.ref_id || p.offer_id || ''
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
     'com_pct','com_fijo','envio_costo',
     // Va al final a propósito: agregar una columna en el medio correría todos
     // los índices de _filaPromo. El id de la oferta hace falta para darla de
     // baja —Meli lo exige en las campañas que arma él— y hasta ahora se
     // leía de la API y se tiraba.
     'offer_id'], filas);
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
    // Si Meli frenó, acá se ve: r429 son los rechazos por rate limit y
    // reintentos las llamadas que hubo que repetir. Con esos dos números se
    // sabe si el lote quedó grande.
    rate: _RATE,
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
  const ss = _ss();
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
    versionBack: VERSION_BACK,
    contrato: CONTRATO,
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
  const ss = _ss();
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

  // La ventana de una relámpago no baja al ítem. Antes se le pedía a Meli el
  // listado entero de la campaña —76 ítems— en CADA escritura, y eso costaba un
  // segundo y medio de gusto: la ventana no cambia porque entres o salgas de
  // otra promoción. Se reusa la que ya está en la hoja; el sync la refresca.
  const ventanas = {};
  viejas.forEach(function (r) {
    if (r[24] || r[25]) ventanas[String(r[12])] = [r[24], r[25]];
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
  const ss = _ss();
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
        if (!x || !x.id) return;
        const w = _ventanaDe(x);
        if (w[0] || w[1]) ventanas[pid + '|' + x.id] = w;
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
  /* El id de la oferta. Meli lo llama ref_id cuando mira la publicación y
     offer_id cuando mira la campaña; es el mismo número. Solo se escribe si la
     hoja ya tiene la columna: así una hoja vieja de 34 columnas sigue
     funcionando hasta la próxima sincronización completa, que la agrega. */
  if (f.length > 34) f[34] = p.ref_id || p.offer_id || '';
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

/**
 * Cambia el precio de lista de varias publicaciones.
 *
 * OJO con el orden: si la publicación tiene ofertas corriendo, Meli las saca al
 * cambiar el precio, pero la base de credibilidad queda anclada al precio viejo
 * — perdés la promoción y no arrancás el reloj. El front avisa antes; acá se
 * registra cada cambio en el Log para poder reconstruir qué pasó.
 */
function actualizarPrecios(cambios) {
  const salida = [];
  cambios.forEach(function (c) {
    const precio = Number(c.precio);
    if (!precio || precio <= 0) return;
    (c.item_ids || []).forEach(function (id) {
      const r = _mlEscribir('put', '/items/' + id, { price: precio });
      const ficha = _fichaItem(id);
      // El precio se confirma contra lo que devolvió Meli, no contra lo que
      // pedimos: si contesta 200 con otro número, hay que verlo en el registro.
      const quedo = r.ok && r.body && Number(r.body.price) === precio;
      _log('precio', id, 'precio de lista → ' + precio,
           r.ok ? 'OK' : 'ERROR ' + r.code + ' ' + r.texto,
           { sku: ficha.sku, producto: ficha.producto, tipo: 'PRECIO',
             precio: precio,
             resultado: !r.ok ? 'rechazado' : (quedo ? 'hecho' : 'dudoso'),
             confirmado: r.ok ? !!quedo : null,
             motivo: !r.ok ? _mensajeError(r)
                   : (quedo ? '' : 'Meli aceptó el cambio pero devolvió ' +
                       ((r.body && r.body.price) || '?') + ' en vez de ' + precio + '.') });
      salida.push(r.ok
        ? { item_id: id, ok: true, precio: precio }
        : { item_id: id, ok: false, error: _mensajeError(r) });
      Utilities.sleep(150);          // Meli no quiere ráfagas de escritura
    });
  });
  return { ok: true, resultados: salida,
           cambiadas: salida.filter(function (x) { return x.ok; }).length };
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

  // Se cronometra cada tramo: si algún día vuelve a tardar, el log dice dónde.
  const t0 = Date.now();
  const ficha = _fichaItem(a.item_id);
  const r = _mlEscribir('post', '/seller-promotions/items/' + a.item_id + '?app_version=v2', body);
  const tEscritura = Date.now() - t0;
  if (!r.ok) {
    _log('sumar', a.item_id, tipo + ' ' + (a.promotion_id || ''),
         'ERROR ' + r.code + ' ' + r.texto,
         { sku: ficha.sku, producto: ficha.producto, tipo: tipo,
           campania: a.promotion_id || '', precio: a.deal_price || '',
           resultado: 'rechazado', motivo: _mensajeError(r) });
    throw new Error(_mensajeError(r));
  }
  const t1 = Date.now();
  const conf = _refrescarConfirmado(a.item_id, tipo, a.promotion_id, true);
  const filas = conf.filas;
  const tRefresco = Date.now() - t1;
  const t2 = Date.now();
  // Se anota si el cambio quedó confirmado, mirando la fuente que corresponda:
  // la publicación si ya está al día, y si no la lista de la campaña.
  const ok = conf.confirmado;
  _log('sumar', a.item_id, tipo + ' ' + (a.promotion_id || '') + ' @ ' + (a.deal_price || 'acepta'),
       'OK',
       { sku: ficha.sku, producto: ficha.producto, tipo: tipo,
         campania: _nombreCampania(filas, tipo, a.promotion_id) || a.promotion_id || '',
         precio: a.deal_price || '',
         resultado: ok ? 'hecho' : 'dudoso', confirmado: ok,
         motivo: ok ? '' : 'Meli aceptó el pedido pero al releer la publicación la ' +
                           'promoción todavía no figuraba puesta.' });
  const ms = { meli: tEscritura, refresco: tRefresco, log: Date.now() - t2, total: Date.now() - t0 };
  Logger.log('sumar ' + a.item_id + ' → ' + JSON.stringify(ms));
  return { ok: true, body: r.body, filas: filas, ms: ms,
           confirmado: conf.confirmado, fuente: conf.fuente };
}

/**
 * Refresca la publicación y NO devuelve una foto que contradiga lo que se
 * acaba de hacer sin haberla mirado dos veces.
 *
 * El problema, medido: /seller-promotions/items/{id} tarda en ponerse al día
 * después de una escritura. Con los cupones lo vimos negro sobre blanco — una
 * baja con 200 OK y la vista del ítem siguió diciendo "started" durante más de
 * un minuto—. Como la app confirma contra estas filas, una foto vieja le hacía
 * decir "No salió" o "No quedó guardado" sobre un cambio que Meli sí aplicó.
 * Eso es lo peor que puede pasar: te manda a rehacer algo ya hecho.
 *
 * Entonces: si la primera lectura contradice la intención, se espera y se lee
 * otra vez. Si la segunda confirma, listo. Si vuelve a contradecir, se devuelve
 * eso —puede ser un rechazo real y hay que decirlo—, pero ya con dos lecturas
 * separadas en el tiempo, no con una apurada.
 *
 * quiereAdentro: true si acabás de sumarte, false si acabás de salir.
 */
function _refrescarConfirmado(itemId, tipo, promoId, quiereAdentro) {
  var filas = _refrescarItem(itemId);

  var concuerda = function (fs) {
    if (!fs || !fs.length) return false;       // sin datos no se puede afirmar
    var suyas = fs.filter(function (f) {
      return String(f.promo_tipo) === String(tipo) &&
             (!promoId || String(f.promo_id) === String(promoId));
    });
    // "candidate" no es estar adentro: es Meli ofreciéndotela.
    var adentro = suyas.filter(function (f) {
      return f.status === 'started' || f.status === 'pending';
    }).length > 0;
    return adentro === !!quiereAdentro;
  };

  if (concuerda(filas))
    return { filas: filas, confirmado: true, fuente: 'la publicación' };

  // La vista de la publicación no concuerda. Antes de esperar, se le pregunta
  // a la LISTA DE LA CAMPAÑA, que es la que ve el seller center y la que se
  // actualiza primero. Medido: tras una baja con 200 OK, la lista del cupón ya
  // no traía el ítem mientras la vista de la publicación siguió diciendo
  // "started" más de un minuto. Preguntar acá evita esperar de gusto.
  var enCamp = _enListaCampania(itemId, tipo, promoId);
  if (enCamp !== null && enCamp === !!quiereAdentro) {
    Logger.log('refresco: la publicación va atrasada, pero la campaña CONFIRMA');
    return { filas: filas, confirmado: true, fuente: 'la lista de la campaña' };
  }

  Logger.log('refresco: no concuerda (' + tipo + (promoId ? ' ' + promoId : '') +
             '), campaña dice ' + enCamp + '; releo la publicación en 4s');
  Utilities.sleep(4000);
  var segunda = _refrescarItem(itemId);
  if (segunda && segunda.length) filas = segunda;
  var ok = concuerda(filas);
  Logger.log('refresco: segunda lectura ' + (ok ? 'CONFIRMA' : 'sigue sin confirmar'));
  return { filas: filas, confirmado: ok, fuente: 'la publicación' };
}

/**
 * ¿La publicación figura dentro de esa campaña, según la lista de la campaña?
 *
 * Devuelve true / false, o null si no se pudo averiguar —que NO es lo mismo
 * que "no está" y por eso no se colapsa a false—.
 *
 * Se usa el filtro item_id que documenta Meli: la lista pagina de a 50 y una
 * campaña puede tener cientos de ítems, así que pedirla entera para buscar uno
 * sería lento y además podría no venir en la primera página.
 */
function _enListaCampania(itemId, tipo, promoId) {
  if (!promoId || !tipo) return null;
  try {
    const r = mlGet('/seller-promotions/promotions/' + encodeURIComponent(promoId) +
                    '/items?promotion_type=' + encodeURIComponent(tipo) +
                    '&item_id=' + encodeURIComponent(itemId) + '&app_version=v2');
    const arr = _arr(r);
    var enc = null;
    arr.forEach(function (x) { if (String(x.id) === String(itemId)) enc = x; });
    // Si el filtro no lo trajo, puede ser que no esté o que el filtro no aplique;
    // una lista vacía con filtro por ítem se lee como "no está".
    if (!enc) return arr.length === 0 ? false : false;
    return enc.status === 'started' || enc.status === 'pending';
  } catch (e) {
    Logger.log('lista de campaña ' + promoId + ': ' + e);
    return null;
  }
}

/** ¿La publicación figura participando de esa promoción en estas filas? */
function _figuraAdentro(filas, tipo, promoId) {
  if (!filas || !filas.length) return false;
  return filas.some(function (f) {
    return String(f.promo_tipo) === String(tipo) &&
           (!promoId || String(f.promo_id) === String(promoId)) &&
           (f.status === 'started' || f.status === 'pending');
  });
}

/** El nombre de la campaña, para que el registro no muestre un P-MLA1790... */
function _nombreCampania(filas, tipo, promoId) {
  if (!filas) return '';
  for (var i = 0; i < filas.length; i++) {
    const f = filas[i];
    if (String(f.promo_tipo) === String(tipo) &&
        (!promoId || String(f.promo_id) === String(promoId)) && f.promo_nombre)
      return f.promo_nombre;
  }
  return '';
}

/**
 * El id de la oferta de una publicación en una campaña.
 *
 * Meli lo llama de dos maneras según de dónde lo mires: ref_id en la vista de
 * la publicación, offer_id en la lista de la campaña. Es el mismo número, y
 * hace falta para dar de baja las campañas que arma él (SMART, PRICE_MATCHING):
 * ahí el DELETE contesta "Offer id is required" si no se lo mandás.
 */
function _offerIdDe(itemId, tipo, promoId) {
  try {
    var enc = null;
    _arr(mlGet('/seller-promotions/items/' + itemId + '?app_version=v2')).forEach(function (p) {
      if (String(p.type) === String(tipo) &&
          (!promoId || String(p.id) === String(promoId))) enc = p;
    });
    if (enc && (enc.ref_id || enc.offer_id)) return enc.ref_id || enc.offer_id;
  } catch (e) { Logger.log('offer_id por ítem: ' + e); }
  // Segundo intento: la lista de la campaña, que lo trae como offer_id.
  try {
    if (!promoId) return '';
    var hallado = '';
    _arr(mlGet('/seller-promotions/promotions/' + encodeURIComponent(promoId) +
               '/items?promotion_type=' + encodeURIComponent(tipo) +
               '&item_id=' + encodeURIComponent(itemId) + '&app_version=v2'))
      .forEach(function (x) {
        if (String(x.id) === String(itemId) && (x.offer_id || x.ref_id))
          hallado = x.offer_id || x.ref_id;
      });
    return hallado;
  } catch (e) { Logger.log('offer_id por campaña: ' + e); return ''; }
}

function salirDePromo(a) {
  const armarQs = function (offerId) {
    var q = '?app_version=v2&promotion_type=' + encodeURIComponent(a.promotion_type);
    if (a.promotion_id) q += '&promotion_id=' + encodeURIComponent(a.promotion_id);
    if (offerId) q += '&offer_id=' + encodeURIComponent(offerId);
    return q;
  };

  var offerId = a.offer_id || '';
  var qs = armarQs(offerId);
  const t0 = Date.now();
  var r = _mlEscribir('delete', '/seller-promotions/items/' + a.item_id + qs, null);

  /* "Offer id is required": las campañas que arma Meli —SMART, PRICE_MATCHING—
     no se dan de baja por (ítem + campaña) sino por la oferta concreta. El id
     está en la API pero hasta ahora no se guardaba, así que se busca en el
     momento y se reintenta. Con la hoja al día llega en el pedido y esto ni
     hace falta. */
  if (!r.ok && /offer.?id is required/i.test(String(r.texto)) && !offerId) {
    offerId = _offerIdDe(a.item_id, a.promotion_type, a.promotion_id);
    Logger.log('salir ' + a.item_id + ': Meli pide offer_id, encontré "' + offerId + '"');
    if (offerId) {
      qs = armarQs(offerId);
      r = _mlEscribir('delete', '/seller-promotions/items/' + a.item_id + qs, null);
    }
  }

  // Sumar y sacar enseguida no funciona: Meli tarda unos segundos en registrar
  // la oferta y mientras tanto contesta "No offers found for item". Medido con
  // 1,2 s de espera, que no alcanzó. Si es ese error, se espera y se reintenta
  // una vez: es la diferencia entre poder deshacer un clic y no poder.
  if (!r.ok && /No offers found for item/i.test(String(r.texto))) {
    Logger.log('salir ' + a.item_id + ': la oferta todavía no figura, reintento en 5s');
    Utilities.sleep(5000);
    r = _mlEscribir('delete', '/seller-promotions/items/' + a.item_id + qs, null);
  }

  const tEscritura = Date.now() - t0;
  const ficha = _fichaItem(a.item_id);
  if (!r.ok) {
    _log('salir', a.item_id, a.promotion_type + ' ' + (a.promotion_id || ''),
         'ERROR ' + r.code + ' ' + r.texto,
         { sku: ficha.sku, producto: ficha.producto, tipo: a.promotion_type,
           campania: a.promotion_id || '', resultado: 'rechazado',
           motivo: _mensajeError(r) });
    throw new Error(_mensajeError(r));
  }
  const t1 = Date.now();
  const conf = _refrescarConfirmado(a.item_id, a.promotion_type, a.promotion_id, false);
  const filas = conf.filas;
  const tRefresco = Date.now() - t1;
  const t2 = Date.now();
  const fuera = conf.confirmado;
  _log('salir', a.item_id, a.promotion_type + ' ' + (a.promotion_id || ''), 'OK',
       { sku: ficha.sku, producto: ficha.producto, tipo: a.promotion_type,
         campania: _nombreCampania(filas, a.promotion_type, a.promotion_id) || a.promotion_id || '',
         resultado: fuera ? 'hecho' : 'dudoso', confirmado: fuera,
         motivo: fuera ? '' : 'Meli aceptó el pedido pero al releer la publicación la ' +
                              'promoción todavía figuraba puesta.' });
  const ms = { meli: tEscritura, refresco: tRefresco, log: Date.now() - t2, total: Date.now() - t0 };
  Logger.log('salir ' + a.item_id + ' → ' + JSON.stringify(ms));
  return { ok: true, filas: filas, ms: ms,
           confirmado: conf.confirmado, fuente: conf.fuente };
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
  // En minúsculas: Meli manda los códigos en MAYÚSCULAS
  // (ERROR_CREDIBILITY_DISCOUNTED_PRICE) y las claves de acá estaban escritas
  // en minúscula, así que la traducción más usada —la del precio no creíble—
  // nunca llegaba a dispararse y el usuario veía el JSON crudo.
  const clave = ((b.error || '') + ' ' + (b.message || '') + ' ' +
                 ((b.cause && b.cause[0] && b.cause[0].error_code) || '')).toLowerCase();
  const mapa = {
    // El código real que manda Meli es ERROR_CREDIBILITY_DISCOUNTED_PRICE.
    error_credibility_discounted_price:
      'Precio no creíble. Meli compara contra tu precio de venta de los últimos ~7 días. ' +
      'Hay que sacar las ofertas, actualizar el precio y esperar la ventana.',
    buyer_discount_not_in_range:      'El descuento debe estar entre 5% y 80%.',
    best_buyer_discount_not_in_range: 'El descuento para mejores compradores debe estar entre 5% y 80%.',
    discount_below_5_percent_difference:
      'Con descuento general de hasta 35%, el tramo de mejores compradores debe ser al menos 5% mayor.',
    discount_below_10_percent_difference:
      'Con descuento general mayor a 35%, el tramo de mejores compradores debe ser al menos 10% mayor.',
    entity_locked: 'El ítem está bloqueado unos segundos. Reintentá.',
    // Cupones del vendedor
    'start_date cannot be earlier than today':
      'La fecha de inicio no puede ser anterior a hoy.',
    'finish_date cannot be earlier than start_date':
      'La fecha de fin no puede ser anterior a la de inicio.',
    'maximum period cannot exceed the allowed':
      'El plazo máximo de una campaña de cupones es de 31 días.',
    'minimum period cannot be lower than allowed':
      'La campaña tiene que durar al menos un día.',
    'not upgradable':
      'Ese campo no se puede cambiar con la campaña ya arrancada. ' +
      'Con el cupón corriendo Meli solo deja tocar el nombre, la fecha de fin ' +
      'y el presupuesto (y el presupuesto solo hacia arriba).',
    // Medido contra la cuenta real: Meli NO deja crear campañas de cupones por
    // API en MLA. La documentación lo decía ("disponible solo para MLB") y
    // resultó ser cierto para la creación, aunque los cupones ya creados sí se
    // leen y se administran desde acá.
    'not allowed to create this type of promotion':
      'Mercado Libre no te deja crear campañas de cupones por API en Argentina: ' +
      'esa parte es solo para Brasil (MLB). El cupón hay que crearlo en el seller ' +
      'center; una vez creado, desde acá lo ves y le sumás publicaciones.',
    // Medido: MLA tampoco está habilitado para editar ni borrar la campaña.
    // El mensaje de Meli es literal: "Site MLA is not enabled for update seller
    // coupon campaigns".
    'is not enabled for update seller coupon':
      'Mercado Libre no te deja editar campañas de cupones por API en Argentina ' +
      '(solo Brasil). El nombre, el presupuesto y las fechas se cambian en el ' +
      'seller center. Lo que sí podés hacer desde acá es sumar y sacar publicaciones.',
    'is not enabled for delete seller coupon':
      'Mercado Libre no te deja borrar campañas de cupones por API en Argentina ' +
      '(solo Brasil). Se borra desde el seller center.',
    // Aparece al dar de baja un ítem enseguida de haberlo sumado: la oferta
    // todavía no quedó registrada del lado de Meli.
    // Si llegás a ver esto es porque el reintento con el id de la oferta
    // tampoco alcanzó: o Meli no lo devuelve para esa campaña, o hace falta
    // otro dato. El texto tiene que decir qué mirar, no repetir el inglés.
    'offer id is required':
      'Meli pide el id de la oferta para dar de baja esta campaña, y no lo pude ' +
      'encontrar. Sincronizá y reintentá; si sigue, fijate el renglón en Registro ' +
      'y pasámelo: ahí queda la campaña y la respuesta cruda.',
    'no offers found for item':
      'Meli dice que esa publicación no tiene ninguna oferta de ese tipo. Si la ' +
      'acabás de sumar, esperá unos segundos y reintentá: tarda en registrarla.',
    // Medido sobre PRICE_MATCHING: Meli no habilita la baja por API de las
    // campañas que arma ella misma. Contesta 403 con este texto, o 404 si se
    // le manda el promotion_id.
    "you must consume the correct access group":
      'Mercado Libre no habilita esta operación para la aplicación. Pasa con las ' +
      'campañas que arma Meli —las de "solo aceptar", como Gánale a la competencia—: ' +
      'de esas se sale desde el seller center, no por API.'
  };
  for (var k in mapa) if (clave.indexOf(k) >= 0) return mapa[k];

  // Meli a veces contesta {"message":"Errors: ","cause":[{"error_code":""}]},
  // o sea nada. Devolver eso tal cual deja al usuario mirando "Errors:" sin
  // información; mejor hablar por el código HTTP, que sí dice algo.
  const limpio = String(b.message || '').replace(/^Errors:\s*$/, '').trim();
  if (!limpio) {
    const porCodigo = {
      404: 'Mercado Libre no encontró esa oferta en la publicación. Puede que ya ' +
           'no esté, o que esta campaña no se administre por esta vía.',
      403: 'Mercado Libre no habilita esta operación para la aplicación.',
      401: 'La autorización venció. Reintentá; si sigue, corré paso1_autorizar.',
      429: 'Mercado Libre está frenando por exceso de llamadas. Esperá unos segundos.'
    };
    return porCodigo[r.code] || ('Mercado Libre respondió ' + r.code + ' sin explicar el motivo.');
  }
  return limpio;
}

/* ═══════════════════════════════════════════════════════════════════════════
   7b · CUPONES DEL VENDEDOR
   Es el único tipo de campaña que se crea entero desde acá: nombre, monto,
   fechas, presupuesto y código. Los otros los propone Meli y uno acepta.

   Endpoints (doc "Cupones del vendedor"):
     POST   /seller-promotions/promotions                    crear
     PUT    /seller-promotions/promotions/{id}               editar
     DELETE /seller-promotions/promotions/{id}               borrar
     GET    /seller-promotions/promotions/{id}               detalle
     GET    /seller-promotions/promotions/{id}/items         qué hay adentro

   El detalle es lo que NO baja en la sincronización y es justo lo que importa
   mirar todos los días: presupuesto restante y cupones usados. El presupuesto
   lo pone el vendedor entero —Meli no aporta nada acá— y cuando se agota, la
   campaña se termina sola.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Todos los cupones con su detalle y sus ítems, en paralelo.
 *
 * Va aparte de la sincronización a propósito: son dos llamadas por cupón y
 * cambian todo el tiempo (el presupuesto se consume con cada venta), así que
 * conviene pedirlas cuando se abre la pantalla y no una vez por día.
 */
function leerCupones() {
  const t0 = Date.now();
  const uid = P.getProperty('ML_USER_ID');
  if (!uid) throw new Error('Sin user_id. Corré paso1_autorizar.');

  var campanias = [];
  try {
    campanias = _arr(mlGet('/seller-promotions/users/' + uid + '?app_version=v2'))
      .filter(function (c) { return c.type === 'SELLER_COUPON_CAMPAIGN'; });
  } catch (err) { Logger.log('cupones · lista: ' + err); }

  if (!campanias.length) return { cupones: [], segundos: 0 };

  // Detalle + ítems de cada uno, todo en un solo viaje.
  const rutas = [];
  campanias.forEach(function (c) {
    rutas.push('/seller-promotions/promotions/' + c.id +
               '?promotion_type=SELLER_COUPON_CAMPAIGN&app_version=v2');
    rutas.push('/seller-promotions/promotions/' + c.id +
               '/items?promotion_type=SELLER_COUPON_CAMPAIGN&app_version=v2');
  });
  const res = mlGetMuchos(rutas);

  const cupones = campanias.map(function (c) {
    // OJO: mlGetMuchos devuelve el cuerpo ya parseado, indexado por la ruta.
    // No envuelve en {code, body} — eso lo hace el /items?ids= de Meli, que es
    // otra cosa. Una ruta que falló simplemente no está en el mapa.
    const d = res['/seller-promotions/promotions/' + c.id +
                  '?promotion_type=SELLER_COUPON_CAMPAIGN&app_version=v2'] || {};
    const items = _arr(res['/seller-promotions/promotions/' + c.id +
                  '/items?promotion_type=SELLER_COUPON_CAMPAIGN&app_version=v2']);

    return {
      id: c.id,
      nombre: d.name || c.name || '',
      sub_type: d.sub_type || '',
      status: d.status || c.status || '',
      monto_fijo:  d.fixed_amount != null ? d.fixed_amount : '',
      pct_fijo:    d.fixed_percentage != null ? d.fixed_percentage : '',
      compra_min:  d.min_purchase_amount != null ? d.min_purchase_amount : '',
      tope:        d.max_purchase_amount != null ? d.max_purchase_amount : '',
      codigo:      d.coupon_code || '',
      inicio: _fechaAR(d.start_date  || c.start_date),
      fin:    _fechaAR(d.finish_date || c.finish_date),
      presupuesto: d.budget != null ? d.budget : '',
      restante:    d.remaining_budget != null ? d.remaining_budget : '',
      usados:      d.used_coupons != null ? d.used_coupons : '',
      // Los ítems vienen con su propio status: candidate / pending / started /
      // finished. El precio siempre es 0 porque el cupón no toca el precio de
      // la publicación: el descuento se aplica en el checkout.
      items: items.map(function (x) {
        return { id: x.id, status: x.status || '',
                 lista: x.original_price != null ? x.original_price : '',
                 inicio: _fechaAR(x.start_date), fin: _fechaAR(x.end_date || x.finish_date) };
      })
    };
  });

  const seg = Math.round((Date.now() - t0) / 1000);
  Logger.log('cupones: ' + cupones.length + ' en ' + seg + 's');
  return { cupones: cupones, segundos: seg };
}

/**
 * Crea la campaña. Se validan acá los límites de la doc en vez de dejar que
 * Meli conteste un 400 pelado: así el mensaje dice qué corregir.
 */
function crearCupon(c) {
  const sub = String(c.sub_type || '');
  if (['FIXED_AMOUNT', 'FIXED_PERCENTAGE'].indexOf(sub) < 0)
    throw new Error('El subtipo tiene que ser FIXED_AMOUNT o FIXED_PERCENTAGE.');
  if (!c.name) throw new Error('Falta el nombre de la campaña.');
  if (!c.start_date || !c.finish_date) throw new Error('Faltan las fechas.');
  if (!(Number(c.budget) > 0)) throw new Error('Falta el presupuesto, y tiene que ser mayor a cero.');
  if (!(Number(c.min_purchase_amount) > 0)) throw new Error('Falta el monto mínimo de compra.');

  const dias = Math.round(
    (Date.parse(c.finish_date) - Date.parse(c.start_date)) / 864e5) + 1;
  if (dias > 31) throw new Error('La campaña dura ' + dias + ' días y el máximo es 31.');
  if (dias < 1)  throw new Error('La fecha de fin no puede ser anterior a la de inicio.');

  const body = {
    promotion_type: 'SELLER_COUPON_CAMPAIGN',
    name: String(c.name),
    sub_type: sub,
    start_date:  c.start_date,
    finish_date: c.finish_date,
    min_purchase_amount: Number(c.min_purchase_amount),
    budget: Number(c.budget)
  };
  if (sub === 'FIXED_AMOUNT') {
    if (!(Number(c.fixed_amount) > 0)) throw new Error('Falta el monto de descuento.');
    body.fixed_amount = Number(c.fixed_amount);
  } else {
    if (!(Number(c.fixed_percentage) > 0)) throw new Error('Falta el porcentaje de descuento.');
    // El tope es obligatorio en FIXED_PERCENTAGE: es cuánto reintegrás como
    // máximo por venta. Sin esto, un carrito grande se lleva el presupuesto.
    if (!(Number(c.max_purchase_amount) > 0))
      throw new Error('En un cupón por porcentaje el tope de reintegro es obligatorio.');
    body.fixed_percentage  = Number(c.fixed_percentage);
    body.max_purchase_amount = Number(c.max_purchase_amount);
  }
  // El código que ve el comprador no es este: Meli le pega adelante los cinco
  // primeros caracteres de tu nickname. Si no se manda, el cupón es para todos.
  if (c.partial_coupon_code)
    body.partial_coupon_code = String(c.partial_coupon_code).slice(0, 10);

  const r = _mlEscribir('post', '/seller-promotions/promotions?app_version=v2', body);
  if (!r.ok) {
    _log('cupon_crear', '', body.name + ' ' + sub, 'ERROR ' + r.code + ' ' + r.texto,
         { tipo:'CUPÓN', campania: body.name, resultado:'rechazado',
           precio: body.fixed_amount || body.fixed_percentage || '',
           motivo: _mensajeError(r) });
    throw new Error(_mensajeError(r));
  }
  _log('cupon_crear', (r.body || {}).id || '', 'presupuesto $' + body.budget, 'OK',
       { tipo:'CUPÓN', campania: body.name, resultado:'hecho', confirmado: !!(r.body||{}).id,
         precio: body.fixed_amount || body.fixed_percentage || '' });
  return { ok: true, cupon: r.body, lista: leerCupones() };
}

/**
 * Edita la campaña. Solo se mandan los campos que cambian; promotion_type es
 * obligatorio siempre. Con la campaña ya arrancada Meli solo deja tocar
 * nombre, fecha de fin y presupuesto (y el presupuesto solo hacia arriba).
 */
function editarCupon(promotionId, cambios) {
  if (!promotionId) throw new Error('Falta el id de la campaña.');
  const body = { promotion_type: 'SELLER_COUPON_CAMPAIGN' };
  ['name','start_date','finish_date','fixed_amount','fixed_percentage',
   'min_purchase_amount','max_purchase_amount','budget'].forEach(function (k) {
    if (cambios[k] !== undefined && cambios[k] !== '' && cambios[k] !== null)
      body[k] = (k === 'name' || k.indexOf('date') >= 0) ? String(cambios[k]) : Number(cambios[k]);
  });
  if (Object.keys(body).length === 1) throw new Error('No hay nada que cambiar.');

  const r = _mlEscribir('put', '/seller-promotions/promotions/' + promotionId +
                        '?app_version=v2', body);
  if (!r.ok) {
    _log('cupon_editar', promotionId, JSON.stringify(body), 'ERROR ' + r.code + ' ' + r.texto,
         { tipo:'CUPÓN', campania: body.name || promotionId, resultado:'rechazado',
           motivo: _mensajeError(r) });
    throw new Error(_mensajeError(r));
  }
  _log('cupon_editar', promotionId, JSON.stringify(body), 'OK',
       { tipo:'CUPÓN', campania: (r.body||{}).name || body.name || promotionId,
         resultado:'hecho', confirmado:true });
  return { ok: true, cupon: r.body, lista: leerCupones() };
}

function borrarCupon(promotionId) {
  if (!promotionId) throw new Error('Falta el id de la campaña.');
  const r = _mlEscribir('delete', '/seller-promotions/promotions/' + promotionId +
                        '?promotion_type=SELLER_COUPON_CAMPAIGN&app_version=v2', null);
  if (!r.ok) {
    _log('cupon_borrar', promotionId, '', 'ERROR ' + r.code + ' ' + r.texto,
         { tipo:'CUPÓN', campania: promotionId, resultado:'rechazado',
           motivo: _mensajeError(r) });
    throw new Error(_mensajeError(r));
  }
  _log('cupon_borrar', promotionId, '', 'OK',
       { tipo:'CUPÓN', campania: promotionId, resultado:'hecho', confirmado:true });
  return { ok: true, lista: leerCupones() };
}


/* ═══════════════════════════════════════════════════════════════════════════
   EL REGISTRO
   Un renglón por cada cosa que la app escribió en Mercado Libre.

   Antes guardaba cinco datos —hora, acción, item_id, un texto suelto y "OK"—
   y con eso no alcanzaba. Cuando hubo que averiguar por qué la app había
   dicho "no salió" sobre algo que sí había salido, el registro no podía
   contestarlo: no decía de qué producto era, ni a qué precio, ni —lo más
   importante— si el cambio había quedado de verdad. Un "OK" ahí solo quería
   decir "Meli contestó 200", que es otra cosa.

   Ahora cada renglón guarda:
     sku, producto     para leerlo sin tener que buscar el MLA en otro lado
     campania          el nombre, no el P-MLA1790...
     precio            a cuánto quedó
     resultado         hecho / rechazado / dudoso
     confirmado        si al releer la publicación el cambio estaba
     motivo            en castellano cuando Meli rechaza
     tecnico           la respuesta cruda, para cuando haga falta el detalle
   ═══════════════════════════════════════════════════════════════════════════ */

const LOG_CAB = ['ts','accion','item_id','sku','producto','tipo','campania',
                 'precio','resultado','confirmado','motivo','detalle','tecnico'];

/**
 * Anota una escritura.
 *
 * d es un objeto: { item_id, sku, producto, tipo, campania, precio,
 *                   resultado, confirmado, motivo, detalle, tecnico }
 * Se mantiene la firma vieja _log(accion, item, detalle, resultado) para no
 * romper las llamadas que ya existen.
 */
function _log(accion, item, detalle, resultado, extra) {
  try {
    const sh = _hojaLog();
    const d = extra || {};
    const crudo = String(resultado || '');
    // "OK" a secas es engañoso: dice que Meli contestó 200, no que el cambio
    // haya quedado. La palabra que va acá distingue las tres cosas.
    const estado = d.resultado || (crudo.indexOf('OK') === 0 ? 'hecho' : 'rechazado');
    sh.appendRow([
      new Date(), accion, item || '', d.sku || '', d.producto || '',
      d.tipo || '', d.campania || '', d.precio != null ? d.precio : '',
      estado,
      d.confirmado == null ? '' : (d.confirmado ? 'sí' : 'no'),
      d.motivo || (estado === 'rechazado' ? _motivoCorto(crudo) : ''),
      detalle || '', crudo.slice(0, 500)
    ]);
  } catch (e) { Logger.log('log: ' + e); }
}

/** La hoja Log, agrandándole la cabecera si venía de la versión de 5 columnas. */
function _hojaLog() {
  const sh = _hoja('Log', LOG_CAB);
  try {
    const ancho = sh.getLastColumn();
    if (ancho < LOG_CAB.length) {
      // Los renglones viejos se quedan como están: sus columnas nuevas van
      // vacías y el front las muestra igual. No se reescribe historia.
      sh.getRange(1, 1, 1, LOG_CAB.length).setValues([LOG_CAB])
        .setFontWeight('bold').setBackground('#EEF2F1');
    }
  } catch (e) {}
  return sh;
}

/** Saca el motivo en castellano de una respuesta cruda de Meli. */
function _motivoCorto(texto) {
  var body = null;
  try { body = JSON.parse(String(texto).replace(/^ERROR \d+ /, '')); } catch (e) {}
  if (!body) return String(texto).slice(0, 160);
  return _mensajeError({ code: 0, body: body, texto: String(texto) });
}

/** Los datos del producto para que el registro se lea sin decodificar nada. */
function _fichaItem(itemId) {
  try {
    const sh = _ss().getSheetByName('Datos');
    if (!sh || sh.getLastRow() < 2) return {};
    const cab = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const cId = cab.indexOf('item_id'), cSku = cab.indexOf('sku'), cTit = cab.indexOf('titulo');
    const todo = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    for (var i = 0; i < todo.length; i++)
      if (String(todo[i][cId]) === String(itemId))
        return { sku: todo[i][cSku], producto: String(todo[i][cTit] || '').slice(0, 60) };
  } catch (e) {}
  return {};
}


/* ═══════════════════════════════════════════════════════════════════════════
   8 · HOJAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * La planilla, abierta UNA sola vez por ejecución.
 *
 * SpreadsheetApp.openById() tarda cerca de un segundo y _hoja() la abría de
 * nuevo en cada llamada. Un "sumar" terminaba abriéndola tres veces —una para
 * refrescar el ítem, otra para el Log, otra para las etiquetas— y eso solo eran
 * ~3 segundos de los 10 que tardaba. La variable vive lo que dura la ejecución,
 * que es exactamente el alcance que queremos.
 */
var _SS = null, _SH = {};
function _ss() {
  if (!_SS) _SS = SpreadsheetApp.openById(SHEET_ID);
  return _SS;
}

function _hoja(nombre, cabecera) {
  if (_SH[nombre]) return _SH[nombre];
  const ss = _ss();
  var sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, cabecera.length).setValues([cabecera])
      .setFontWeight('bold').setBackground('#EEF2F1');
    sh.setFrozenRows(1);
  }
  _SH[nombre] = sh;
  return sh;
}

/**
 * Vuelca una hoja entera.
 *
 * Limpiaba y después escribía. Si escribir fallaba —por ejemplo porque las
 * filas tenían 34 valores y la cabecera 35, que es exactamente lo que pasó al
 * agregar la columna offer_id— la hoja quedaba con el título y nada más: los
 * datos se perdían y la app mostraba cero productos.
 *
 * Ahora las filas se emparejan al ancho de la cabecera ANTES de tocar nada, y
 * si algo no cuadra se corta sin limpiar. Una sincronización que falla tiene
 * que dejar los datos viejos, no dejarte sin datos.
 */
function _volcarHoja(nombre, cabecera, filas) {
  const sh = _hoja(nombre, cabecera);
  const ancho = cabecera.length;

  // Emparejar el ancho: se rellena lo que falte y se recorta lo que sobre.
  const normal = (filas || []).map(function (f) {
    const r = (f || []).slice(0, ancho);
    while (r.length < ancho) r.push('');
    return r;
  });

  // Se avisa si hubo que corregir: significa que alguien agregó una columna en
  // un lado y se olvidó del otro, y conviene enterarse por el log.
  const desparejas = (filas || []).filter(function (f) { return (f || []).length !== ancho; }).length;
  if (desparejas)
    Logger.log('OJO ' + nombre + ': ' + desparejas + ' filas no tenían ' + ancho +
               ' columnas. Se emparejaron, pero hay algo desalineado en el código.');

  sh.clear();
  sh.getRange(1, 1, 1, ancho).setValues([cabecera])
    .setFontWeight('bold').setBackground('#EEF2F1');
  if (normal.length) sh.getRange(2, 1, normal.length, ancho).setValues(normal);
  sh.setFrozenRows(1);
}


/* ═══════════════════════════════════════════════════════════════════════════
   9 · TRIGGERS Y DIAGNÓSTICO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Los dos triggers. Corrélo una vez; borra los que ya había, así no se
 * duplican si lo corrés de nuevo.
 *
 * El del token pasó de cada 4 h a cada 2 h, y no rota más seguido por eso:
 * ahora mira cuánto le queda y solo renueva si es menos de MARGEN_REFRESH.
 * Lo que cambia es que hay TRES pasadas dentro de la vida del token en vez de
 * una sola. Con una sola, si Google se saltea esa ejecución —pasa—, el token
 * se vencía antes de la siguiente y había que autorizar a mano.
 */
function instalarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'refrescarTokenProgramado' || f === 'sincronizarTodo') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refrescarTokenProgramado').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('sincronizarTodo').timeBased().atHour(7).everyDays(1).create();
  Logger.log('Triggers instalados: chequeo de token cada 2 h, sync diaria 07:00.');
  Logger.log('(el chequeo mira si hace falta; renovar sigue siendo ~1 vez cada 4 h)');
}

function diagnostico() {
  Logger.log('user_id: ' + P.getProperty('ML_USER_ID'));
  Logger.log('clave app: ' + CLAVE_APP);
  Logger.log('/users/me -> ' + JSON.stringify(mlGet('/users/me')).slice(0, 250));
  Logger.log('última sync: ' + (P.getProperty('ULTIMA_SYNC') || 'nunca'));
}
