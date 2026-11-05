# KCD Hukuk desktop (Mac and Windows)

## İndir / Aç

| | Tek tık | Not |
|---|---|---|
| 🍎 **Mac** | [**KCD-Hukuk-Mac.dmg**](https://github.com/udaykalkal/kcd-hukuk-desktop/releases/latest/download/KCD-Hukuk-Mac.dmg) | Apple silicon. Açılan pencerede uygulamayı Uygulamalar klasörüne sürükleyin; ilk açılışta gerekirse Sistem Ayarları › Gizlilik ve Güvenlik › **Yine de Aç**. |
| 🪟 **Windows** | [**KCD-Hukuk-Windows.exe**](https://github.com/udaykalkal/kcd-hukuk-desktop/releases/latest/download/KCD-Hukuk-Windows.exe) | Çift tıklayın, kurulum kendiliğinden biter. SmartScreen uyarısında **Ek bilgi › Yine de çalıştır**. |
| 🌐 **Web** | [**KCD Hukuk’u tarayıcıda aç**](https://claude.ai/artifact/TGniJ3KNVgcHiBJMH5Hkmw) | Telefon, tablet veya başka bir bilgisayar için. Tarayıcıda Claude’un kendi çubuğu (sohbet, paylaş, ana sayfa) görünür ve gizlenemez; Claude’suz, yalnız KCD Hukuk penceresi için Mac veya Windows uygulamasını kullanın. |

Mac ve Windows uygulamaları aynı uygulamayı Claude çubukları olmadan açar ve Claude sohbetine dönüşe izin vermez; hesap değiştirmek için menüde **KCD Hukuk › Çıkış yap**. Veriler ve yenilikler her yerde aynıdır. İndirme bağlantıları bu depoya erişimi olan GitHub hesabıyla çalışır (depo gizli).

A light desktop window for **KCD Hukuk**, the office's Claude artifact (https://claude.ai/artifact/TGniJ3KNVgcHiBJMH5Hkmw). It opens the app without Claude's own bars and adds what a desktop app needs: file downloads, notifications, links in the default browser, and self-installing updates of the window itself. There is no backend: the app, its data and its connectors stay in Claude. The app's own code lives in [udaykalkal/kcd-office](https://github.com/udaykalkal/kcd-office) (`prototype/`).

Based on the kcdAI shell 2.0.5 (Tauri 2), with a new app ID (`tr.av.kolancoskuner.kcdhukuk`) so it installs next to the old kcdAI app, and a new update-signing key.

Install guide (Turkish): [docs/KURULUM.md](docs/KURULUM.md).

## What changes where

| Change | Where | Needs a new desktop release? |
|---|---|---|
| Features, screens, data | the artifact (kcd-office) | **No**: the window loads the artifact on every start |
| The artifact link moves (e.g. to another Claude account) | Settings page of the window, or `DEFAULT_URL` in `src-tauri/src/lib.rs` | Only to change the default for new installs |
| Window behaviour, menus, downloads | this repository | Yes |

## Releasing a new window version

1. Raise `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Build on a Mac with the update key from the owner-only folder:
   ```bash
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/kcdai-private-20261104/kcd-hukuk-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri build
   ```
3. Publish a GitHub release `vX.Y.Z` with `KCD-Hukuk-Mac.dmg`, the updater archive (`.app.tar.gz` + `.sig`) and `latest.json`.
   Installed copies download it in the background and install it on the next start.
4. Windows (and universal Mac) builds: `.github/workflows/release.yml` runs on a push to the `release` branch. It needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the owner sets it; the key never goes into git).

The private key lives only in `~/kcdai-private-20261104/`. Losing it means installed copies can no longer self-update (a new key needs one manual reinstall).
