// shelf-match.js — сопоставление введённого текста с полками (зонами) SEW.
// Файл НАШ (не из исходников SEW-Helper): подключён в manifest.json renderer
// ПЕРЕД content.js, чтобы комбобокс зон находил полку даже при вводе с
// английской раскладки («Njhujdsq Pfk» → «Торговый Зал»).
//
// Идея: у каждой полки три нормированных написания — кириллица, клавиши
// раскладки ЙЦУКЕН («Торговый Зал» → «njhujdsq pfk») и транслит («torgovyj zal»).
// Совпадение по любому из них. Нормализация общая для ввода и для полки,
// поэтому регистр, пробелы, дефисы и «ё» ничего не ломают.

// ЙЦУКЕН: кириллическая буква -> клавиша на той же физической клавише.
var SHELF_KC_MAP = {
  'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o',
  'з': 'p', 'х': '[', 'ъ': ']', 'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f', 'п': 'g',
  'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'ж': ';', 'э': "'", 'ё': '`',
  'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.',
};

// Транслит «по чтению» — на случай ввода латиницей уже с умыслом («torgovyy zal»).
var SHELF_TR_MAP = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
  'з': 'z', 'и': 'i', 'й': 'j', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c',
  'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'eh',
  'ю': 'yu', 'я': 'ya',
};

/** Канон текста: нижний регистр, «ё»→«е», только буквы и цифры (пробелы и
 * дефисы выкинуты — «Заказ 1-14» и «заказ114» сходятся). Одна и та же функция
 * применяется и к вводу, и к полке, поэтому сравнение честное. */
function shelfNormalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]/g, '');
}

function shelfTranslit(base, map) {
  var out = '';
  for (var i = 0; i < base.length; i++) {
    var ch = base.charAt(i);
    out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
  }
  return out;
}

/** Варианты написания полки для индекса поиска: [кириллица, ЙЦУКЕН, транслит]. */
function shelfSearchKeys(zone, cell) {
  var base = shelfNormalize(zone + ' ' + cell);
  if (!base) return [];
  var keys = [base];
  var kc = shelfTranslit(base, SHELF_KC_MAP);
  var tr = shelfTranslit(base, SHELF_TR_MAP);
  if (kc && keys.indexOf(kc) === -1) keys.push(kc);
  if (tr && keys.indexOf(tr) === -1) keys.push(tr);
  return keys;
}

/** Совпадает ли ввод пользователя с полкой (по любому из вариантов). */
function shelfMatches(keys, query) {
  var q = shelfNormalize(query);
  if (!q) return true;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(q) !== -1) return true;
  }
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    shelfNormalize: shelfNormalize,
    shelfSearchKeys: shelfSearchKeys,
    shelfMatches: shelfMatches,
  };
}
