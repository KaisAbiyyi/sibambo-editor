# Demo lokal Sibambo: MCP + live viewer (tanpa Auth0)

Master plan **SIB-TWO-PHASE-001 v1.6**. Satu perintah menjalankan service canonical (Builder), Editor, dan konfigurasi MCP untuk **Claude Code** dan **Codex**. Hanya loopback (`127.0.0.1`/`localhost`): tanpa Auth0, tunnel, hosting, atau sertifikat.

> **Batas yang jujur.** Service, actor, viewer, dan jembatan MCP berjalan lokal. *Inferensi model* Claude/Codex tetap memakai akun cloud masing-masing (butuh internet). Ini bukan klaim air-gapped. Mode ini **bukan** konfigurasi remote/produksi dan tidak menggantikan uji keamanan yang ditunda (OAuth/PKCE, tenant, pentest).

## Prasyarat

- Windows, Node >= 22, Bun, `claude` dan `codex` sudah login ke akun masing-masing.
- Checkout `sibambo-bomc-builder` di samping repo ini, dan Python dengan dependensi `service/requirements.lock`.
- Semua keluaran (temp, log, receipt) ditulis di **D:**; peluncur menolak path di C:.

## Jalankan

```powershell
node tooling/local-demo/launch.mjs --python D:\path\ke\venv\Scripts\python.exe
```

Pertama kali Editor dibangun dalam mode demo lokal (beberapa puluh detik). Akhirnya tercetak `LOCAL DEMO READY`. `Ctrl+C` menghentikan semuanya dan menghapus konfigurasi agent serta rahasia jembatan.

Jika port 8765/5175 dipakai proses lain, peluncur berhenti tanpa menyentuhnya dan menyebut PID pemiliknya. `--replace-task-owned` hanya menghentikan proses yang tercatat peluncur ini.

## Langkah owner (manual, dilakukan Kais)

1. Buka `http://localhost:5175` → **Extensions → MCP Extension…** → **Masuk (demo lokal)**. Panel menampilkan banner *MODE DEMO LOKAL*.
2. Proyek `local-demo` sudah terbuka dan kedua agent sudah diberi izin read+write. Tekan **Hubungkan draft live**. Harapan: "Viewer utama · revisi 0 / tergambar 0".
3. Jalankan agent (di terminal lain), mis.:
   ```powershell
   node tooling/local-demo/run-agent.mjs claude build
   node tooling/local-demo/run-agent.mjs codex verify
   ```
   Kasus: `probe`, `build`, `verify`, `revise-inbox`, `opening`, `contention`. Setiap run menulis receipt metadata-saja ke `D:\projects\sibambo\outputs\2026-11-14-local-mcp-live-viewer\`.
4. Harapan di Editor: satu ruangan muncul, "Revisi diterima = Revisi tergambar", tidak ada dinding ganda.
5. Kirim **Minta revisi ke agent** (pilih/ketik ID modul `room/demo/main-room`), lalu `run-agent.mjs codex revise-inbox`. Harapan: status permintaan `open` → `read` → **addressed hanya setelah ruangan tergambar ulang**.
6. Penilaian visual proporsi ruangan/bukaan adalah keputusan Anda (agent tidak mengklaim lulus).
7. Putuskan jaringan fisik saat tab terbuka lalu sambungkan lagi: harapan status jeda lalu pulih tanpa dinding ganda (tidak diotomatisasi). Tutup tab saat draft hidup: harapan peringatan; **Batal** mempertahankan model.

Tab harus **terlihat** (bukan tersembunyi) agar viewer dianggap aktif; tanpa viewer aktif agent menerima `NO_ACTIVE_VIEWER` dan harus berhenti.

## Uji otomatis nyata

```powershell
node tooling/local-demo/live-acceptance.mjs      # Chromium headless nyata + Claude Code & Codex asli
node tooling/local-demo/restart-check.mjs --python D:\...\python.exe   # restart server: epoch baru, frame terakhir bertahan
```

## Apa yang tidak dilakukan

Tidak ada Save/reopen (SE-07), restore draft setelah restart (SE-08), atap/tangga/IR baru, ekspor, atau persistensi draft. Draft hilang bila server dihentikan; tab lama menampilkan "Epoch server berubah" dan mempertahankan frame terakhir.
