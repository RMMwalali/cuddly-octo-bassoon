# Reactive Captions

Automatic [Caption with Intention](https://www.captionwithintention.org/) (CWI) captions for creators, made in the browser.

CWI is a caption design system from the Chicago Hearing Society. It shows *how* something is said, not just what is said. Doing it by hand in After Effects takes hours. This tool does it automatically from the video's audio. Creators can then adjust any word and export.

| CWI pillar | What you see | How it's made automatically |
|---|---|---|
| **Attribution** | Each speaker has their own color | In-browser voice fingerprints (WeSpeaker CAM++) grouped by speaker, or speaker names from imported subtitles |
| **Synchronization** | Each word turns from white to the speaker's color as it's spoken, over 600 ms, and emphasized words bounce 15% | Word timestamps from Whisper |
| **Intonation** | Roboto Flex gets **bolder for a lower voice** and thinner for a higher one. Words get **bigger when louder** and smaller when quieter | Pitch and loudness measured for every word, relative to *that speaker's* normal voice |

Everything runs on the creator's device. The video is never uploaded.

## Features

- Drop in a video: it's transcribed with Whisper, speakers are detected, every word's pitch and loudness is measured, and the captions are styled.
- **Speakers tab:** rename speakers, pick colors from a palette that passes WCAG contrast, or merge speakers that were split by mistake.
- **Words tab:** every caption with its speaker. Click a word to change its text, weight (thin ↔ bold), size (quiet ↔ loud) or emphasis, or to move a caption to another speaker.
- **Check tab:** scores the captions against the 12 CWI rules from [OpenCaptions](https://github.com/broomva/opencaptions) and links each problem to the caption it's in.
- **16 fonts.** 12 are variable fonts that carry the full CWI weight range: Roboto Flex (the official CWI typeface), Inter, Montserrat, Outfit, Unbounded, Archivo, Oswald, Sora, Bricolage Grotesque, Recursive, Fraunces and Playfair Display. Four are single-weight display fonts: Bebas Neue, Anton, Luckiest Guy and Permanent Marker. In those, lower-pitched words are drawn thicker. Each CWI weight is mapped into the font's own range, and regular stays regular. Fonts load only when picked.
- **3D motion styles**, rendered with WebGL and kept faithful to CWI. Words still turn from white to the speaker's color as they're spoken, size still follows volume, weight follows pitch, and emphasized words still bounce, now also pushing toward the camera.
  - **Extrude:** solid, lit 3D letters with depth and shadow.
  - **Flip:** unspoken words lean back, then flip up to face you as they're said.
  - **Swing:** words swing open like doors.
  - **Drop:** words hover faintly, then fall into place.
  - **Stage:** the caption lies on a tilted stage, and each word stands up as it's spoken.
  - **Flat:** classic CWI.
  3D shows in the preview and in the exported video. Subtitle files keep the flat CWI animation.
- **Style:** position, a few words at a time (short-form) or full lines (long-form), text size, outline or dark box, optional speaker names, and an intonation-strength slider.
- **Intention strip** under the video: one block per word, where color is the speaker, height is loudness, opacity is weight and a dot marks emphasis. Click a block to edit that word.
- **Bring your own captions:** import a `.srt` or `.vtt` (speaker names are read from `<v Name>` tags or `NAME:` prefixes) to skip transcription, or a `.cwi.json` from OpenCaptions or from this tool.
- Exports:
  - **Video with captions burned in**, rendered in the browser.
  - **`.cwi.json`**, the OpenCaptions document format. It can be validated and exported to After Effects or Premiere with the OpenCaptions CLI.
  - **`.ass`** that plays the full CWI animation (white-to-color sync, per-word weight and size, bounce) in VLC, mpv and Aegisub. Burn it in with `ffmpeg -i in.mp4 -vf subtitles=captions.ass out.mp4`. Install Roboto Flex for the exact look.
  - **`.vtt`** with speaker voice tags, word timing and bold emphasis.
  - **`.srt`** for platform upload, with `Name:` on speaker changes.

## Run it

No build step and no dependencies.

```sh
npm start   # http://localhost:5173
npm test    # engine, validator and export tests
```

Opening `index.html` directly from disk will not work, because browsers block module workers on `file://`. Use `npm start` or any static server.

### Put it online

When importing to Vercel, set the **Project Name** to `reactivecaptions` so the address is `reactivecaptions.vercel.app`, which the share previews, sitemap and canonical link already point to. If you use another address or your own domain, replace `reactivecaptions.vercel.app` in `index.html`, `robots.txt` and `sitemap.xml`.


It is a static site with no build step. Everything works on any static host, with transcription running in each visitor's browser.

### Fast mode (cloud transcription, recommended)

On-device Whisper is private but slow on phones (a model download, then roughly real time or slower). On Vercel, the included function `api/transcribe.js` turns on **Fast mode**: the page compresses the speech to a small MP3 (about 240 KB a minute, never the video) and gets word-timed text back in a few seconds. With Deepgram it also gets speaker labels in the same call, so the voice model is skipped.

1. Create a key with one provider:
   - **Deepgram** (preferred: words and speakers together; about $0.0043 per audio minute, with free starter credit): [console.deepgram.com](https://console.deepgram.com) → API Keys → Create a key with the Member role.
   - **Groq** (Whisper large-v3-turbo; $0.04 per audio hour, words only, so speakers are still found on the device): [console.groq.com/keys](https://console.groq.com/keys).
2. In Vercel: **Project → Settings → Environment Variables**, add `DEEPGRAM_API_KEY` (or `GROQ_API_KEY`, or both: Groq then backs up Deepgram and handles languages Deepgram lacks, such as Swahili), for Production and Preview.
3. **Deployments → ⋯ → Redeploy** so the function picks up the key.

Without a key, the page detects that and quietly uses on-device transcription. Visitors can always choose **Private** under Options. The key stays on the server; the function only accepts requests from the site's own pages and audio under 4.4 MB (about 18 minutes).

- **Vercel:** in vercel.com choose **Add New → Project**, import this repository, keep the framework preset **Other** with no build command and output directory `.`, and deploy. `vercel.json` adds sensible headers.
- **Netlify / Cloudflare Pages:** connect the repository, leave the build command empty, publish directory `.`.
- **GitHub Pages:** under **Settings → Pages**, choose **Deploy from a branch**, `main`, `/ (root)`.

Pushing to `main` runs the tests on GitHub Actions.

The site must be served over HTTPS (all of these do), because browsers only allow module workers, the model cache and the screen wake lock on secure pages.

## How it works

```
video
 └ decode to 16 kHz mono                         src/audio.js
    ├ Whisper word timestamps                    src/worker.js  (WebGPU or WASM)
    ├ voice fingerprints (WeSpeaker CAM++)       src/speaker-worker.js + src/fbank.js
    └ per-word pitch (autocorrelation) and loudness      src/audio.js
       └ CWI engine                              src/cwi.js
          speaker attribution, voice profile per speaker,
          pitch → weight, volume → size, emphasis, caption grouping
          ├ 12-rule CWI check                    src/validate.js
          ├ fonts and weight mapping             src/fonts.js
          ├ canvas renderer, preview and export  src/renderer.js
          ├ WebGL 3D layer                       src/gl3d.js
          └ .cwi.json / .ass / .vtt / .srt       src/export.js
```

### The intonation mapping

For each speaker, the tool builds a voice profile (median, 10th and 90th percentile of pitch and loudness), using the same fields as OpenCaptions. Each word is then placed against that profile:

- **Weight** = 400 − 600 × pitch offset, rounded to 50 and kept within 100–900. A word at the speaker's usual pitch is 400 (regular), a word near their low end is about 700, and a word near their high end is about 100.
- **Size** = 1 + 0.6 × loudness offset, kept within 0.7–1.5.
- **Emphasis** marks words clearly louder than that speaker usually is, or marked with "!". Small words like "the" rarely qualify.
- A small dead zone stops ordinary word-to-word wobble from making the type flicker.
- The intonation-strength slider scales these offsets. Manual edits are always kept.

Because everything is relative to the speaker, a deep voice is not bold all the time. Only the words that drop below that person's usual pitch get bolder.

**Difference from OpenCaptions.** OpenCaptions' V1 RulesMapper makes higher pitch *heavier*. This tool follows the CWI design guide instead: bold for low pitch, thin for high pitch. Both write the same `.cwi.json` fields, so files work in either tool.

### Telling speakers apart

1. Speech is cut into short pieces at pauses and sentence ends, at most 3 seconds each.
2. Each piece of 0.7 s or more gets a voice fingerprint from WeSpeaker CAM++, using Kaldi-style filterbank features computed in JavaScript (`src/fbank.js`, checked against kaldi-native-fbank in the tests).
3. If the creator picked how many people talk ("Who's talking?" on the start screen), the fingerprints are grouped into exactly that many voices.
4. If they picked "Not sure", grouping is deliberately cautious, and a "voice" made of a single fingerprint is folded into the closest real one, so a noisy moment in a solo video never becomes a second person.

Measured on real recordings (words assigned to the right person): solo speeches 100%, an interview with the count given 91% (auto: 84%), a fast four-line film argument 74%. Quick interruptions with no pause and old, noisy recordings are the weak spots; the Words tab fixes a line's speaker in one tap.

### Models

| Job | Model | First download (approx.) |
|---|---|---|
| Speech, Fast | `onnx-community/whisper-tiny_timestamped` | Smallest |
| Speech, Balanced (default) | `onnx-community/whisper-base_timestamped` | About 80 MB on CPU, 210 MB on GPU |
| Speech, Best | `onnx-community/whisper-small_timestamped` | Several hundred MB |
| Voices | WeSpeaker CAM++ (VoxCeleb), via `csukuangfj/speaker-embedding-models` | About 28 MB |

The models come from the Hugging Face Hub via [transformers.js](https://github.com/huggingface/transformers.js) and are cached by the browser.

## Limitations

This is a prototype.

- **Speaker detection** can mix up voices in very fast exchanges or on old, noisy recordings. Choosing the number of speakers helps; the Words tab fixes the rest.
- **Phones:** the Fast model (about 40 MB) is the default on phones, everything runs on one CPU thread, and the screen is kept awake while working. Very large files (over about 500 MB) may be too big for a phone's memory. If a browser can't read a file's audio directly (some iPhone .mov files), the app plays it once to listen instead.
- **Pitch tracking** is a simple autocorrelation tracker. Music, overlapping speech and heavy noise make weights less reliable.
- **3D styles** need WebGL2, which every current desktop and phone browser has. Without it, captions fall back to flat CWI.
- **Video export** plays in real time and needs the tab to stay visible. Chrome produces MP4. Other browsers may produce WebM or VP9, which some phone apps reject. In that case, export `.ass` and burn it in with ffmpeg.
- The CWI visual guidelines come from captionwithintention.org. The full design-system PDF is available on request from the Chicago Hearing Society.

## Credits

- Caption with Intention, by the Chicago Hearing Society.
- MP3 encoding uses [lamejs](https://github.com/zhuker/lamejs), a port of [LAME](https://lame.sourceforge.io), included unmodified as `src/vendor/lamejs.js` under the LGPL-3.0 (`src/vendor/LAMEJS-LICENSE`).
- The validation rules, document format and test fixtures in `test/fixtures/` are from [OpenCaptions](https://github.com/broomva/opencaptions) (MIT).

## License

MIT
