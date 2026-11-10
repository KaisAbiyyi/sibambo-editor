# Dokumen C — Program Ruang

> **DRAFT planning-only (D3) · masukan XB-02.0.** Selaras dengan kontrak XB-02: ID ruang stabil, luas min / target / max, prioritas must / should / could, hubungan require / prefer / avoid, anggaran luas dengan cadangan sirkulasi eksplisit, daftar konflik. Rentang luas di sini adalah **placeholder** dari v1.4 §2.2 dan belum bersumber.

## Kenapa terpisah dari Dok A

Pengisiannya menyatu dengan form (satu alur), tetapi datanya dipisah:

| | Dok A | Dok C |
| --- | --- | --- |
| Sifat | Preferensi lunak | Kendala keras |
| Bentuk | Kutipan, skala | Angka, ID, relasi |
| Bisa dihitung | Tidak | Ya (Σ luas vs lahan) |
| Kalau bertabrakan | Ditimbang | Dilaporkan sebagai konflik |

Alur yang diusulkan: jawaban Dok A (§3 penghuni, §4 rutinitas, §7 tamu) **mengusulkan** program awal dari template; pengguna mengedit; hasilnya dikonfirmasi. Setiap ruang mencatat dari mana ia berasal.

## Katalog isi

### §1 Ringkasan

| Kunci | Isi |
| --- | --- |
| `summary.floors` | Jumlah lantai yang diminta (lebih dari satu **ditangkap**, tetapi solver belum mendukung sebelum XB-12) |
| `summary.template` | `type-36` · `type-45` · `type-54` · `type-70` · `rumah-tumbuh` · `2-storey-3br` · `house-business` · `custom` |
| `summary.target_gfa_m2` | Luas lantai total yang dituju |
| `summary.occupants` | Jumlah penghuni (dari Dok A) |

### §2 Daftar ruang

Satu entri per ruang (bukan per tipe; dua kamar anak = dua entri).

| Kunci | Isi |
| --- | --- |
| `id` | Slug stabil: `bed-master`, `bed-child-1`, `kitchen-wet` |
| `type` | Dari katalog di bawah |
| `label` | Nama tampil (ID) |
| `floor` | `1` · `2` · `any` |
| `area_m2` | `{min, target, max}` |
| `min_width_m` | Lebar bersih minimum (opsional) |
| `priority` | `must` · `should` · `could` |
| `privacy` | `public` · `semi` · `private` · `service` |
| `needs` | `daylight` · `cross_vent` · `exterior_wall` · `wet` · `quiet` · `street_view` · `garden_access` |
| `occupancy` | Jumlah pemakai utama |
| `origin` | `template` · `client` · `architect` · `proposed_from:A.<kunci>` |
| `confirmed` | `true` / `false` |
| `phase` | `1` · `2` (rumah tumbuh) |

**Katalog tipe (ID / EN):** `terrace` teras · `living-guest` ruang tamu · `living-family` ruang keluarga · `dining` ruang makan · `kitchen-dry` dapur bersih · `kitchen-wet` dapur kotor · `bed-master` kamar utama · `bed-child` kamar anak · `bed-guest` kamar tamu · `bath` kamar mandi · `prayer` mushola · `study` ruang kerja · `storage` gudang · `laundry` cuci-jemur · `helper` kamar ART · `carport` · `garden` taman · `courtyard` taman dalam · `void` · `stair` tangga · `balcony` balkon · `shop` ruang usaha.

### §3 Hubungan antar ruang

| Kunci | Isi |
| --- | --- |
| `relations[]` | `{a, b, kind, strength, reason}` |
| `kind` | `adjacent` (berbagi dinding) · `connected` (ada pintu) · `near` · `separated` · `visible_from` · `not_visible_from` |
| `strength` | `require` · `prefer` · `avoid` |
| `reason` | Rujukan ke Dok A (`needs.N3`) atau teks pendek |

### §4 Aturan bukaan (default yang bisa diubah)

| Kunci | Isi |
| --- | --- |
| `openings.every_habitable_room_has_window` | `true` |
| `openings.every_room_reachable` | `true` (tidak ada ruang tanpa pintu) |
| `openings.main_entry_faces` | `street` atau sisi tertentu |
| `openings.bath_window` | `high` · `none` |
| `openings.no_window_toward[]` | Sisi yang tidak boleh ada jendela (privasi tetangga) |

### §5 Anggaran luas

| Kunci | Isi |
| --- | --- |
| `budget.sum_min_m2` · `sum_target_m2` | Jumlah luas ruang tertutup |
| `budget.circulation_reserve_percent` | Cadangan sirkulasi + dinding, dinyatakan eksplisit (placeholder 15–25) |
| `budget.gross_target_m2` | `sum_target × (1 + cadangan)` |
| `budget.ground_floor_limit_m2` | `KDB × luas lahan` jika KDB diketahui; jika tidak, `unknown` |
| `budget.fits` | `yes` · `no` · `cannot_assess` |

### §6 Konflik

| Kunci | Isi |
| --- | --- |
| `conflicts[]` | `{id, kind, detail, options[], resolved_by, resolution}` |
| `kind` | `min_gt_max` · `sum_exceeds_site` · `impossible_adjacency` · `floor_unsupported` · `must_vs_must` |

Konflik yang belum diselesaikan **tidak** boleh diselesaikan agent secara diam-diam: agent tidak boleh menghapus ruang, menurunkan `must`, atau mengubah `require` menjadi `prefer`.

## Template serialisasi

```yaml
schema: brief-pack/room-program@0
project_id: <slug>
status: draft | confirmed
confirmed_by: [client, architect]

summary: { floors: 1, template: type-45, target_gfa_m2: 0, occupants: 0 }

rooms:
  - id: living-family
    type: living-family
    label: "Ruang keluarga"
    floor: 1
    area_m2: { min: 12, target: 16, max: 20 }
    min_width_m: 3.0
    priority: must
    privacy: semi
    needs: [daylight, cross_vent, garden_access]
    occupancy: 4
    origin: "proposed_from:A.routine.most_used_space"
    confirmed: true
    phase: 1

relations:
  - { a: kitchen-wet, b: living-family, kind: separated, strength: prefer, reason: "needs.N2" }
  - { a: dining, b: kitchen-dry, kind: connected, strength: require, reason: "client" }

openings:
  every_habitable_room_has_window: true
  every_room_reachable: true
  main_entry_faces: street
  bath_window: high
  no_window_toward: []

budget:
  sum_min_m2: 0
  sum_target_m2: 0
  circulation_reserve_percent: 20
  gross_target_m2: 0
  ground_floor_limit_m2: unknown
  fits: cannot_assess

conflicts: []
```

## Aturan untuk agent yang membaca Dok C

1. Setiap ruang `must` harus ada di hasil, dengan luas di dalam `[min, max]`. Jika tidak mungkin, berhenti dan laporkan; jangan membuang ruang.
2. Relasi `require` adalah kendala keras; `prefer` dan `avoid` dioptimalkan dan dilaporkan terpenuhi atau tidak.
3. `floors > 1` dengan tool saat ini: agent menyatakan *tidak didukung* (Module IR v1 hanya mengenal pelat lantai, dinding, bukaan) dan tidak memalsukan tangga.
4. Laporan akhir memuat tabel kepatuhan: ruang → luas terbangun → status; relasi → terpenuhi atau tidak; aturan bukaan → lolos atau gagal.
