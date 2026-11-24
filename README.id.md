# Orkas

**Tim agen AI sumber terbuka di desktop Anda — mengubah tujuan Anda menjadi pekerjaan yang tuntas dan menjaganya terus berjalan.**

Orkas adalah aplikasi desktop multi-agen sumber terbuka (MIT) yang mengutamakan lokal — asisten AI yang bekerja sebagai tim. Sampaikan kebutuhan Anda kepada **Komandan** (Commander): ia menyelesaikan banyak tugas sendiri, dan untuk pekerjaan yang lebih besar ia menyusun langkah-langkahnya lalu melibatkan agen spesialis bersama agen pemrograman dan agen pribadi yang sudah Anda gunakan — **Claude Code, Codex, OpenCode, OpenClaw, dan Hermes-Agent** — untuk mengerjakannya bersama-sama.

Orkas dibuat untuk menjaga proyek terus berjalan, bukan sekadar menjawab satu prompt. Sebuah **proyek** menyimpan tujuan, aturan, memori, dan file, sehingga setiap percakapan baru melanjutkan dari titik terakhir percakapan sebelumnya. Daftar **Yang harus dilakukan** membagi pekerjaan antara manusia dan agen, **Kemajuan otomatis** membuat tim mengambil tugas berikutnya dengan sendirinya, dan **otomatisasi terjadwal** mengulang pekerjaan rutin setiap jam, hari, minggu, atau bulan. Semua data Anda tetap berada di komputer Anda, dan pekerjaan yang sudah selesai dikembalikan untuk Anda tinjau — sehingga Anda dapat memercayakan pekerjaan berkelanjutan bisnis Anda kepada Orkas.

**[⬇ Unduh Orkas untuk macOS & Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — gratis, dengan 500 kredit untuk model Orkas bawaan, jadi Anda tidak memerlukan kunci API untuk memulai. Lebih suka memakai kunci sendiri? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, atau endpoint lokal yang kompatibel dengan OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Aplikasi desktop Orkas — percakapan tugas dan hasil kerja](./resources/app-ui/task-en.png)

---

## Apa yang dihasilkan tim

- **Video, narasi suara, dan gambar** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Laporan riset, audit SEO, dan analisis pasar** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Postingan, artikel, buletin, dan slide presentasi** — ContentWriter, PptMaker
- **Situs web, UI, dan kode** — UIDesigner, ProductDeveloper
- **File Word, Excel, PowerPoint, dan PDF** — OfficeWorker
- **Pekerjaan e-commerce** — riset produk, listing produk, analisis ulasan, analisis penjualan, dan perubahan katalog, oleh lima agen e-commerce
- **Pekerjaan kompleks yang membutuhkan beberapa agen** — Komandan memecahnya, menyerahkan setiap bagian kepada agen yang tepat, lalu menggabungkan hasilnya; misalnya, riset pasar yang menjadi laporan, slide presentasi, dan video peluncuran

16 spesialis sudah disertakan dalam aplikasi, masing-masing dengan keterampilan, memori, dan alatnya sendiri. Jelajahi 30+ agen di [pasar agen](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas), atau jelaskan peran yang Anda butuhkan dan Komandan akan membuatkan agen kustom untuk Anda.

<details>
<summary><b>Semua 16 agen bawaan</b></summary>

| Bidang | Agen | Yang dihasilkan |
| --- | --- | --- |
| Riset & analisis | **DeepResearcher** | Riset berbasis bukti dengan sumber terverifikasi, kontradiksi yang ditandai, dan laporan yang dapat diaudit |
| | **SeoGeoAgent** | Cukup berikan URL — audit teknis, kualitas konten, Core Web Vitals, peluang dikutip dalam jawaban AI (GEO), dan daftar perbaikan berdasarkan prioritas |
| | **StockAnalyser** | Riset saham, penyaringan berbasis faktor, backtest, dan pemeriksaan risiko portofolio, dengan dasbor yang dapat ditelusuri |
| Konten & media | **ContentWriter** | Postingan, artikel, buletin, dan studi kasus siap terbit dari tujuan, sumber, atau draf kasar |
| | **PptMaker** | Presentasi PPTX yang dapat diedit dan ditinjau dari topik, kerangka, atau dokumen |
| | **ImageStudio** | Poster, sampul, gambar media sosial, dan infografis |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narasi, presenter AI, subtitle dan sulih suara, klip sorotan, lokalisasi, serta pembuatan ulang video referensi dengan konten dan rekaman Anda sendiri |
| | **VoiceStudio** | Narasi, audio multi-suara, transkrip dan subtitle, penyuntingan dan pencampuran audio |
| | **UIDesigner** | UI berbasis HTML yang dapat diedit, dari tujuan produk, PRD, tangkapan layar, atau materi Figma |
| Pengembangan & perkantoran | **ProductDeveloper** | Rekayasa perangkat lunak yang memahami repositori — mengimplementasikan PRD, memperbaiki bug, melakukan refaktor, meninjau kode, dengan hasil yang dapat diverifikasi |
| | **OfficeWorker** | Membuat, mengedit, memeriksa, dan menyerahkan file Word / Excel / PowerPoint / PDF, satu per satu atau sekaligus dalam jumlah banyak |
| E-commerce | **ECommerceResearcher** | Pemilihan produk berdasarkan anggaran, pasar, dan batasan pengadaan — kandidat, alasan penolakan, rencana validasi |
| | **ECommerceWriter** | Judul, halaman detail, FAQ, teks gambar, dan naskah video dengan gaya bahasa merek Anda |
| | **ECommerceReviewer** | Analisis ulasan dan reputasi — tema yang sering diangkat pelanggan, akar penyebab ulasan buruk, prioritas |
| | **ECommerceAnalyzer** | Penjualan, laba, iklan, pengembalian dana, dan inventaris dari data ekspor Anda — metrik yang sudah direkonsiliasi dan keputusan |
| | **ECommerceOperator** | Merencanakan perubahan katalog, harga, promosi, dan inventaris; hanya mengeksekusi melalui alat yang Anda hubungkan |

Selengkapnya tentang setiap agen → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Buat ulang video referensi dengan konten Anda sendiri

**VideoStudio** dapat membuat ulang struktur narasi, gaya visual, dan tempo penyuntingan sebuah video viral menggunakan produk, naskah, dan rekaman Anda sendiri. Sediakan file video referensi dan aset Anda: agen akan menganalisis hook, urutan informasi, ritme visual, dan ajakan bertindak, lalu mengusulkan bagian mana yang dipertahankan dan mana yang diganti sebelum produksi.

Cara ini paling cocok untuk video penjelasan motion graphic, demo SaaS atau aplikasi, dan iklan produk yang dibuat dari rekaman yang sudah Anda miliki. Teks, subtitle, narasi, dan klip yang dibuat secara lokal dapat direvisi secara terpisah; teks yang menyatu dalam rekaman buatan AI hanya bisa diubah dengan mengganti rekaman tersebut.

> "Pakai reference.mp4 sebagai referensi untuk video promo vertikal 30 detik. Pertahankan hook, tipografi, dan temponya, ganti kontennya dengan produk dan rekaman layar saya, lalu tunjukkan dulu rincian analisis dan rencananya."

Mulailah dengan file video yang dapat dibaca agen; mengunduh video dari tautan berbagi platform media sosial belum didukung secara bawaan. Gerakan kamera yang persis sama, performa manusia, dan kecocokan bingkai demi bingkai tidak dijamin. Lihat [alur kerja pembuatan ulang video referensi](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Menjaga pekerjaan terus berjalan

Satu tugas adalah awal yang baik. Orkas dibuat untuk pekerjaan yang terus berlanjut.

- **Proyek** — tujuan & aturan, memori, dan file yang menjadi titik awal setiap percakapan dalam proyek, sehingga Anda tidak perlu menjelaskan semuanya dari nol.
- **Yang harus dilakukan dan Kemajuan otomatis** — setiap proyek memiliki daftar tugas untuk manusia dan agen; saat Kemajuan otomatis aktif, tim mengambil item berikutnya sendiri dan mengembalikan pekerjaan yang sudah selesai untuk Anda tinjau.
- **Otomatisasi terjadwal** — jalankan tugas apa pun setiap jam, hari, minggu, atau bulan. Orkas berjalan di komputer Anda. Mulai v1.9, saat komputer aktif kembali atau Orkas dijalankan, setiap otomatisasi akan menjalankan satu jadwal terlewat yang paling baru, asalkan terlewat dalam 12 jam terakhir.
- **Konektor** — Gmail, Google Calendar, Sheets dan Drive, Notion, Slack, Shopify, Stripe, dan banyak lagi. Secara default, Orkas meminta persetujuan Anda sebelum mengirim, memposting, atau menghapus apa pun.
- **Aplikasi** — jelaskan alat yang Anda butuhkan, dan Orkas akan membuatnya sebagai aplikasi lokal di dalam aplikasi desktop. Di aplikasi siap instal, paket berbayar juga dapat menerbitkannya sebagai aplikasi web dengan tautan publik.
- **Proyek bersama** *(aplikasi siap instal)* — undang rekan tim atau asisten virtual (VA), lalu serahkan setiap tugas kepada seseorang atau agen.

> [!NOTE]
> Proyek bersama, sinkronisasi cloud, dan penerbitan aplikasi web hanya tersedia di aplikasi siap instal — versi sumber terbuka belum mendukungnya. Untuk menggunakannya, **[unduh Orkas untuk macOS & Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratis, dengan 500 kredit untuk memulai).

Input suara juga berfungsi di versi kode sumber. Atur **Orkas API Key** di **Pengaturan → Model**, lalu klik ikon mikrofon di samping kolom pesan. Izinkan akses mikrofon saat diminta. Audio dikirim ke Orkas untuk dikenali dan memakai kredit Orkas milik pemilik kunci. Klik sekali lagi untuk berhenti, periksa teksnya, lalu kirim sendiri. Jika akses ditolak, aktifkan mikrofon di pengaturan sistem Anda.

---

## Jalankan Claude Code, Codex, OpenCode, OpenClaw, dan Hermes-Agent bersama-sama

Orkas menjalankan agen CLI yang sudah Anda instal sebagai sesi lokal, berdampingan dengan spesialisnya sendiri — agen pemrograman **Claude Code, Codex, dan OpenCode**, serta agen pribadi **OpenClaw dan Hermes-Agent**. Komandan memberikan kepada setiap agen bagian yang paling dikuasainya dan menjaga satu rencana untuk semuanya, sehingga satu obrolan saja cukup untuk memperbaiki bug, meninjau perubahannya, dan menyusun draf catatan rilis. Alat sumber terbuka seperti HyperFrames terhubung dengan cara yang sama.

[Menggunakan Claude Code dan Codex bersama-sama →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Mengapa Orkas

- **Komandan yang merencanakan, mendelegasikan, dan mengerjakan sisanya** — Komandan memecah tujuan, memilih agen, keterampilan, konektor, dan alat yang tepat, serta menangani sendiri analisis, penulisan, riset, dan pekerjaan file jika tidak ada spesialis yang lebih cocok.
- **Dirancang untuk mengutamakan lokal** — percakapan, file, basis pengetahuan, dan agen kustom secara default tersimpan di disk Anda. Sinkronisasi cloud bersifat opsional di aplikasi siap instal. Dengan kunci Anda sendiri, panggilan model dikirim langsung dari perangkat Anda ke penyedia; model Orkas bawaan berjalan melalui layanan model terkelola milik Orkas.
- **Model bisa diganti kapan saja** — Komandan dan agen bawaan berbagi satu pengaturan model: model Orkas bawaan, penyedia Anda sendiri, atau endpoint lokal. Agen CLI eksternal tetap memakai pengaturan modelnya masing-masing.
- **Agen yang terus berkembang** — setiap agen menyimpan keterampilan dan memori pribadinya. Tinjauan di latar belakang memeriksa aktivitas baru saat aplikasi sedang tidak digunakan dan dapat menyempurnakan penilaian diri, metode yang dapat dipakai ulang, serta keterampilan yang telah dipelajari.
- **Sumber terbuka, tanpa kotak hitam** — berlisensi MIT. Anda bisa membaca persis apa yang dilakukan Orkas serta setiap agen dan keterampilannya.

> ⭐ Jika Orkas bermanfaat bagi Anda, beri bintang agar lebih banyak orang menemukan proyek ini.

---

## Unduh

| | Aplikasi siap instal (disarankan) | Jalankan dari kode sumber |
| --- | --- | --- |
| Platform | macOS 12+ (Apple Silicon & Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 dengan glibc 2.34+ |
| Akun | Masuk — 500 kredit gratis | Tidak perlu |
| Model | Model Orkas bawaan, atau kunci Anda sendiri | Kunci Anda sendiri atau endpoint lokal |
| Fitur tambahan | Kolaborasi proyek, penerbitan aplikasi, sinkronisasi cloud, dan lainnya | — |
| Dapatkan | **[Unduh Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Mulai cepat](#mulai-cepat) |

Tautan unduhan akan mendeteksi sistem Anda dan memulai penginstal yang sesuai.

---

## Untuk apa orang menggunakannya

- **Konten pemasaran** — video peluncuran, halaman produk, postingan, dan buletin dengan gaya bahasa Anda. [Penulisan konten](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Video](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Operasional toko** — ringkasan penjualan mingguan, balasan ulasan, listing produk, dan pemantauan pesaing. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Riset dan laporan** — laporan dan slide presentasi lengkap dengan sumber, sesuai permintaan atau setiap minggu. [Riset](https://orkas.ai/use/researchers/?source=gh-orkas) · [Analisis data](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Mengobrol dengan dokumen Anda** — jawaban yang berlandaskan file Anda sendiri, dengan kutipan yang merujuk ke bagian sumbernya. [Mengobrol dengan dokumen](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Pekerjaan klien** — ringkasan rapat, laporan klien bulanan, dan slide pembaruan sesuai template Anda. [Template laporan klien bulanan](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Peluncuran produk** — landing page, perbaikan bug lengkap dengan pengujiannya, catatan perubahan, dan postingan peluncuran. [Pengembang](https://orkas.ai/use/developers/?source=gh-orkas)
- **Membuat aplikasi** — kalkulator penawaran harga, formulir pemesanan, alat internal. [Membuat aplikasi](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Tim kecil** — satu proyek untuk manusia dan agen. [Tim kecil](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Perbandingan Orkas dengan alat lain

| Alat | Apa itu | Perbedaan Orkas |
| --- | --- | --- |
| **Claude Code** | Alat pemrograman agentik dari Anthropic — tersedia di terminal, IDE, desktop, dan web, dibangun di atas model Claude. | Bukan soal memilih salah satu: Orkas menjalankan Claude Code sebagai salah satu agennya. Di sekelilingnya, Orkas menambahkan tim yang tidak terikat pada model tertentu untuk pekerjaan di luar kode — riset, konten, video, dan lainnya — lengkap dengan proyek, daftar tugas, dan otomatisasi yang menjaga pekerjaan terus berjalan. [Orkas vs Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | Agen pemrograman dari OpenAI — tersedia di terminal, editor Anda, dan cloud. | Bukan soal memilih salah satu: Orkas menjalankan Codex sebagai salah satu agennya, berdampingan dengan Claude Code dan OpenCode. Komandan dapat menyerahkan penulisan kode kepada Codex dan peninjauannya kepada agen lain, lalu menangani separuh pekerjaan rilis yang bukan kode — dokumentasi, postingan peluncuran, dan video. [Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | Agen dari Anthropic untuk pekerjaan sehari-hari, kini menjadi bagian dari Claude — tersedia di desktop, web, dan seluler dengan paket Claude berbayar. Secara default, agen ini berjalan di cloud Anthropic dan menggunakan model Claude. | Alternatif sumber terbuka (MIT) untuk Claude Cowork yang bisa dimulai gratis, dengan 500 kredit. Orkas menjalankan agennya di komputer Anda dan secara default menjaga data Anda tetap lokal, dengan model Orkas bawaan, kunci penyedia Anda sendiri, atau endpoint lokal. Komandan juga dapat melibatkan Claude Code, Codex, dan agen CLI lainnya. Komprominya: Orkas membutuhkan komputer Anda tetap menyala dan tidak dalam mode tidur, sedangkan tugas cloud Cowork dapat terus berjalan tanpa komputer Anda. [Alternatif Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Agen AI yang secara default merencanakan dan menjalankan tugas di cloud Manus. Aplikasi desktop Manus Studio (macOS dan Windows) juga dapat bekerja di folder yang Anda pilih, tetapi perencanaan tugas tetap dilakukan di cloud. | Alternatif sumber terbuka (MIT) untuk Manus. Orkas menjalankan agennya di komputer Anda dan secara default menjaga data Anda tetap lokal, dengan model Orkas bawaan, kunci penyedia Anda sendiri, atau endpoint lokal. Proyek, daftar tugas, dan otomatisasi menjaga pekerjaan terus berjalan. Komprominya: Orkas membutuhkan komputer Anda tetap menyala dan tidak dalam mode tidur, sedangkan tugas cloud Manus dapat terus berjalan tanpa komputer Anda. [Alternatif Manus sumber terbuka →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Framework/pustaka untuk pengembang guna membangun aplikasi dan agen LLM — mengutamakan kode, disematkan di dalam aplikasi Python/JS Anda sendiri. | Orkas adalah aplikasi desktop yang Anda arahkan melalui obrolan, bukan dengan menulis kode orkestrasi. Secara default, data tetap lokal. |
| **CrewAI** | Framework Python untuk mengorkestrasi agen otonom yang memerankan peran tertentu — Anda mendefinisikan kru dan agen dalam kode. | Orkas menghadirkan orkestrasi multi-agen dalam aplikasi desktop, dengan proyek, daftar tugas, otomatisasi, dan peningkatan diri per agen yang sudah tersedia bawaan. |
| **OpenClaw** | Platform agen pribadi dengan integrasi aplikasi pesan, perutean multi-agen, dan subagen. | Orkas menyediakan ruang kerja desktop untuk menghasilkan pekerjaan yang tuntas, dengan spesialis bawaan dan koordinasi lintas Claude Code, Codex, OpenCode, dan agen CLI lainnya. OpenClaw dapat bergabung ke dalam alur kerja tersebut sebagai agen CLI. |
| **Hermes-Agent** | Agen dari Nous Research yang dapat meningkatkan dirinya sendiri — satu agen dengan memori dan keterampilan, tersedia sebagai CLI, gateway pesan, dan aplikasi desktop. | Orkas mengoordinasikan sebuah tim: Komandan mengarahkan banyak spesialis dan agen CLI lainnya, dan Hermes-Agent terhubung sebagai salah satunya. |

**Orkas cocok untuk Anda jika** Anda menginginkan tim agen alih-alih satu asisten, pekerjaan yang terus berjalan dari hari ke hari, serta data, kunci, dan agen yang tersimpan di disk Anda sendiri.

**Tidak cocok untuk Anda jika** Anda hanya menginginkan satu chatbot serbaguna, atau pustaka kode murni untuk disematkan di aplikasi Anda sendiri.

**Sedang memilih agen pemrograman?** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternatif Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Perbandingan lengkap secara berdampingan →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Mulai cepat

Lebih suka penginstal siap pakai? Lihat [Unduh](#unduh) di atas. Untuk menjalankan dari kode sumber — cara yang saat ini tersedia untuk menjalankan Orkas di Linux:

**Persyaratan**: Node 22.12+ · macOS / Windows 10+ / Linux x64 atau arm64 dengan glibc 2.34+. Siapkan juga Python 3 dan toolchain build C/C++ untuk berjaga-jaga jika modul native harus di-build dari kode sumber, hal yang jarang terjadi.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Menjalankan dari kode sumber di Linux memerlukan glibc 2.34+. Alpine dan distribusi lain berbasis musl tidak didukung. Transkripsi suara lokal akan mengunduh dan memverifikasi runtime whisper.cpp native untuk platform target beserta model multibahasa saat peluncuran pertama dari kode sumber.

`run.sh` / `run.cmd` menginstal pohon dependensi npm yang terkunci dan menyiapkan sumber daya dengan versi yang dipatok — Python, uv, Node, model embedding (~95 MB), OfficeCLI, FFmpeg, whisper.cpp, dan model suara multibahasa — saat peluncuran pertama. Setelah itu, saat dijalankan di Linux, aplikasi memverifikasi modul native platform dan runtime Whisper terhadap ABI Electron sebelum terbuka. Paket Python untuk OCR dan untuk keterampilan tertentu diinstal ke lingkungan lokal yang terisolasi saat fitur tersebut pertama kali digunakan. Peluncuran pertama membuat ruang kerja di `~/.orkas/` (macOS / Linux) atau `<smallest non-system drive>:\.orkas\` (Windows). Lalu buka **Pengaturan → Penyedia AI** untuk menambahkan kunci API atau OAuth.

Error dependensi native: gunakan Node.js 24 LTS (minimal 22.12.0), lalu jalankan
`npm run native:repair` dari salinan repositori ini. Perintah ini memulihkan paket opsional,
memperbaiki SQLite untuk Electron, menyiapkan Node yang dibundel untuk pemrosesan gambar yang terisolasi,
lalu memeriksa SQL, sqlite-vec, dan sharp sebelum dinyatakan berhasil.
Gunakan `npm run native:check` untuk memeriksa saja tanpa menginstal apa pun.
Lihat [skrip verifikasi dependensi native](./scripts/verify-native-dependencies.cjs) untuk daftar pemeriksaan yang dilakukan.

---

## Cara kerjanya

### Perutean tugas

Komandan menangani sendiri pekerjaan umum dan mendelegasikan pekerjaan spesialis melalui tiga alat:

- **`dispatch_to`** menjalankan agen yang ditentukan berdasarkan namanya dan mengembalikan hasilnya agar pekerjaan bisa dilanjutkan. Alat ini dapat menunggu hasilnya, atau berjalan secara asinkron lalu memberi tahu Komandan saat tugas selesai.
- **`hand_off_to`** mengalihkan sisa pekerjaan kepada agen yang disebutkan namanya dan mengakhiri giliran Komandan saat ini. Agen tersebut menyampaikan balasannya sendiri; kelanjutan opsional memungkinkan Komandan melanjutkan tugas yang lebih luas sesudahnya.
- **`run_worker`** menjalankan subtugas anonim yang terisolasi dan mengembalikan hasil privat. Subtugas ini tidak menerima riwayat percakapan maupun keterampilan agen bernama.

Tugas agen bernama dan pekerja anonim memiliki kontrol konkurensi masing-masing. Lihat [implementasi dispatch](./src/main/features/group_chat/bus.ts) dan [kunci eksekusi](./src/main/util/locks.ts).

### Manajemen konteks

Runtime mengatur anggaran konteks berdasarkan kapasitas input yang dapat dipakai oleh model yang dipilih, dengan memperhitungkan prompt, alat, dan status runtime yang persisten. Dialog yang sudah selesai memakai jendela riwayat terbaru yang dibatasi; tugas aktif yang panjang memakai checkpoint untuk memadatkan pesan proses sebelumnya sambil tetap mempertahankan pekerjaan terbaru. Pembacaan file, perubahan file, dan eksekusi perintah juga memiliki catatan terstruktur yang tetap ada setelah konteks dipadatkan.

Lihat [anggaran konteks](./src/core-agent/src/agent/context-budget.ts), [riwayat sesi dan checkpoint](./src/core-agent/src/agent/session.ts), dan [catatan ruang kerja](./src/core-agent/src/agent/workspace-state.ts).

### Memori dan Perpustakaan

Catatan permanen menyimpan preferensi pengguna, fakta proyek, dan pengetahuan yang dapat dipakai ulang milik setiap agen dalam cakupan yang terpisah. Catatan ini berbeda dari indeks dokumen Perpustakaan maupun riwayat percakapan yang tersimpan.

Perpustakaan mengekstrak dokumen menjadi potongan teks dan menyimpan indeks vektor SQLite lokal. Model embedding-nya berjalan di perangkat Anda; alat `library` dapat menampilkan daftar file, mencari potongan teks yang relevan, dan membaca konten sumber dari Perpustakaan global atau Perpustakaan proyek saat ini. Percakapan sebelumnya diambil secara terpisah melalui `chat_history`.

Lihat [memori bercakupan](./src/main/features/memory.ts), [ekstraksi dokumen](./src/main/util/file_to_chunks.ts), [alat Perpustakaan](./src/main/model/core-agent/kb-tools.ts), dan [pengambilan percakapan](./src/main/model/core-agent/chat-history-tools.ts).

### Batas eksekusi dan pemulihan

Kunci sesi dan batas konkurensi membatasi pekerjaan paralel. Anggaran putaran alat, checkpoint kemajuan, pemeriksaan panggilan berulang, dan watchdog idle yang mengenali fase membantu menahan proses yang macet atau mengulang pekerjaan. Tugas agen bernama dapat dilacak dan dibatalkan satu per satu; tugas yang baru diterima atau masih mengantre tidak dianggap sebagai hasil yang sudah selesai.

Lihat [anggaran aktor](./src/main/features/group_chat/actor-budgets.ts), [runtime agen](./src/core-agent/src/agent/runner.ts), dan [adaptor model desktop](./src/main/model/core-agent/client.ts).

### Belajar dari aktivitas

Tinjauan di latar belakang memeriksa aktivitas agen yang baru saat aplikasi sedang tidak digunakan, dengan mematuhi masa jeda dan batas eksekusi. Sebuah tinjauan dapat memperbarui penilaian diri agen (`COMPETENCE.md`), metode yang dapat dipakai ulang (`LEARNING_STRATEGIES.md`), atau keterampilan yang telah dipelajari. Tinjauan bergantung pada adanya aktivitas baru, bukan jumlah tugas, dan dapat menyimpulkan bahwa tidak ada yang layak disimpan.

Lihat [penjadwal refleksi](./src/main/features/reflection-orchestrator.ts) dan [prompt tinjauan](./src/core-agent/src/evolution/metacognition.ts).

---

## Pertanyaan umum

**Apa itu Orkas?**
Orkas adalah aplikasi desktop multi-agen sumber terbuka (MIT) yang mengutamakan lokal. Komandan di Orkas mengubah tujuan Anda menjadi daftar tugas dan mengoordinasikan 16 agen spesialis bawaan — ditambah Claude Code, Codex, OpenCode, OpenClaw, dan Hermes-Agent — untuk menghasilkan file yang sudah jadi. Bukan sekadar satu chatbot, bukan framework kode, dan bukan SaaS yang di-hosting.

**Apakah saya memerlukan kunci API?**
Tidak. Aplikasi siap instal sudah dilengkapi 500 kredit untuk model Orkas bawaan. Setelah itu, Anda dapat membeli kredit, memilih paket berbayar, atau menambahkan kunci penyedia Anda sendiri; biaya dari penyedia ditagih terpisah.

**Apakah Orkas sebuah LLM lokal?**
Tidak. Orkas berjalan di perangkat Anda dan memanggil model yang Anda pilih — model Orkas bawaan, kunci API Anda sendiri, atau endpoint model lokal. Orkas mengorkestrasi agen dan alat; Orkas sendiri bukan model.

**Bisakah Orkas menjawab pertanyaan dari dokumen saya, lengkap dengan kutipan?**
Bisa. Tambahkan PDF dan dokumen ke Perpustakaan lokal Anda; Orkas dapat mencarinya dan menjawab dengan kutipan ke bagian sumbernya, sehingga Anda bisa membuka dokumen aslinya dan memeriksanya. Indeksnya dibuat di perangkat Anda.

**Bisakah saya menggunakan model lokal seperti Ollama atau LM Studio?**
Bisa. Buka **Pengaturan akun → Model → Obrolan → Tambahkan model → Kustom**, pilih **Kompatibel OpenAI** atau **Kompatibel Anthropic**, lalu masukkan URL dasar, ID model yang persis, dan kunci API. Pilih model yang sudah disimpan dari kontrol model pada tugas.

**Di mana kunci API dan data saya disimpan?**
Secara default, di disk Anda. Kunci penyedia milik Anda dienkripsi secara lokal dan tidak diikutkan dalam sinkronisasi cloud. Dengan kunci Anda sendiri, panggilan model dikirim langsung dari perangkat Anda ke penyedia; model Orkas bawaan menggunakan layanan terkelola Orkas. Sinkronisasi cloud yang bersifat opsional dan proyek bersama di aplikasi siap instal menyimpan data yang dipilih di server Orkas. [Keamanan dan penanganan data →](https://orkas.ai/security/?source=gh-orkas)

**Apakah Orkas bisa bekerja secara offline?**
Versi kode sumber dapat berjalan sepenuhnya offline dengan endpoint model lokal. Aplikasi siap instal mengharuskan Anda masuk ke akun, dan model cloud memerlukan koneksi jaringan.

**Apakah Orkas tetap bekerja saat komputer saya mati?**
Tidak — Orkas berjalan di komputer Anda, jadi Kemajuan otomatis dan otomatisasi memerlukan komputer yang menyala dan tidak dalam mode tidur, serta Orkas yang sedang berjalan. Mulai v1.9, saat komputer aktif kembali atau Orkas dijalankan, setiap otomatisasi akan menjalankan satu jadwal terlewat yang paling baru, asalkan terlewat dalam 12 jam terakhir.

**Bisakah saya membuat dan menerbitkan aplikasi?**
Bisa. Aplikasi lokal yang berjalan di dalam Orkas gratis. Menerbitkan aplikasi web ke tautan publik memerlukan paket berbayar (Lite 5, Pro 8, Max 15 aplikasi), dan aplikasi web yang diterbitkan tidak mencakup semua kemampuan yang tersedia di dalam Orkas.

**Apakah saya memerlukan akun Orkas?**
Aplikasi desktop siap instal meminta Anda masuk saat pertama kali dijalankan. Versi kode sumber di repositori ini sama sekali tidak memiliki lapisan akun — aplikasi langsung terbuka saat dijalankan.

**Bisakah Orkas mengendalikan Claude Code dan agen CLI lainnya?**
Bisa. Orkas dapat mengendalikan lima agen CLI eksternal sebagai subproses lokal — agen pemrograman Claude Code, Codex, dan OpenCode, ditambah agen pribadi OpenClaw dan Hermes-Agent — serta mengintegrasikan proyek sumber terbuka seperti HyperFrames, semuanya diarahkan dari obrolan yang sama.

**Apa bedanya Orkas dengan Claude Code / Codex / CrewAI / LangChain?**
Claude Code dan Codex adalah agen pemrograman — Orkas menjalankan keduanya sebagai anggota timnya, jadi Anda tidak perlu memilih salah satunya; CrewAI dan LangChain adalah framework yang mengutamakan kode. Orkas adalah aplikasi desktop sumber terbuka tempat Komandan mengoordinasikan tim agen spesialis dan agen CLI Anda, dengan penyedia model apa pun, serta menyimpan data dan kunci secara lokal. Lihat [perbandingan lengkap](https://orkas.ai/compare/?source=gh-orkas).

**Platform apa saja yang didukung Orkas?**
macOS 12+ (Apple Silicon dan Intel) dan Windows 10+ memiliki penginstal siap pakai. Linux x64/arm64 dengan glibc 2.34+ saat ini dijalankan dari kode sumber dan belum memiliki penginstal. Transkripsi suara lokal didukung di Linux melalui runtime whisper.cpp dengan versi yang dipatok, yang disiapkan saat peluncuran pertama. Alpine dan distribusi lain berbasis musl tidak didukung. Bootstrap dari kode sumber memerlukan Node 22.12+; Python 3 dan toolchain build C/C++ hanya diperlukan jika paket npm native tidak memiliki biner prebuilt yang kompatibel dan harus di-build ulang secara lokal.

**Apakah Orkas gratis dan sumber terbuka?**
Ya — aplikasi ini berlisensi MIT dan gratis digunakan. Aplikasi siap instal sudah termasuk 500 kredit untuk model Orkas bawaan; paket berbayar mulai $11.99/bulan menambahkan kredit bulanan, sinkronisasi cloud, lebih banyak proyek bersama, dan penerbitan aplikasi. Dengan kunci Anda sendiri, penggunaan model ditagih oleh penyedia Anda; Orkas tidak mengenakan biaya tambahan di atas tarif penyedia. [Harga →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Lisensi

[MIT](./LICENSE)
