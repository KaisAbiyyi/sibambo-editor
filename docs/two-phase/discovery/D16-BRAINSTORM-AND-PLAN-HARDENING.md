# D16 · Brainstorm 10 Nov 2026 — tiga layer, Brief Pack, dan pengerasan plan

> **Status: DRAFT sesi perencanaan, menunggu keputusan owner (§6).** Aditif terhadap SIB-TWO-PHASE-001 v1.5; tidak ada kontrak v1.3–v1.5 yang dihapus atau dilemahkan. Tidak ada task berubah status, tidak ada klaim, merge, deploy, atau izin IMPLEMENT. Bagian bertanda **[arah owner]** berasal langsung dari owner pada sesi ini; sisanya **[usulan]**.

## 0. Ringkasan

1. Kerangka tiga layer dari owner dipetakan ke epic yang sudah ada (§1). Stable memang melompat ke Layer 3; itu konsisten dengan plan.
2. Pertanyaan "untuk arsitek atau untuk klien" tidak perlu dijawab untuk merancang format: satu format dengan label asal dan bukti per nilai melayani keduanya (§2). Ada tujuh pertanyaan untuk dibawa ke rapat klien.
3. Tiga dokumen Layer 1 kini punya format konkret dan satu contoh sintetis lengkap: [brief-pack/](brief-pack/README.md).
4. Audit menemukan 14 celah keamanan, 9 performa, 8 UI, 8 UX, dan 11 celah plan pada jalur live preview MCP (§4), masing-masing dengan usulan perubahan dan task pemiliknya (§5).
5. Dua hal yang paling mengubah urutan kerja: **probe kompatibilitas klien–IdP–tunnel dilakukan lebih dulu** (S5, P4, G5), dan **kebijakan saat tidak ada viewer** harus diputuskan sebelum SE-05/06 ditulis (S8).

## 1. Tiga layer dan posisinya di plan

| Layer | Isi **[arah owner]** | Epic yang sudah ada | Yang belum ada |
| --- | --- | --- | --- |
| 1 · Prompt | Form rasa/psikologi klien · dokumen tapak · pilihan ruang | XB-03, XB-01, XB-02 (semua Blocked; .0 boleh dicicil, D3) | Format dokumen konkret → **draf di folder ini** |
| 2 · Agentic loop | Loop riset + tool calling; blueprint cara membuat denah dan 3D | XB-05 (loop), XB-06 (zonasi/denah), XB-04 (provider, Colab), XB-19 (fine-tune) | **Blueprint** dari model beranotasi Rooms: tidak ada epic (G1) |
| 3 · Tool | MCP / tool yang dipanggil agent untuk membangun BOMC | SE-00…SE-11 (Stable), Builder | Permukaan tool hanya pelat, dinding, bukaan (G3) |

**Arah owner sesi ini:** karena komponen Layer 1 dan 2 belum tersedia, jalur sekarang adalah Claude Code dan Codex memanggil MCP langsung dan mengandalkan kecerdasan model; tiga dokumen Layer 1 dibuat **sintetis** dulu untuk pengembangan.

Konsekuensi yang perlu disadari: di jalur ini *agent eksternal itu sendiri* berperan sebagai Layer 2. Tidak ada validator denah, tidak ada solver, tidak ada blueprint. Hasilnya mengukur batas bawah, bukan kualitas produk akhir.

## 2. Arsitek atau klien?

**Temuan riset** (rinci di [brief-pack/README.md](brief-pack/README.md)): di praktik nyata klien mengisi kuesioner pra-rapat, arsitek menggali di rapat, dan arsitek atau surveyor yang mengumpulkan data tapak. Brief adalah dokumen hidup yang direvisi, dan satu rapat tidak cukup.

**Usulan posisi awal: arsitek sebagai operator, klien sebagai sumber.**

| Alasan | Penjelasan |
| --- | --- |
| Data tapak | Tingkat `survey` (ukur, KRK, sempadan) butuh orang yang paham; klien realistis hanya sampai `lot` |
| Tanggung jawab | Keluaran bersifat skematik; perlu orang yang berwenang menyatakan "ini belum boleh dibangun" |
| Kemampuan tool | Layer 3 saat ini hanya pelat, dinding, bukaan: cocok sebagai percepatan draft, belum sebagai produk mandiri untuk awam |
| Kata klien proyek | "Mempercepat drafting" adalah kalimat dari sisi arsitek |
| Tidak menutup pintu | Format yang sama tetap bisa diisi klien sendiri; D9 (dua peran) tidak berubah |

**Tujuh pertanyaan untuk rapat klien proyek:**

1. Siapa yang membuka aplikasi dan menekan "mulai desain": klien akhir atau arsitek?
2. Hasilnya dipakai sebagai apa: bahan diskusi konsep, atau gambar yang diteruskan ke tahap kerja?
3. Apakah arsitek memeriksa hasil sebelum klien akhir melihatnya?
4. Boleh minta **satu contoh nyata** dokumen riset lapangan (disamarkan)? Formatnya apa: PDF, foto, tabel?
5. Boleh minta **satu contoh form rasa/psikologi yang sudah terisi** (disamarkan)? Apakah form itu instrumen milik mereka?
6. Sekitar 20 model 3D yang akan dianotasi: milik siapa, dan bolehkah pola turunannya (bukan modelnya) dipakai sistem?
7. Siapa yang bertanggung jawab bila hasil tidak sesuai regulasi atau kondisi tapak?

Jawaban 4 dan 5 menggantikan asumsi di format v0; jawaban 6 menentukan apakah G1 boleh berjalan.

## 3. Komponen yang hilang dan sikap terhadapnya

| Komponen **[arah owner]** | Sikap **[usulan]** |
| --- | --- |
| Isi form | Format v0 di [A-client-brief.template.md](brief-pack/A-client-brief.template.md); diganti saat klien memberi form asli |
| Dokumen riset lapangan | Format v0 di [B-site-dossier.template.md](brief-pack/B-site-dossier.template.md); satu dokumen, empat tingkat bukti (`hypothetical` → `pin` → `lot` → `survey`) |
| Pilihan ruang | [C-room-program.template.md](brief-pack/C-room-program.template.md); diisi dalam alur yang sama dengan form, disimpan terpisah |
| Blueprint | Usul epic baru XB-20 (G1): kartu pola per model beranotasi, dipakai sebagai contoh few-shot dan aturan turunan, **bukan** data latih (±20 sampel terlalu sedikit) |
| Agentic loop sendiri | Tetap XB-05. Model lokal lewat Colab sebagai penguji = XB-04.6 (endpoint berumur pendek, terautentikasi). Jangan dijadikan dependensi Stable (G11) |
| Tiga dokumen sintetis | [examples/synthetic-01/](brief-pack/examples/synthetic-01/PROMPT.md) + lima varian uji |

## 4. Audit celah

Kolom **Dasar** menyebut dari mana celah itu diketahui: `kode` = dicek di repo pada sesi ini; `kontrak` = dari teks task Notion; `spec` = dari spesifikasi MCP 2026-07-28; `riset` = dari sumber web.

### 4.1 Keamanan

| ID | Celah | Dasar | Usulan | Task |
| --- | --- | --- | --- | --- |
| S1 | Brief Pack adalah kanal prompt injection, dan di jalur D11 agent (Claude Code / Codex) berjalan di laptop owner dengan akses shell dan berkas. SEC-05 hanya melindungi sisi server | kontrak (D11, BMB-004) | Profil demo: agent hanya diberi server MCP Sibambo, tanpa shell, tanpa tulis berkas, tanpa server MCP lain. Brief Pack dikirim dalam pembatas data, teks bebas dibatasi, tanpa URL. Varian uji `01-inject`. PDF dan halaman web tidak pernah diberikan langsung ke agent yang memegang tool tulis; peringkas tanpa tool yang menghasilkan Dok B terstruktur | SE-11 SOP, SE-09, XB-05.3 |
| S2 | Jembatan stdio → actor di D11 disebut "thin IPC/loopback client" tanpa syarat autentikasi. Proses lokal lain bisa memanggilnya | kontrak (D11), spec (*Local MCP Server Compromise*) | Named pipe / UDS dengan ACL khusus owner, atau loopback + rahasia acak per peluncuran dari berkas ber-ACL owner. Bind 127.0.0.1. Tes: proses kedua tanpa rahasia ditolak | SE-02 |
| S3 | Kontrak SE-03 belum merinci uji konformansi transport: `Origin` tidak valid → 403; `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` tidak cocok dengan body → 400 `HeaderMismatch` (−32020); GET/DELETE → 405; `Mcp-Session-Id` diabaikan; SSE tidak dapat dilanjutkan | spec (Streamable HTTP) | Tambah ke tes SE-03. Kirim `X-Accel-Buffering: no` dan komentar keep-alive pada stream panjang | SE-03 |
| S4 | Lease writer, `operationId`, idempotency key, dan ticket adalah *state handle*. Spec: kepemilikan handle **tidak boleh** dianggap autentikasi | spec (*State Handle Hijacking*), kontrak (BMB-004 §1) | Baris uji eksplisit: handle milik principal A dipakai principal B (termasuk yang punya grant baca di proyek sama) → ditolak; pelepasan lease oleh bukan pemegang → ditolak | SE-09 |
| S5 | Kecocokan pendaftaran klien nyata dengan IdP belum pernah diuji: metode registrasi (pra-daftar / DCR / Client ID Metadata Document), parameter `resource` (RFC 8707), dan `code_challenge_methods_supported` di metadata. Klien **wajib** menolak bila PKCE tidak diiklankan | spec (Authorization) | **SE-03.0 probe kompatibilitas** sebelum kode adapter: catat apa yang dikirim Claude Code dan Codex versi terpasang terhadap tenant nonproduksi. Hasil probe menentukan desain auth | SE-03 (E5) |
| S6 | Tailscale Funnel adalah paparan internet publik; port hanya 443 / 8443 / 10000; batas bandwidth tidak bisa diatur | riset ([Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)) | Allowlist path di service (`/mcp`, `/draft`, `/v1/projects/*`, metadata OAuth, `/health`), selain itu 404. `/health` tanpa informasi. Batas laju untuk permintaan tak terautentikasi. Skrip stop menutup tunnel lebih dulu. Anggap URL selalu dipindai | SE-09, skrip D11 |
| S7 | Editor tidak mengirim CSP maupun `frame-ancestors`: tidak ada `hooks.server` dan `kit.csp` kosong. Panel owner memuat tombol bernilai tinggi (Grant write, Save) → clickjacking; XSS bisa menggerakkan endpoint BFF. (Cookie sesi sudah `__Host-`, HttpOnly, Secure, SameSite=Lax) | kode (`apps/editor/svelte.config.js`, `src/lib/server/mcp-bff.ts`) | CSP: `default-src 'self'`, `connect-src` self + origin WSS persis, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`; Referrer-Policy; Permissions-Policy. Tes memeriksa header | SE-05 |
| S8 | Render ACK dari browser menggerbangi tulis berikutnya. (a) ACK palsu atau terlalu dini; (b) tab tersembunyi atau tertutup = semua writer macet tanpa batas waktu | kontrak (SE-06, SE-10) | (a) Server memverifikasi digest ACK sama dengan digest yang ia hitung, hanya dari socket ber-ticket owner, satu ACK per revisi. (b) Tenggat ACK (usul 5 s) → keadaan `awaiting_viewer`; galat bertipe `RENDER_ACK_TIMEOUT` (retryable) dan `NO_ACTIVE_VIEWER`. ACK tidak pernah dilewati otomatis | SE-05, SE-06, SE-03.B (E7) |
| S9 | Injeksi tersimpan lintas agent: teks buatan agent A (ID, nama material, provenance) dibaca agent B dan dirender di timeline Editor | kontrak (SEC-05) | Panduan menandai semua teks hasil tool sebagai tidak tepercaya; Editor merender sebagai teks polos. Dua baris uji: label jahat dibaca agent kedua; label jahat dirender di timeline | SE-09 |
| S10 | Dua tab owner = dua viewer; tidak jelas ACK siapa yang berlaku | kontrak (SE-05) | Satu *primary viewer* per proyek (yang terakhir menempel); tab lain pengikut baca-saja dan tidak menggerbangi | SE-05 |
| S11 | `service/requirements.lock` belum disyaratkan ber-hash | kontrak (SE-03) | Instal dengan `--require-hashes`; CI gagal bila lock tanpa hash | SE-03 |
| S12 | Run Brief Pack mengirim isi dokumen ke server penyedia agent. D9: lokal dulu, hosted hanya opt-in yang diungkap | kontrak (D9, TP-021) | **Aturan keras:** di Stable hanya Brief Pack sintetis yang boleh dikirim ke agent hosted. Brief Pack klien nyata menunggu XB-15 | SE-11 SOP |
| S13 | Tidak ada tombol henti darurat tunggal untuk demo | kontrak (D11) | Skrip `stop`: tutup tunnel → cabut grant → hentikan actor, dalam urutan itu | skrip D11 |
| S14 | Respons Save: nama berkas dan cache | kontrak (SE-07) | `Content-Disposition: attachment` dengan nama tersanitasi, `no-store`, batas ukuran; struk tanpa geometri | SE-07 |

### 4.2 Performa

| ID | Celah | Dasar | Usulan | Task |
| --- | --- | --- | --- | --- |
| P1 | `replace_module` mengirim seluruh modul. Contoh di repo 0,9–1,4 KiB per modul ruang, batas 64 KiB. Modul yang membesar membuat setiap revisi kecil mahal (token keluar + jeda) | kode (`schemas/draft-operation-v1.schema.json`, `examples/module-ir-two-rooms.json`) | Panduan menetapkan granularitas: satu ruang per modul, target ≤ 8 KiB. SE-10 mencatat byte per operasi dan jeda antar operasi. Bila median melewati ambang terukur, buka plan untuk operasi patch parametrik (parkir) | SE-03.A, SE-10 |
| P2 | Batas respons tool 256 KiB bisa berarti puluhan ribu token per panggilan | kontrak (BMB-004 §4) | `read_project` ringkas secara default (ID, revisi, hash, bounds; target ≤ 4 KiB); detail hanya lewat `inspect_module`. Laporkan total byte hasil tool per build | SE-03, SE-11 |
| P3 | Worker geometri "proses terisolasi, tenggat 30 s" vs P95 ≤ 500 ms. Spawn proses Python per operasi di Windows mahal | kontrak (SE-09, SE-10) | Worker hangat (pool 1, daur ulang setelah N operasi atau RSS naik); isolasi tetap. Ukur dingin vs hangat | SE-09, SE-10 |
| P4 | SE-10 mengemulasi 100 ms RTT + 10 Mbps, tetapi Funnel melewati relay dengan batas yang tidak dipublikasikan | riset | Preflight demo mengukur RTT dan throughput tunnel nyata; ambang go / no-go tertulis | SE-10, skrip D11 |
| P5 | "20 proyek aktif per worker" × batas 10.000 modul × 64 KiB tidak muat di 512 MiB | kontrak (SE-09, BMB-004 §4, D10) | Batas draft live per proyek (usul awal ≤ 200 modul, ≤ 8 MiB IR, snapshot dipecah ≤ 2 MiB) dan admission berbasis RAM. Angka untuk diukur, bukan janji | SE-02 |
| P6 | "Tanpa replay tak terbatas" belum punya angka; viewer lambat bisa menumpuk antrean | kontrak (SE-05) | Batas antrean per koneksi (usul 64 event / 4 MiB) → paksa resync snapshot. Tes slow-consumer | SE-05 |
| P7 | Agent bisa mengirim tool call paralel; dengan satu-penulis + CAS hasilnya `REVISION_CONFLICT` beruntun | kontrak (SE-02, BMB-004 §5) | Panduan: tulis berurutan. Server: `BUSY` + `retryAfterMs`. SE-11 melaporkan tingkat konflik | SE-03.A, SE-11 |
| P8 | Ticket 30 s dan harus dikirim dalam 5 s; cold start BFF bisa membuat badai reconnect | kontrak (SE-05, D10) | Backoff eksponensial + jitter + batas percobaan; ukur waktu ticket saat cold start | SE-05 |
| P9 | Timeline tumbuh tanpa batas dalam sesi panjang | kontrak (SE-06.A) | Virtualisasi di atas 200 baris; batas baris di memori | SE-06 |

### 4.3 UI

| ID | Celah | Dasar | Usulan | Task |
| --- | --- | --- | --- | --- |
| U1 | Tidak ada satu indikator keadaan draft yang selalu terlihat | kontrak | Chip keadaan: Terputus · Terhubung, menunggu agent · Agent membangun (klien) · Dijeda pemilik · Menunggu viewer · Sinkron ulang · Galat · Tersimpan rev N; plus nomor revisi dan tanda belum disimpan | SE-06 |
| U2 | Aturan "tidak pernah auto-fit" membuat geometri pertama bisa muncul di luar pandangan | kontrak (SE-06) | Keadaan kosong (grid + figur skala + "menunggu operasi pertama"); tombol **Bingkai draft**; indikator tepi "ada perubahan di luar pandangan". Kamera tetap tidak bergerak sendiri | SE-06 (E8) |
| U3 | Baris timeline hanya bisa menyebut ID modul; operasi yang ditolak tidak terlihat | kode (operasi tidak punya field ringkasan), kontrak (SE-06.A) | Ringkasan **deterministik dari diff server** (modul ±, Δ dinding, Δ bukaan), bukan teks bebas agent. Tampilkan operasi ditolak dengan kode galat saja | SE-06 |
| U4 | Highlight perubahan belum mensyaratkan aksesibilitas | kontrak (SE-06.A) | Aman buta warna (bukan hanya merah/hijau); hormati `prefers-reduced-motion` | SE-06 |
| U5 | Panel MCP hanya memberi tautan panduan, tanpa perintah siap salin | kode (`McpPanel.svelte`) | Tombol salin `claude mcp add …` / `codex mcp add …` dengan URL terisi; tombol "Tes koneksi" | SE-10 |
| U6 | Siapa writer sekarang dan sejak kapan tidak tampil ringkas | kontrak | Kartu writer: klien, subject, sejak, operasi terakhir; "Agent diam N menit — lepas writer?" | SE-10 |
| U7 | Tombol Save tidak menyebut revisi yang disimpan | kontrak (SE-07) | "Simpan rev N"; nonaktif dengan alasan saat transaksi berjalan atau validasi gagal | SE-07 |
| U8 | Di lebar 320 px panel dan timeline bisa menutup viewport | kontrak (SE-10) | Bottom sheet; viewport minimal 50 % tinggi layar | SE-10 |

### 4.4 UX

| ID | Celah | Dasar | Usulan | Task |
| --- | --- | --- | --- | --- |
| X1 | Draft hanya di RAM: tutup tab, laptop tidur, atau restart = hilang | kontrak (D10, D11) | Perluas handler `beforeunload` yang sudah ada ke mode draft; tampilkan hitung mundur TTL idle server; ajakan "Simpan sebelum pergi" | SE-05, SE-07 |
| X2 | Saat owner menjeda, agent tidak diberi tahu harus apa → retry berulang | kontrak (SE-03.B) | Galat `PAUSED_BY_OWNER` dengan `nextAction`: baca inbox, tunggu, backoff | SE-03.B |
| X3 | Perilaku tanpa viewer belum diputuskan | kontrak | Lihat S8; default usulan: tulis ditolak | E7 |
| X4 | Onboarding enam langkah (OIDC → proyek → daftar agent → kode pairing → grant baca → grant tulis) tanpa penanda kemajuan | kode (SOP SE-04) | Daftar periksa kemajuan di panel; mode demo satu perintah (D11) | SE-10 |
| X5 | Meminta revisi dari objek di viewport | kontrak (SE-04.A) | Klik modul → "Minta revisi" terisi ID modul; status permintaan muncul di timeline | SE-06 |
| X6 | Setelah sinkron ulang, owner tidak tahu apa yang terlewat | kontrak (SE-05) | Ringkasan "N operasi selama terputus" | SE-06 |
| X7 | Penonton demo bisa mengharapkan atap dan tangga | kode (skema Module IR v1) | Label mode draft: "Skematik — pelat, dinding, bukaan" | SE-06, SE-11 |
| X8 | Owner tidak punya cara cepat mengecek "semua ruang sudah ada?" | — | Batch 1: laporan agent berformat tetap ([PROMPT.md](brief-pack/examples/synthetic-01/PROMPT.md)). Panel kepatuhan menunggu XB-08 | SE-11, XB-08 |

### 4.5 Plan keseluruhan

| ID | Celah | Usulan |
| --- | --- | --- |
| G1 | Tidak ada epic **Blueprint**. XB-19 = fine-tuning; BMB-029 = adapter Rooms | Usul XB-20 · Blueprint cards: per model beranotasi → graf ruang, luas dan proporsi, posisi pintu/jendela relatif dinding, tipe sirkulasi, kedalaman denah. Dipakai sebagai few-shot, aturan turunan, dan fixture evaluasi. Hanya statistik turunan tanpa identitas; butuh izin tertulis pemilik model. Bergantung pada XB-00 dan anotasi Rooms selesai (E9) |
| G2 | Layer 1 tidak bisa diuji sampai Phase 2 | **[arah owner]** Run Brief Pack sintetis di Stable, eksploratif dan **bukan gate**: setelah langkah wajib SE-11, dengan lembar ukur tetap. Butuh amandemen sempit D3 (E6) |
| G3 | Module IR v1 hanya mengenal `floor-slab`, `wall-run`, `opening-cut`. "Rumah kompleks" (atap miring, tangga) tidak bisa diekspresikan; XB-12.2 ada di jalur Experimental | Nyatakan sebagai batas produk Stable di SE-11 dan materi demo. Kapan v1.1 masuk tetap keputusan plan baru (parkir SE-12) |
| G4 | Stable tidak punya ukuran "desain bagus" | Untuk run Brief Pack pakai rubrik kepatuhan deterministik + nilai visual owner. Jangan menyebut "kualitas desain" sebelum XB-08 |
| G5 | Risiko integrasi terbesar (klien nyata ↔ IdP ↔ tunnel) baru diuji di gate manual akhir | Pindahkan ke depan sebagai probe tanpa kode produk (S5, P4) |
| G6 | Jalur kritis menjadi serial dengan dua sesi owner: SE-03 → gate live SE-04 → SE-05 | Satu sesi owner gabungan untuk gate live SE-03 + SE-04; SE-05 boleh mulai sisi cloud saat SE-03 berstatus Review, memakai harness IdP tiruan yang sudah ada (E11) |
| G7 | Status di GitHub usang: `CURRENT-EXECUTION-STATUS.md` Builder masih 8 Nov | Diperbarui pada commit yang sama dengan dokumen ini |
| G8 | Operator utama Batch 2 belum diputuskan | §2 (E10) |
| G9 | Label Inggris untuk form belum ada (D5) | Kunci field sudah Inggris; label Inggris di XB-03.1 |
| G10 | Tiga pack sintetis diminta, baru satu yang lengkap | `synthetic-01` + lima mutasi. Dua pack berikutnya (kavling sudut, lahan miring) dibuat setelah format v0 disetujui |
| G11 | Model lokal via Colab sebagai agent Stable | Tidak dijadikan dependensi: klien MCP yang diarahkan ke endpoint OpenAI-compatible tidak dijamin ada. Tetap XB-04.6 |

## 5. Usulan tambahan acceptance per task

Semua berlabel `D16` dan baru berlaku bila owner menerimanya (E4).

| Task | Tambahan |
| --- | --- |
| SE-02 | S2 jembatan loopback terautentikasi · P5 batas draft live + admission RAM |
| SE-03 | **SE-03.0 probe kompatibilitas (S5)** · S3 konformansi transport · S11 lock ber-hash · P2 `read_project` ringkas · SE-03.A: P1 granularitas modul, P7 tulis berurutan · SE-03.B: kode `RENDER_ACK_TIMEOUT`, `NO_ACTIVE_VIEWER`, `PAUSED_BY_OWNER` (aditif; kode v1.3 tidak berubah) |
| SE-05 | S7 header keamanan · S10 primary viewer · P6 batas antrean + resync · P8 backoff reconnect · X1 peringatan draft belum disimpan |
| SE-06 | S8 verifikasi digest ACK + tenggat · U1 chip keadaan · U2 keadaan kosong + Bingkai draft · U3 timeline deterministik + operasi ditolak · U4 aksesibilitas highlight · P9 virtualisasi · X5 · X6 · X7 |
| SE-07 | S14 header unduhan · U7 "Simpan rev N" · X1 ajakan simpan |
| SE-09 | S1 uji injeksi · S4 pengikatan handle · S6 allowlist path · S9 injeksi tersimpan · P3 worker hangat |
| SE-10 | P1 byte per operasi + jeda · P4 RTT tunnel nyata · U5 · U6 · U8 · X4 |
| SE-11 | G2 run Brief Pack sintetis (eksploratif) · S1 profil agent terbatas di SOP · S12 hanya sintetis · G3 pernyataan batas produk · P2 / P7 metrik per klien |
| Skrip D11 | S6 · S13 · P4 preflight |
| XB (dokumen saja) | XB-01.0 / 02.0 / 03.0 mengadopsi format v0 · XB-05.3 pola peringkas tanpa tool (S1) · XB-20 usulan |

## 6. Keputusan yang dibutuhkan owner

| # | Keputusan | Default usulan |
| --- | --- | --- |
| E4 | Terima D16 (semua atau per item) sebagai tambahan v1.5 | Terima §5 sebagai checklist di task induk; jalur kritis tidak berubah |
| E5 | Izinkan probe kompatibilitas awal SE-03.0 (butuh tenant IdP nonproduksi dan tunnel sementara) | Ya, dibatasi satu hari, tanpa kode produk |
| E6 | Amandemen sempit D3: Brief Pack **sintetis** boleh dipakai sebagai prompt run Stable, eksploratif, bukan gate | Ya |
| E7 | Tanpa viewer aktif: tulis ditolak, atau boleh headless | Ditolak (`NO_ACTIVE_VIEWER`) |
| E8 | Kamera pada geometri pertama | Tetap tidak auto-fit; tombol Bingkai draft |
| E9 | Buat baris XB-20 Blueprint (Blocked) dan konfirmasi hak atas ±20 model | Buat setelah jawaban pertanyaan 6 di §2 |
| E10 | Operator utama Batch 2 | Arsitek sebagai operator; dibawa ke rapat klien |
| E11 | Sesi owner gabungan SE-03 + SE-04 live gate; SE-05 sisi cloud mulai saat SE-03 Review | Ya |

## 7. Yang tidak berubah

Gate fase SE-11 → Experimental · transaksi atomik 1–8 modul · satu penulis berpagar · batas 64 KiB / 256 KiB · tidak ada tool save / export di MCP · Save hanya owner · tidak ada persistensi draft sebelum Save · klien nyata Claude Code dan Codex untuk SE-11 · tidak ada pelemahan tes agar lolos · D7 (materi Batch 2 tidak ke repo publik).

## 8. Sumber

Spesifikasi MCP 2026-07-28: [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) · [Authorization — Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) · [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices). Tunnel: [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel). Sumber briefing dan tapak tercantum di [brief-pack/README.md](brief-pack/README.md). Riset pembangkitan denah berbasis LLM yang relevan untuk XB-06: [HouseTune (AAAI 2026)](https://ojs.aaai.org/index.php/AAAI/article/view/38417), [HouseLLM](https://arxiv.org/abs/2411.12279v2), [Text-to-Layout](https://arxiv.org/abs/2509.00543) — semuanya dua tahap (LLM menyusun tata letak awal, tahap kedua memperbaiki), bukan agent yang langsung menulis geometri.
