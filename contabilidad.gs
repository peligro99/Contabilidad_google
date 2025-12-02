// ---------- CONFIGURATION ----------
const SHEET_ID   = '1_PwBusbpQRsGLX4eEYopnywNPTVUvTakHw4C3bz9UwQ';
const SHEET_NAME = 'Contabilidad_google_test';

const TARGET_SENDER  = 'cristianespinel95@gmail.com';
const TARGET_SUBJECT = 'Scotiabank Colpatria en Linea';
const LABEL_NAME     = 'ColpatriaProcesado';

const BOT_TOKEN = '8001713864:AAFv7iWxWsJjlpIuK4-4Z8ygRAuwWAriq5o';
const CHAT_ID   = '1361338955';
// -----------------------------------

// ==========================================
// 1. PROCESAMIENTO DE EMAILS (GMAIL -> SHEET)
// ==========================================
function checkNewColpatriaEmails() {
  const query = `from:${TARGET_SENDER} subject:"${TARGET_SUBJECT}" is:unread -label:${LABEL_NAME}`;
  const threads = GmailApp.search(query, 0, 10); 

  if (threads.length === 0) return;

  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found`);

  const label = getOrCreateLabel(LABEL_NAME);

  threads.forEach(t => {
    // Doble verificación para evitar procesar hilos ya etiquetados si el índice de Gmail tarda en actualizar
    if (threadHasLabel_(t, LABEL_NAME)) return;

    const messages = t.getMessages();
    messages.forEach(msg => {
      if (msg.isDraft()) return;
      
      const body = msg.getPlainBody();
      // Usamos matchAll por si hay múltiples transacciones en un solo correo (raro, pero posible)
      const transactions = parseBodyMultiple_(body); 
      
      transactions.forEach(row => {
        sheet.appendRow(row);
        const currentRowIndex = sheet.getLastRow(); // Obtenemos el índice exacto recién creado
        
        // Enviamos notificación pasando el índice exacto
        notifyTelegram(row, currentRowIndex);
        console.log('Fila agregada:', row);
      });
    });

    t.addLabel(label); 
    t.markRead(); // Opcional: marcar como leído en Gmail
  });
}

// ==========================================
// 2. PROCESAMIENTO DE TELEGRAM (TODO EN UNO)
// ==========================================
function processTelegramUpdates() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
  
  // Obtenemos el último offset procesado para no leer mensajes viejos repetidamente
  const props = PropertiesService.getScriptProperties();
  let lastOffset = parseInt(props.getProperty('LAST_OFFSET') || '0');
  
  const payload = {
    offset: lastOffset + 1,
    limit: 20 // Procesamos hasta 20 acciones de golpe
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });
  
  const obj = JSON.parse(res.getContentText());
  if (!obj.ok || !obj.result || obj.result.length === 0) return;

  // Abrimos la hoja UNA sola vez para todo el lote
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  let maxUpdateId = lastOffset;

  // --- BUCLE PARA PROCESAR CADA MENSAJE PENDIENTE ---
  obj.result.forEach(update => {
    maxUpdateId = update.update_id;

    // A) CASO: Click en Botón (Callback Query)
    if (update.callback_query) {
      handleButtonPress(update.callback_query);
    } 
    // B) CASO: Respuesta de Texto (Reply)
    else if (update.message && update.message.reply_to_message) {
      handleTextReply(update.message, sheet);
    }
  });

  // Guardamos el nuevo offset para la próxima ejecución
  props.setProperty('LAST_OFFSET', maxUpdateId.toString());
}

// --- MANEJO DE BOTONES ---
function handleButtonPress(cb) {
  const data = cb.data; // "card|123" o "cat|123"
  const chatId = cb.from.id.toString();

  if (chatId !== CHAT_ID) return;

  const [type, rowIdx] = data.split('|');
  
  // Guardamos en memoria QUÉ está editando el usuario.
  // Clave: "PENDING_1361338955" -> Valor: "card|123"
  PropertiesService.getScriptProperties().setProperty(`PENDING_${chatId}`, data);

  const question = type === 'card' 
    ? `💳 Editando Fila ${rowIdx}: ¿Últimos 4 dígitos?` 
    : `📂 Editando Fila ${rowIdx}: ¿Categoría?`;

  // 1. Respondemos a Telegram para quitar el relojito (IMPORTANTE)
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'post',
    payload: { callback_query_id: cb.id }
  });

  // 2. Enviamos la pregunta forzando respuesta
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'post',
    payload: {
      chat_id: CHAT_ID,
      text: question,
      reply_markup: JSON.stringify({ force_reply: true, selective: true })
    }
  });
}

// --- MANEJO DE RESPUESTAS DE TEXTO ---
function handleTextReply(msg, sheet) {
  const chatId = msg.from.id.toString();
  const text = msg.text;

  // Recuperamos qué estaba editando el usuario
  const pendingAction = PropertiesService.getScriptProperties().getProperty(`PENDING_${chatId}`);
  
  if (!pendingAction) {
    sendTG("⚠️ No sé a qué transacción corresponde esto. Pulsa el botón de nuevo.");
    return;
  }

  const [type, rowIdx] = pendingAction.split('|');
  const rowIndex = parseInt(rowIdx);

  // Validamos que la fila exista (por seguridad)
  if (rowIndex > sheet.getLastRow()) {
     sendTG("❌ Error: La fila ya no parece existir.");
     return;
  }

  if (type === 'card') {
    sheet.getRange(rowIndex, 5).setValue(text); // Columna 5: Tarjeta
    sendTG(`✅ Tarjeta actualizada en fila ${rowIndex}: ${text}`);
  } else if (type === 'cat') {
    sheet.getRange(rowIndex, 6).setValue(text); // Columna 6: Categoría
    sendTG(`✅ Categoría actualizada en fila ${rowIndex}: ${text}`);
  }

  // Limpiamos la memoria
  PropertiesService.getScriptProperties().deleteProperty(`PENDING_${chatId}`);
}

// ==========================================
// 3. UTILIDADES Y TRIGGERS
// ==========================================

function notifyTelegram(rowData, rowIndex) {
  const [comercio, monto, fecha, hora] = rowData;
  
  // Guardamos el rowIndex en el botón
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
    `• Fecha: *${fecha} ${hora}*\n` +
    `• Fila ID: *${rowIndex}*`; // Útil para depurar

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify(kb)
    }
  });
}

function sendTG(text) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'post',
    payload: { chat_id: CHAT_ID, text: text }
  });
}

// Helper: Extrae TODAS las coincidencias del cuerpo, no solo la primera
function parseBodyMultiple_(body) {
  const regex = /([A-Z0-9ÁÉÍÓÚÜÑ\-\s]+)\s+([\d,.]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})/gm;
  const results = [];
  let m;
  while ((m = regex.exec(body)) !== null) {
    const [_, comercio, montoTxt, fecha, hora] = m;
    const montoNum = parseFloat(montoTxt.replace(/,/g, ''));
    results.push([comercio.trim(), montoNum, fecha, hora]);
  }
  return results;
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function threadHasLabel_(thread, labelName) {
  return thread.getLabels().some(l => l.getName() === labelName);
}

// ==========================================
// 4. CONFIGURACIÓN DE ACTIVADORES
// ==========================================
function setAllTriggers() {
  // Borrar todos los triggers anteriores para limpiar
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));

  // 1. Revisar correos cada 5 minutos
  ScriptApp.newTrigger('checkNewColpatriaEmails')
           .timeBased().everyMinutes(5).create();

  // 2. Revisar Telegram cada 1 minuto (Lo más rápido permitido por triggers simples)
  // Nota: Para velocidad real, necesitarías Webhooks (doPost), pero esto mejora mucho la versión actual.
  ScriptApp.newTrigger('processTelegramUpdates')
           .timeBased().everyMinutes(1).create();
           
  console.log("Activadores configurados correctamente.");
}
function FORCE_CLEAR_TELEGRAM_QUEUE() {
  // Asegúrate de que BOT_TOKEN esté definido arriba en tu código
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates';
  
  // 1. Pedimos todo lo pendiente
  const res = UrlFetchApp.fetch(url);
  const data = JSON.parse(res.getContentText());
  
  if (data.result.length === 0) {
    console.log("✅ La cola de Telegram ya está vacía. No hay mensajes atascados.");
    return;
  }
  
  // 2. Buscamos el ID del último mensaje
  const lastUpdateId = data.result[data.result.length - 1].update_id;
  
  // 3. Hacemos una petición con offset + 1 para confirmar lectura de TODO
  // Esto le dice a Telegram: "Olvida todo lo anterior a este número"
  const clearUrl = url + '?offset=' + (lastUpdateId + 1);
  UrlFetchApp.fetch(clearUrl);
  
  console.log(`🗑️ Se han eliminado ${data.result.length} mensajes atascados de la cola.`);
}