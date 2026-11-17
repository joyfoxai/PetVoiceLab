# 第三方许可声明 / Third-party notices

PetVoice Lab 自己的代码以 MIT 许可发布（见 `LICENSE`）。下面是随产物一起分发的第三方代码。

## 编译进 `petvoice.wasm` 的代码

### CHIMERA（声学引擎，本项目的核心）

- 来源：https://github.com/jamesondh/chimera-vocal-synth ，`crates/chimera/`，提交 `6259e880`
- 位置：`vendor/chimera/`（源码未改动，详见 `vendor/chimera/VENDORED.md`）
- 许可：MIT

```
MIT License

Copyright (c) 2026 Jameson Hodge

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### CHIMERA 的 Rust 依赖

| crate | 版本 | 许可 | 用途 |
|---|---|---|---|
| libm | 0.2.16 | MIT | 数学函数（CHIMERA 的全部超越函数都走它） |
| serde, serde_core, serde_derive | 1.0.229 | MIT OR Apache-2.0 | CHIMERA 内部数据表的反序列化 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | 同上 |
| itoa 1.0.19, memchr 2.8.3, zmij 1.0.23 | | MIT OR Apache-2.0（memchr：Unlicense OR MIT；zmij：MIT） | serde_json 的依赖 |

（`proc-macro2`、`quote`、`syn`、`unicode-ident` 只在编译期使用，不进入产物。）

## 随页面分发的数据

### CMU Pronouncing Dictionary（英文发音词典，打字功能用）

- 位置：`public/data/cmudict.txt.gz`（取自 CHIMERA 仓库的 `public/data/`），许可全文见
  `public/data/CMUDICT-LICENSE.txt`
- 许可：BSD 2-Clause，Copyright (C) 1993-2015 Carnegie Mellon University

`petvoice_speech.wasm`（英文人声）同样由 `vendor/chimera/` 编译而来，适用上面的 CHIMERA 许可。

## 只在开发时使用、不随产物分发

Vite（MIT）、TypeScript（Apache-2.0）、tsx（MIT）、Playwright（Apache-2.0，仅测试脚本）。

## 参考过、但没有使用其代码的项目

- Hermes Voice Lab（https://github.com/Adolanium/hermes-voice-lab ，MIT）：读了它的 README 和
  NOTICE，参考了“模型只出结构化参数、本地引擎发声”的分层思路。没有复制代码。
- STRAYS：玩法灵感。没有使用其代码或素材。

## 校准用的参照录音（不分发）

声音校准时测量了 ESC-50 数据集中单条授权为 CC0 / CC BY 的猫叫狗吠片段。音频不在仓库里、不随产品
分发，来源和作者列在 `docs/reference-recordings.md`。

## 测试音频

`test-audio/*.wav` 是用 CHIMERA 自带的人声合成器（`chimera render text`）生成的合成语音，
不是任何人的录音。

构建产物在根目录提供项目许可证和本声明。CHIMERA 和 Rust 依赖的许可证全文位于 `licenses/`，词典许可证位于 `data/CMUDICT-LICENSE.txt`。
