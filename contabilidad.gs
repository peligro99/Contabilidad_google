// ---------- CONFIGURATION ----------
const SHEET_ID   = '1_PwBusbpQRsGLX4eEYopnywNPTVUvTakHw4C3bz9UwQ';
const SHEET_NAME = 'Contabilidad_google_test';

const TARGET_SENDER = 'colpatriaInforma@scotiabankcolpatria.com';
const TARGET_SUBJECT = 'Scotiabank Colpatria en Linea';
const LABEL_NAME     = 'ColpatriaProcesado';
// -----------------------------------

function checkNewColpatriaEmails() {
  const query = `from:${TARGET_SENDER} subject:"${TARGET_SUBJECT}" is:unread  -label:${LABEL_NAME}`;
  const threads = GmailApp.search(query, 0, 10); // máx 10 hilos por ejecución

  const label = getOrCreateLabel(LABEL_NAME);
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found`);

  threads.forEach(t => {
  if (threadHasLabel_(t, LABEL_NAME)) return;

  t.getMessages().forEach(msg => {
    if (msg.isDraft()) return;

    const body = msg.getPlainBody();
    const row  = parseBody_(body);
    if (row) {
      sheet.appendRow(row);
      const [comercio, montoNum, fecha, hora] = row;
      notifyTelegram([comercio, montoNum, fecha, hora], sheet, sheet.getLastRow());
      console.log('Row appended:', row);
    }
  });

  t.addLabel(label);  // <- etiquetamos todo el hilo
});
}

// ---------------- HELPERS ----------------
function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function threadHasLabel_(thread, labelName) {
  return thread.getLabels().some(l => l.getName() === labelName);
}

function parseBody_(body) {
  const regex = /([A-Z0-9ÁÉÍÓÚÜÑ\-\s]+)\s+([\d,.]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/gm;
  let m = regex.exec(body);
  if (!m) return null;

  const [_, comercio, montoTxt, fecha, hora] = m;
  const montoNum = parseFloat(montoTxt.replace(/,/g, ''));
  return [comercio.trim(), montoNum, fecha, hora];
}

// ---------- TRIGGER ----------
function createTimeTrigger() {
  // Borra triggers duplicados
  ScriptApp.getProjectTriggers()
           .filter(t => t.getHandlerFunction() === 'checkNewColpatriaEmails')
           .forEach(t => ScriptApp.deleteTrigger(t));

  // Crea uno que corra cada 5 minutos
  ScriptApp.newTrigger('checkNewColpatriaEmails')
           .timeBased()
           .everyMinutes(5)
           .create();
}
// ---------- TRIGGER TELEGRAM ----------
/**function setTriggers() {
  // Trigger para procesar respuestas de Telegram cada minuto
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processTelegramAnswers')) {
    ScriptApp.newTrigger('processTelegramAnswers')
             .timeBased()
             .everyMinutes(30)
             .create();
  }
}**/
function setTelegramPermanents() {
  // borra activadores viejos
  ['processTelegramAnswers', 'captureReply'].forEach(fn => {
    ScriptApp.getProjectTriggers()
             .filter(t => t.getHandlerFunction() === fn)
             .forEach(t => ScriptApp.deleteTrigger(t));
  });

  // crea los dos activadores PERMANENTES cada 2 min
  ScriptApp.newTrigger('processTelegramAnswers').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('captureReply')        .timeBased().everyMinutes(5).create();
}

//CONFIG TELEGRAM

const BOT_TOKEN = '8001713864:AAFv7iWxWsJjlpIuK4-4Z8ygRAuwWAriq5o';   // <-- token que te dio BotFather
const CHAT_ID   = '1361338955';           // <-- tu chatId personal

/****************************************************************
 * ENVÍA NOTIFICACIÓN CON BOTONES
 ***************************************************************/
function notifyTelegram(rowData, sheet, rowIndex) {
  const [comercio, monto, fecha, hora] = rowData;

  const kb = {
    inline_keyboard: [[
      {text: '🔢 Nº Tarjeta', callback_data: `card|${rowIndex}`},
      {text: '📂 Categoría', callback_data: `cat|${rowIndex}`}
    ]]
  };

  const text =
    `💳 *Nueva compra detectada*\n` +
    `• Comercio: *${comercio}*\n` +
    `• Monto: *$${monto.toLocaleString()}*\n` +
    `• Fecha: *${fecha} ${hora}*\n\n` +
    `👉 Pulsa los botones para rellenar tarjeta y categoría.`;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify(kb)
  };

  UrlFetchApp.fetch(url, {method: 'post', payload});
}

/****************************************************************
 * PROCESA LAS RESPUESTAS (WEBHOOK-LITE)
 *   – Lo más simple: poll cada X minutos
 ***************************************************************/
function processTelegramAnswers() {
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const obj = JSON.parse(res.getContentText());
  if (!obj.ok || !obj.result.length) return;

  const upd = obj.result[0];
  const data = upd.callback_query?.data;        // "card|123"  o  "cat|123"
  const userId = upd.callback_query?.from?.id.toString();

  if (!data || userId !== CHAT_ID) return;

  const [type, rowIdx] = data.split('|');
  const question = type === 'card'
        ? '¿Últimos 4 dígitos de la tarjeta?'
        : '¿Categoría? (Ej: Alimentación, Transporte, etc.)';

  // 1. Pregunta al usuario
  UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CHAT_ID,
      text: question,
      reply_markup: { force_reply: true }
    })
  });

  // 2. Confirma el botón (evita el relojito girando)
  UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/answerCallbackQuery', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ callback_query_id: upd.callback_query.id })
  });

  // 3. Borra el update de la cola
  UrlFetchApp.fetch(url + '?offset=' + (upd.update_id + 1));
}

function captureReply() {
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const obj = JSON.parse(res.getContentText());
  if (!obj.ok || !obj.result.length) return;

  // tomamos el último mensaje
  const upd = obj.result[obj.result.length - 1];
  const txt = upd.message?.text;
  const reply = upd.message?.reply_to_message?.text;

  if (!txt || !reply) return;

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (reply.includes('tarjeta')) {
    sheet.getRange(lastRow, 5).setValue(txt);
    sendTG('✅ Nº de tarjeta guardado: ' + txt);
  } else if (reply.includes('Categoría')) {
    sheet.getRange(lastRow, 6).setValue(txt);
    sendTG('✅ Categoría guardada: ' + txt);
  }

  // borra el update para no repetir
  UrlFetchApp.fetch(url + '?offset=' + (upd.update_id + 1));
}

function sendTG(text) {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: CHAT_ID, text: text })
  });
}

function testOneEmail() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  const row = ['MERCADOPAGO', 9428, '2025/09/04', '21:30:00'];
  sheet.appendRow(row);
  notifyTelegram(row, sheet, sheet.getLastRow());
  console.log('Fila y notificación forzadas');
}

function testRegex() {
  const body = ` 


`;

  const regex = /COMERCIO\s+MONTO\s+FECHA\s+HORA\s*\n([A-Z0-9ÁÉÍÓÚÜÑ\-\s]+)\s+([\d,.]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/gm;
  let lastMatch;
  let m;
  while ((m = regex.exec(body)) !== null) lastMatch = m;

  console.log('¿Match encontrado?', !!lastMatch);
  if (lastMatch) console.log('Array completo:', lastMatch);
}


function logFirstEmailBody() {
  const query = `from:${TARGET_SENDER} subject:"${TARGET_SUBJECT}"`;
  const threads = GmailApp.search(query, 0, 1);
  if (threads.length === 0) {
    console.log('No se encontraron correos con el remitente y asunto especificados.');
    return;
  }

  const firstThread = threads[0];
  const firstMessage = firstThread.getMessages()[0];
  const body = firstMessage.getPlainBody();

  console.log('------------------ INICIO DEL CUERPO DEL EMAIL ------------------');
  console.log(body);
  console.log('------------------- FIN DEL CUERPO DEL EMAIL --------------------');
}

function parseCorreo(correo) {
  const bancos = [
    {
      nombre: "Scotiabank Colpatria",
      remitente: /scotiabank|colpatria/i,
      asunto: /Scotiabank Colpatria/i,
      regex: /COMERCIO\s+MONTO\s+FECHA\s+HORA\s*\n([A-Z0-9ÁÉÍÓÚÜÑ\-\s]+)\s+([\d,.]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/m,
      map: (m) => ({
        comercio: m[1],
        monto: m[2],
        fecha: m[3],
        hora: m[4],
      }),
    },
    {
      nombre: "Bancolombia",
      remitente: /bancolombia\.com\.co/i,
      asunto: /Alertas y Notificaciones/i,
      regex: /Transferiste\s+\$([\d,.]+).*?\*([\d]+).*?\*([\d]+)\s+el\s+(\d{2}\/\d{2}\/\d{4})\s+a\s+las\s+(\d{2}:\d{2})/m,
      map: (m) => ({
        monto: m[1],
        cuenta_origen: m[2],
        cuenta_destino: m[3],
        fecha: m[4],
        hora: m[5],
      }),
    },
    {
      nombre: "BBVA",
      remitente: /bbva/i,
      asunto: /Compra Exitosa/i,
      regex: /Tarjeta terminada en:\s*\*([\d]+).*?Fecha.*?:\s*(\d{4}-\d{2}-\d{2}).*?Establecimiento:\s*([^\n]+).*?Valor:\s*\$([\d,.]+).*?Hora:\s*(\d{2}:\d{2})/ms,
      map: (m) => ({
        tarjeta: m[1],
        fecha: m[2],
        comercio: m[3],
        monto: m[4],
        hora: m[5],
      }),
    },
    {
      nombre: "Davivienda",
      remitente: /davivienda\.com/i,
      asunto: /DAVIVIENDA/i,
      regex: /Fecha:(\d{4}\/\d{2}\/\d{2}).*?Hora:(\d{2}:\d{2}:\d{2}).*?Valor Transacción:\s*\$([\d,.]+).*?Clase de Movimiento:\s*([^\n]+).*?Lugar de Transacción:\s*([^\n]+)/ms,
      map: (m) => ({
        fecha: m[1],
        hora: m[2],
        monto: m[3],
        movimiento: m[4],
        lugar: m[5],
      }),
    },
    {
      nombre: "PSE",
      remitente: /achcolombia\.com\.co/i,
      asunto: /PSE Transacción Aprobada/i,
      regex: /Estado.*?:\s*([^\n]+).*?CUS:\s*(\d+).*?Empresa:\s*([^\n]+).*?Valor de la Transacción:\s*\$?\s*([\d,.]+).*?Fecha.*?:\s*(\d{2}\/\d{2}\/\d{4})/ms,
      map: (m) => ({
        estado: m[1],
        cus: m[2],
        empresa: m[3],
        monto: m[4],
        fecha: m[5],
      }),
    },
  ];

  for (let banco of bancos) {
    if (banco.remitente.test(correo.remitente) && banco.asunto.test(correo.asunto)) {
      const m = banco.regex.exec(correo.body);
      if (m) {
        return {
          banco: banco.nombre,
          remitente: correo.remitente,
          asunto: correo.asunto,
          ...banco.map(m),
        };
      }
    }
  }

  return null; // No se identificó
}

// Ejemplo de uso
const correo = {
  remitente: "BBVA@bbvanet.com.co",
  asunto: "Compra Exitosa",
  body: `Ref:12250553
 
En BBVA nos transformamos para poner en tus manos todas las oportunidades del mundo. A continuación encuentras el comprobante de la transacción que realizaste.
 
Detalles de la operación:  
Tarjeta terminada en: *6156
Fecha de la operación: 2025-08-27
Establecimiento: Mercado pago*merc
Valor: $809,910.00
Hora: 11:02
Gracias por utilizar nuestros Canales Transaccionales. Como medida adicional de seguridad te recordamos la importancia de cambiar periódicamente tus claves de accesos a todos nuestros canales.`
};

console.log(parseCorreo(correo));
