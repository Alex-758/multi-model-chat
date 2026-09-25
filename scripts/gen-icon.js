'use strict';
// 生成 256x256 标准 DIB 格式 ICO（含 BITMAPINFOHEADER + BGRA 像素 + AND mask）
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

const S = 256;
const px = new Buffer.alloc(S * S * 4); // RGBA top-down

// 紫蓝渐变背景 + 圆角
const R = 52; // 圆角半径
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const t = y / S;
    px[i] = 99 + (168 - 99) * t;
    px[i + 1] = 102 + (85 - 102) * t;
    px[i + 2] = 241 + (247 - 241) * t;
    px[i + 3] = 255;
    // 圆角裁剪
    const cx = Math.min(Math.max(x, R), S - R);
    const cy = Math.min(Math.max(y, R), S - R);
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > R * R) px[i + 3] = 0;
  }
}

// 白色对话气泡（椭圆 + 小尾巴）
function fillEllipse(cx, cy, rx, ry, r, g, b) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (x < 0 || x >= S || y < 0 || y >= S) continue;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const i = (y * S + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
    }
  }
}
fillEllipse(128, 122, 88, 58, 255, 255, 255);
// 气泡尾巴
for (let d = 0; d < 26; d++) {
  for (let w = 0; w < 26 - d; w++) {
    const x = 92 + w, y = 168 + d;
    const i = (y * S + x) * 4;
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
  }
}
// 三个彩色圆点（多模型）
const dots = [[100, 122, 245, 158, 11], [128, 122, 236, 72, 153], [156, 122, 16, 185, 129]];
for (const d of dots) {
  for (let y = -13; y <= 13; y++) {
    for (let x = -13; x <= 13; x++) {
      if (x * x + y * y <= 169) {
        const pxx = d[0] + x, pyy = d[1] + y;
        if (pxx >= 0 && pxx < S && pyy >= 0 && pyy < S) {
          const i = (pyy * S + pxx) * 4;
          px[i] = d[2]; px[i + 1] = d[3]; px[i + 2] = d[4]; px[i + 3] = 255;
        }
      }
    }
  }
}

// ---- 组装 ICO（单条目 256x256 DIB）----
const xorSize = S * S * 4;
const andRowBytes = S / 8; // 32 bytes per row (1bpp)
const andSize = andRowBytes * S;
const imgSize = 40 + xorSize + andSize;

const bmpInfo = Buffer.alloc(40);
bmpInfo.writeUInt32LE(40, 0);        // biSize
bmpInfo.writeInt32LE(S, 4);          // biWidth
bmpInfo.writeInt32LE(S * 2, 8);      // biHeight (XOR + AND)
bmpInfo.writeUInt16LE(1, 12);        // biPlanes
bmpInfo.writeUInt16LE(32, 14);       // biBitCount
bmpInfo.writeUInt32LE(0, 16);        // biCompression = BI_RGB
bmpInfo.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

// XOR：BGRA，bottom-up
const xor = Buffer.alloc(xorSize);
for (let y = 0; y < S; y++) {
  const srcRow = S - 1 - y; // bottom-up
  for (let x = 0; x < S; x++) {
    const si = (srcRow * S + x) * 4;
    const di = (y * S + x) * 4;
    xor[di] = px[si + 2];     // B
    xor[di + 1] = px[si + 1]; // G
    xor[di + 2] = px[si];     // R
    xor[di + 3] = px[si + 3]; // A
  }
}
// AND：全 0（用 alpha 通道判断不透明）
const and = Buffer.alloc(andSize);

// 目录 + 头
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const dir = Buffer.alloc(16);
dir.writeUInt8(0, 0);                 // width 256 → 0
dir.writeUInt8(0, 1);                 // height 256 → 0
dir.writeUInt8(0, 2);                 // colors
dir.writeUInt8(0, 3);                 // reserved
dir.writeUInt16LE(1, 4);              // planes
dir.writeUInt16LE(32, 6);             // bitcount
dir.writeUInt32LE(imgSize, 8);        // bytes in resource
dir.writeUInt32LE(22, 12);            // offset (6 + 16)

fs.writeFileSync(OUTPUT, Buffer.concat([header, dir, bmpInfo, xor, and]));
console.log('OK icon -> ' + OUTPUT + ' (' + (22 + imgSize) / 1024 + ' KB)');
