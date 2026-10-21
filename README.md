# Reactive Captions

Automatic [Caption with Intention](https://www.captionwithintention.org/) (CWI) captions for creators, made in the browser.

CWI is a caption design system from the Chicago Hearing Society. It shows *how* something is said, not just what is said. Doing it by hand in After Effects takes hours. This tool does it automatically from the video's audio. Creators can then adjust any word and export.

| CWI pillar | What you see | How it's made automatically |
|---|---|---|
| **Attribution** | Each speaker has their own color | In-browser speaker detection (pyannote segmentation), or speaker names from imported subtitles |
| **Synchronization** | Each word turns from white to the speaker's color as it's spoken, over 600 ms, and emphasized words bounce 15% | Word timestamps from Whisper |
| **Intonation** | Roboto Flex gets **bolder for a lower voice** and thinner for a higher one. Words get **bigger when louder** and smaller when quieter | Pitch and loudness measured for every word, relative to *that speaker's* normal voice |

Everything runs on the creator's device. The video is never uploaded.

## Features

- Drop in a video: it's transcribed with Whisper, speakers are detected, every word's pitch and loudness is measured, and the captions are styled.
- **Speakers tab:** rename speakers, pick colors from a palette that passes WCAG contrast, or merge speakers that were split by mistake.
- **Words tab:** every caption with its speaker. Click a word to change its text, weight (thin ↔ bold), size (quiet ↔ loud) or emphasis, or to move a caption to another speaker.
- **Check tab:** scores the captions against the 12 CWI rules from [OpenCaptions](https://github.com/broomva/opencaptions) and links each problem to the caption it's in.
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

Pushing to `main` runs the tests and publishes to GitHub Pages. Turn that on once under **Settings → Pages → Source: GitHub Actions**.

## How it works

```
video
 └ decode to 16 kHz mono                         src/audio.js
    ├ Whisper word timestamps                    src/worker.js  (WebGPU or WASM)
    ├ pyannote speaker segments                  src/worker.js
    └ per-word pitch (autocorrelation) and loudness      src/audio.js
       └ CWI engine                              src/cwi.js
          speaker attribution, voice profile per speaker,
          pitch → weight, volume → size, emphasis, caption grouping
          ├ 12-rule CWI check                    src/validate.js
          ├ canvas renderer, preview and export  src/renderer.js
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

### Models

| Job | Model | First download (approx.) |
|---|---|---|
| Speech, Fast | `onnx-community/whisper-tiny_timestamped` | Smallest |
| Speech, Balanced (default) | `onnx-community/whisper-base_timestamped` | About 80 MB on CPU, 210 MB on GPU |
| Speech, Best | `onnx-community/whisper-small_timestamped` | Several hundred MB |
| Speakers | `onnx-community/pyannote-segmentation-3.0` | About 6 MB |

The models come from the Hugging Face Hub via [transformers.js](https://github.com/huggingface/transformers.js) and are cached by the browser.

## Limitations

This is a prototype.

- **Speaker detection** uses the pyannote segmentation model alone, without voice embeddings. It handles up to 3 speakers and works best on short clips. On long videos it can mix up who is who. The Speakers and Words tabs exist to fix that quickly.
- **Pitch tracking** is a simple autocorrelation tracker. Music, overlapping speech and heavy noise make weights less reliable.
- **Video export** plays in real time and needs the tab to stay visible. Chrome produces MP4. Other browsers may produce WebM or VP9, which some phone apps reject. In that case, export `.ass` and burn it in with ffmpeg.
- The CWI visual guidelines come from captionwithintention.org. The full design-system PDF is available on request from the Chicago Hearing Society.

## Credits

- Caption with Intention, by the Chicago Hearing Society.
- The validation rules, document format and test fixtures in `test/fixtures/` are from [OpenCaptions](https://github.com/broomva/opencaptions) (MIT).

## License

MIT
