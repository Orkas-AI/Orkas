#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Every electron-builder extraResources destination must be declared here.
// Some destinations have their own specialist verifier; this registry makes a
// package.json addition fail tests until its verification ownership is explicit.
const EXTRA_RESOURCES_CONTRACT = Object.freeze({
  'embedding-model': 'pinned-offline-resource',
  runtime: 'target-runtime-gate',
  builtin: 'builtin-resource-contract',
  officecli: 'officecli-release-gate',
  'xls-reader': 'pinned-offline-resource',
  '.': 'mac-localized-metadata',
});

const XLS_READER_CONTRACT = Object.freeze({
  "kind": "xls-reader",
  "id": "2.0.2",
  "source": "https://pypi.org/project/xlrd/2.0.2/",
  "files": [
    {
      "name": "LICENSE",
      "bytes": 3771,
      "sha256": "b5a5dbce60265e305a815a6cb83ed07f24519d8ba644f2a307994488bced8815"
    },
    {
      "name": "read.py",
      "bytes": 3179,
      "sha256": "ef70f29110c9b0e7b622865a912e69fd3cb5ae1ffad37ea347a6666e92a7e341"
    },
    {
      "name": "xlrd-2.0.2-py2.py3-none-any.whl",
      "bytes": 96555,
      "sha256": "ea762c3d29f4cca48d82df517b6d89fbce4db3107f9d78713e48cd321d5c9aa9"
    }
  ]
});

const EMBEDDING_MODEL_CONTRACT = Object.freeze({
  kind: 'embedding-model',
  id: 'fast-bge-small-zh-v1.5',
  source: 'https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-zh-v1.5.tar.gz',
  filesSource: 'https://huggingface.co/Qdrant/bge-small-zh-v1.5/resolve/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/',
  archive: Object.freeze({
    bytes: 54_584_282,
    sha256: 'bf023219b6029148fddf764d248808816c0ca1f107f058231bb1ae0fa526f83f',
  }),
  files: Object.freeze([
    Object.freeze({ name: 'config.json', bytes: 739, sha256: '9088751d39abbf86ec3d19ffca92ad62ad19075f7e59712e6c71217fa125d1d3' }),
    Object.freeze({ name: 'model_optimized.onnx', bytes: 94_781_076, sha256: '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38' }),
    Object.freeze({ name: 'ort_config.json', bytes: 1_234, sha256: '97e78d1d21c2eb719e865b018f17915df6a12ed987446eb7f3f3a783a5afb1e1' }),
    Object.freeze({ name: 'special_tokens_map.json', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' }),
    Object.freeze({ name: 'tokenizer.json', bytes: 439_125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' }),
    Object.freeze({ name: 'tokenizer_config.json', bytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' }),
    Object.freeze({ name: 'vocab.txt', bytes: 109_540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' }),
  ]),
});

const MAC_LOCALIZED_METADATA_CONTRACT = Object.freeze([
  Object.freeze({
    directory: "en.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas uses Bluetooth to verify that your passkey phone is nearby.",
      NSMicrophoneUsageDescription: "Orkas uses the microphone for voice input and websites you authorize.",
      NSCameraUsageDescription: "Orkas lets websites use the camera with your permission.",
    }),
  }),
  Object.freeze({
    directory: "ja.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas は Bluetooth を使用して、パスキーを保存したスマートフォンが近くにあることを確認します。",
      NSMicrophoneUsageDescription: "Orkas は音声入力と許可したウェブサイトでマイクを使用します。",
      NSCameraUsageDescription: "Orkas は許可を得てウェブサイトでカメラを使用します。",
    }),
  }),
  Object.freeze({
    directory: "zh-Hans.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas 使用蓝牙确认保存通行密钥的手机在附近。",
      NSMicrophoneUsageDescription: "Orkas 使用麦克风进行语音输入，并供你授权的网站使用。",
      NSCameraUsageDescription: "Orkas 经你允许后，让网站使用摄像头。",
    }),
  }),
  Object.freeze({
    directory: "es.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas usa Bluetooth para comprobar que el teléfono con tu clave de acceso está cerca.",
      NSMicrophoneUsageDescription: "Orkas usa el micrófono para la entrada de voz y los sitios que autorizas.",
      NSCameraUsageDescription: "Orkas permite que los sitios usen la cámara con tu permiso.",
    }),
  }),
  Object.freeze({
    directory: "fr.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas utilise le Bluetooth pour vérifier que le téléphone contenant votre clé d’accès est à proximité.",
      NSMicrophoneUsageDescription: "Orkas utilise le microphone pour la saisie vocale et les sites que vous autorisez.",
      NSCameraUsageDescription: "Orkas permet aux sites d’utiliser la caméra avec votre autorisation.",
    }),
  }),
  Object.freeze({
    directory: "ko.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas는 Bluetooth로 패스키가 저장된 휴대폰이 근처에 있는지 확인합니다.",
      NSMicrophoneUsageDescription: "Orkas는 음성 입력과 사용자가 허용한 웹사이트에 마이크를 사용합니다.",
      NSCameraUsageDescription: "Orkas는 사용자의 허락을 받아 웹사이트에서 카메라를 사용합니다.",
    }),
  }),
  Object.freeze({
    directory: "de.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas verwendet Bluetooth, um zu prüfen, ob Ihr Telefon mit dem Passkey in der Nähe ist.",
      NSMicrophoneUsageDescription: "Orkas verwendet das Mikrofon für die Spracheingabe und von Ihnen autorisierte Websites.",
      NSCameraUsageDescription: "Orkas erlaubt Websites mit Ihrer Zustimmung den Kamerazugriff.",
    }),
  }),
  Object.freeze({
    directory: "ru.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas использует Bluetooth, чтобы убедиться, что телефон с ключом доступа находится рядом.",
      NSMicrophoneUsageDescription: "Orkas использует микрофон для голосового ввода и сайтов, которым вы дали разрешение.",
      NSCameraUsageDescription: "Orkas позволяет сайтам использовать камеру с вашего разрешения.",
    }),
  }),
  Object.freeze({
    directory: "it.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas usa Bluetooth per verificare che il telefono con la tua passkey sia nelle vicinanze.",
      NSMicrophoneUsageDescription: "Orkas usa il microfono per l’inserimento vocale e i siti che autorizzi.",
      NSCameraUsageDescription: "Orkas consente ai siti di usare la fotocamera con la tua autorizzazione.",
    }),
  }),
  Object.freeze({
    directory: "hi.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas ब्लूटूथ से पुष्टि करता है कि आपकी पासकी वाला फ़ोन पास में है।",
      NSMicrophoneUsageDescription: "Orkas वॉइस इनपुट के लिए और आपकी अनुमति वाली वेबसाइटों पर माइक्रोफ़ोन का उपयोग करता है।",
      NSCameraUsageDescription: "Orkas आपकी अनुमति से वेबसाइटों को कैमरा इस्तेमाल करने देता है।",
    }),
  }),
  Object.freeze({
    directory: "id.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas menggunakan Bluetooth untuk memastikan ponsel dengan kunci sandi Anda berada di dekat Anda.",
      NSMicrophoneUsageDescription: "Orkas menggunakan mikrofon untuk input suara dan situs yang Anda izinkan.",
      NSCameraUsageDescription: "Orkas mengizinkan situs menggunakan kamera dengan izin Anda.",
    }),
  }),
  Object.freeze({
    directory: "th.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas ใช้บลูทูธเพื่อยืนยันว่าโทรศัพท์ที่เก็บพาสคีย์อยู่ใกล้คุณ",
      NSMicrophoneUsageDescription: "Orkas ใช้ไมโครโฟนสำหรับการป้อนข้อมูลด้วยเสียงและเว็บไซต์ที่คุณอนุญาต",
      NSCameraUsageDescription: "Orkas ให้เว็บไซต์ใช้กล้องเมื่อคุณอนุญาต",
    }),
  }),
  Object.freeze({
    directory: "tr.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas, geçiş anahtarınızın bulunduğu telefonun yakında olduğunu doğrulamak için Bluetooth kullanır.",
      NSMicrophoneUsageDescription: "Orkas, sesli giriş ve izin verdiğiniz siteler için mikrofonu kullanır.",
      NSCameraUsageDescription: "Orkas, izninizle sitelerin kamerayı kullanmasına olanak tanır.",
    }),
  }),
  Object.freeze({
    directory: "vi.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas dùng Bluetooth để xác nhận điện thoại lưu khóa truy cập của bạn ở gần.",
      NSMicrophoneUsageDescription: "Orkas sử dụng micrô để nhập liệu bằng giọng nói và cho các trang web bạn cho phép.",
      NSCameraUsageDescription: "Orkas cho phép trang web sử dụng máy ảnh khi bạn đồng ý.",
    }),
  }),
  Object.freeze({
    directory: "zh-Hant.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas 使用藍牙確認儲存通行密鑰的手機在附近。",
      NSMicrophoneUsageDescription: "Orkas 使用麥克風進行語音輸入，並供你授權的網站使用。",
      NSCameraUsageDescription: "Orkas 經你允許後，讓網站使用攝影機。",
    }),
  }),
  Object.freeze({
    directory: "pt-BR.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "O Orkas usa o Bluetooth para verificar se o celular com a sua chave de acesso está por perto.",
      NSCameraUsageDescription: "O Orkas permite que os sites usem a câmera com a sua permissão.",
      NSMicrophoneUsageDescription: "O Orkas usa o microfone para a entrada de voz e permite que os sites que você autorizar também o utilizem.",
    }),
  }),
  Object.freeze({
    directory: "pt-PT.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "O Orkas utiliza Bluetooth para confirmar que o telemóvel com a sua chave de acesso está por perto.",
      NSMicrophoneUsageDescription: "O Orkas utiliza o microfone para a entrada de voz e os sites que autoriza.",
      NSCameraUsageDescription: "Orkas permite que os sites usem a câmara com a sua permissão.",
    }),
  }),
  Object.freeze({
    directory: "es-419.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "Orkas usa Bluetooth para comprobar que el teléfono con tu clave de acceso está cerca.",
      NSMicrophoneUsageDescription: "Orkas usa el micrófono para la entrada de voz y los sitios que autorizas.",
      NSCameraUsageDescription: "Orkas permite que los sitios usen la cámara con tu permiso.",
    }),
  }),
  Object.freeze({
    directory: "ar.lproj",
    values: Object.freeze({
      NSBluetoothAlwaysUsageDescription: "يستخدم Orkas البلوتوث للتأكد من أن الهاتف الذي يحفظ مفتاح المرور قريب منك.",
      NSMicrophoneUsageDescription: "يستخدم Orkas الميكروفون للإدخال الصوتي والمواقع التي تسمح لها.",
      NSCameraUsageDescription: "يسمح Orkas للمواقع باستخدام الكاميرا بإذنك.",
    }),
  }),
]);

const MAC_LOCALIZED_METADATA_FILTERS = Object.freeze(
  MAC_LOCALIZED_METADATA_CONTRACT.map((item) => `${item.directory}/InfoPlist.strings`),
);

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function requireDirectory(label, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`[packaged-resource-gate] missing ${label}: ${dir}`);
  }
}

function requirePinnedFile(label, file, expected) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`[packaged-resource-gate] missing ${label}: ${file}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[packaged-resource-gate] ${label} is not a file: ${file}`);
  }
  if (stat.size !== expected.bytes) {
    throw new Error(`[packaged-resource-gate] ${label} size mismatch: expected ${expected.bytes}, got ${stat.size}: ${file}`);
  }
  const actualSha256 = sha256File(file);
  if (actualSha256 !== expected.sha256) {
    throw new Error(`[packaged-resource-gate] ${label} sha256 mismatch: expected ${expected.sha256}, got ${actualSha256}: ${file}`);
  }
}

function requireOnlyEntries(dir, allowed, label) {
  const expected = new Set(allowed);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!expected.has(entry.name)) {
      throw new Error(`[packaged-resource-gate] unexpected ${label}: ${path.join(dir, entry.name)}`);
    }
  }
}

function parseAppleStrings(text, label = 'InfoPlist.strings') {
  text = String(text || '').replace(/^\uFEFF/, '');
  let offset = 0;
  const values = {};

  function fail(message) {
    throw new Error(`[packaged-resource-gate] invalid ${label} at offset ${offset}: ${message}`);
  }

  function skipTrivia() {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) {
        offset += 1;
        continue;
      }
      if (text.startsWith('//', offset)) {
        const end = text.indexOf('\n', offset + 2);
        offset = end < 0 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith('/*', offset)) {
        const end = text.indexOf('*/', offset + 2);
        if (end < 0) fail('unterminated block comment');
        offset = end + 2;
        continue;
      }
      break;
    }
  }

  function quoted() {
    skipTrivia();
    if (text[offset] !== '"') fail('expected a quoted string');
    offset += 1;
    let value = '';
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return value;
      if (char !== '\\') {
        value += char;
        continue;
      }
      if (offset >= text.length) fail('unterminated escape sequence');
      const escaped = text[offset++];
      const simple = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
        value += simple[escaped];
        continue;
      }
      if (escaped === 'u' || escaped === 'U') {
        const hex = text.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
        continue;
      }
      fail(`unsupported escape \\${escaped}`);
    }
    fail('unterminated quoted string');
  }

  skipTrivia();
  while (offset < text.length) {
    const key = quoted();
    skipTrivia();
    if (text[offset] !== '=') fail('expected = after key');
    offset += 1;
    const value = quoted();
    skipTrivia();
    if (text[offset] !== ';') fail('expected ; after value');
    offset += 1;
    if (Object.prototype.hasOwnProperty.call(values, key)) fail(`duplicate key ${key}`);
    values[key] = value;
    skipTrivia();
  }
  return values;
}

function verifyResourceContract(resourceRoot, contract) {
  requireDirectory(`${contract.kind} root`, resourceRoot);
  requireOnlyEntries(resourceRoot, [contract.id], `${contract.kind} payload`);
  const resourceDir = path.join(resourceRoot, contract.id);
  requireDirectory(`${contract.kind} ${contract.id}`, resourceDir);
  requireOnlyEntries(resourceDir, contract.files.map(item => item.name), `${contract.kind} file`);
  for (const item of contract.files) {
    requirePinnedFile(`${contract.kind} ${contract.id}/${item.name}`, path.join(resourceDir, item.name), item);
  }
  return `resource:${contract.kind}:${contract.id}`;
}

function verifyXlsReaderRoot(resourceRoot) {
  return verifyResourceContract(resourceRoot, XLS_READER_CONTRACT);
}

function verifyEmbeddingModelRoot(resourceRoot) {
  return verifyResourceContract(resourceRoot, EMBEDDING_MODEL_CONTRACT);
}

function verifyEmbeddingModelArchive(file) {
  requirePinnedFile('embedding-model archive', file, EMBEDDING_MODEL_CONTRACT.archive);
}

function verifyMacLocalizedMetadataRoot(root, options = {}) {
  requireDirectory('mac localized metadata root', root);
  if (!options.allowElectronResources) {
    requireOnlyEntries(
      root,
      MAC_LOCALIZED_METADATA_CONTRACT.map((item) => item.directory),
      'mac localized metadata locale',
    );
  }
  for (const item of MAC_LOCALIZED_METADATA_CONTRACT) {
    const localeDir = path.join(root, item.directory);
    requireDirectory(`mac localized metadata ${item.directory}`, localeDir);
    if (!options.allowElectronResources) {
      requireOnlyEntries(localeDir, ['InfoPlist.strings'], `mac localized metadata ${item.directory} file`);
    }
    const file = path.join(localeDir, 'InfoPlist.strings');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`[packaged-resource-gate] missing mac localized metadata file: ${file}`);
    }
    const actual = parseAppleStrings(text, `${item.directory}/InfoPlist.strings`);
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(item.values).sort();
    const matches = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
      && expectedKeys.every((key) => actual[key] === item.values[key]);
    if (!matches) {
      throw new Error(
        `[packaged-resource-gate] mac localized metadata content mismatch: ${file}; expected ${JSON.stringify(item.values)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  return 'resource:mac-locales:v1';
}

function requiredMacLocalizedMetadataVerificationEntries() {
  return ['resource:mac-locales:v1'];
}

function requiredPackagedResourceVerificationEntries() {
  return [`resource:embedding-model:${EMBEDDING_MODEL_CONTRACT.id}`, `resource:xls-reader:${XLS_READER_CONTRACT.id}`];
}

function verifyExtraResourcesConfig(extraResources) {
  if (!Array.isArray(extraResources)) {
    throw new Error('[packaged-resource-gate] build.extraResources must be an array');
  }
  const seen = new Set();
  for (const entry of extraResources) {
    const destination = entry && typeof entry === 'object' ? String(entry.to || '') : '';
    if (!destination) {
      throw new Error('[packaged-resource-gate] extraResources entry is missing its destination');
    }
    if (!Object.prototype.hasOwnProperty.call(EXTRA_RESOURCES_CONTRACT, destination)) {
      throw new Error(`[packaged-resource-gate] unregistered extraResources destination: ${destination}`);
    }
    if (seen.has(destination)) {
      throw new Error(`[packaged-resource-gate] duplicate extraResources destination: ${destination}`);
    }
    seen.add(destination);
  }
  for (const destination of Object.keys(EXTRA_RESOURCES_CONTRACT)) {
    if (!seen.has(destination)) {
      throw new Error(`[packaged-resource-gate] declared extraResources destination is not packaged: ${destination}`);
    }
  }
  const macLocales = extraResources.find((entry) => entry && entry.to === '.');
  if (String(macLocales.from || '').replace(/\\/g, '/') !== 'resources/mac-locales') {
    throw new Error(
      `[packaged-resource-gate] mac localized metadata source mismatch: ${macLocales.from || '(missing)'}`,
    );
  }
  const filters = Array.isArray(macLocales.filter) ? macLocales.filter.map(String) : [];
  if (JSON.stringify(filters) !== JSON.stringify(MAC_LOCALIZED_METADATA_FILTERS)) {
    throw new Error(
      `[packaged-resource-gate] mac localized metadata filters must exactly match: ${MAC_LOCALIZED_METADATA_FILTERS.join(', ')}`,
    );
  }
  return [...seen];
}

module.exports = {
  requirePinnedFile,
  XLS_READER_CONTRACT,
  verifyXlsReaderRoot,
  EMBEDDING_MODEL_CONTRACT,
  EXTRA_RESOURCES_CONTRACT,
  MAC_LOCALIZED_METADATA_CONTRACT,
  MAC_LOCALIZED_METADATA_FILTERS,
  parseAppleStrings,
  requiredMacLocalizedMetadataVerificationEntries,
  requiredPackagedResourceVerificationEntries,
  verifyExtraResourcesConfig,
  verifyEmbeddingModelArchive,
  verifyEmbeddingModelRoot,
  verifyMacLocalizedMetadataRoot,
  verifyResourceContract,
};
