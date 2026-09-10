// Генерирует resources/icon.png (256x256) — градиент без внешних зависимостей
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 256

function makeCrc32() {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb8b3f9 ^ (c >> 1) : c >> 1
    }
    table[n] = c >>> 0
  }
  return function crc(buf) {
    let crcValue = 0xffffffff
    for (const byte of buf) {
      crcValue = table[(crcValue ^ byte) & 0xff] ^ ((crcValue >> 8) & 0xff)
    }
    return (~crcValue) >>> 0
  }
}

const crc32Fn = makeCrc32()

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32Fn(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

// пиксели: вертикальный градиент #4A9EFF -> #1E3A5F
const pixels = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = y / SIZE
    const idx = (y * SIZE + x) * 4
    pixels[idx] = Math.round(0x4a + (0x1e - 0x4a) * t)
    pixels[idx + 1] = Math.round(0x9e + (0x3a - 0x9e) * t)
    pixels[idx + 2] = Math.round(0xff + (0x5f - 0xff) * t)
    pixels[idx + 3] = 255
  }
}

// raw scanlines: каждый ряд начинается с байта фильтра (0)
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1)
  raw[rowStart] = 0
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0) // width
ihdr.writeUInt32BE(SIZE, 4) // height
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0 // compression
ihdr[11] = 0 // filter
ihdr[12] = 0 // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const outDir = path.join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
console.log('icon.png written:', png.length, 'bytes')
