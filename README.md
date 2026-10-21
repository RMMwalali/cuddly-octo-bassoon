# Reactive Captions

Automatic captions for creators that react to *how* something is said, not just what is said.

Drop in a video and it:

1. **Transcribes it on your device** with Whisper (via [transformers.js](https://github.com/huggingface/transformers.js)), with a timestamp for every word. Nothing is uploaded.
2. **Listens to each word.** It measures loudness, pitch and how long the word is stretched, compared with the speaker's own normal voice, and gives each word an emphasis level: normal, stressed, strong or shout.
3. **Reads the mood of each caption** (excited, intense, soft, question or neutral) from energy, pitch, punctuation and a small word list in English and Swahili.
4. **Optionally tags sounds** such as `[laughs]`, `[applause]`, `[gasps]` and `[music]` with an AudioSet classifier.
5. **Animates the captions to match.** Louder words grow, shouts go all caps and shake, emphasized words take the mood's color, and excited lines bounce.

Creators can then fix any word, change its emphasis or a caption's mood, and export.

## Features

- Four looks: **Pop** (bold, active word lights up), **Hype** (one word at a time), **Karaoke** (fills in as it is spoken) and **Clean** (boxed subtitles for long-form).
- Top, middle or bottom placement. "Few words" for TikTok, Reels and Shorts, or "Full lines" for YouTube and podcasts.
- Each reaction (size, color, motion, sound tags) can be turned on or off, and a sensitivity slider goes from calm to wild.
- **Reaction strip** under the video: one block per word, where height is emphasis and color is mood. Click a block to edit that word.
- Bring existing subtitles: import an `.srt` or `.vtt` and the tool adds reactions from the audio, skipping transcription.
- Language choice (or auto-detect) and three model sizes.
- Exports:
  - **Video with captions burned in**, rendered in the browser (MP4 where the browser supports it, otherwise WebM).
  - **`.ass` styled subtitles** that keep the sizes, colors and active-word highlight. They open in VLC, mpv and Aegisub, and burn in with `ffmpeg -i in.mp4 -vf subtitles=captions.ass out.mp4`.
  - **`.srt`** for uploading to YouTube, TikTok or Instagram. Shouts stay in caps and sound tags are included.
  - **`.vtt`** with word timing and bold emphasis.

## Run it

No build step and no dependencies.

```sh
npm start          # serves the app at http://localhost:5173
npm test           # unit tests for the audio analysis, reaction engine and exports
```

Opening `index.html` straight from disk will not work, because browsers block module workers on `file://`. Use `npm start` or any static server.

### Deploy

Pushing to `main` runs the tests and publishes the site with GitHub Pages (`.github/workflows/pages.yml`). Turn it on once under **Settings → Pages → Source: GitHub Actions**.

## How it works

```
video file
  └─ decode audio to 16 kHz mono            src/audio.js
       ├─ Whisper, word timestamps          src/worker.js (Web Worker, WebGPU or WASM)
       ├─ AudioSet sound tagging (optional) src/worker.js
       └─ per-word loudness and pitch       src/audio.js
            └─ reaction engine              src/reactive.js
                 emphasis level per word, caption grouping, mood per caption
                 └─ canvas renderer         src/renderer.js + src/presets.js
                      ├─ live preview       src/main.js, src/strip.js
                      └─ exports            src/export.js
```

- Emphasis is **relative to the speaker**. Scores are z-scores against the median loudness and pitch of the clip, so a quiet narrator and a loud streamer both get a sensible spread. Very flat audio produces no emphasis instead of random emphasis.
- Small words like "the" and "and" are capped at "stressed" so they never become the highlight unless they are shouted.
- Whatever the creator sets by hand is kept when the analysis re-runs, for example after moving the sensitivity slider.
- Long videos are transcribed in pieces of up to 28 seconds, cut at the quietest moment near each boundary so no word is split.

### Models

| Option | Model | First download (approx.) |
|---|---|---|
| Fast | `onnx-community/whisper-tiny_timestamped` | Smallest |
| Balanced (default) | `onnx-community/whisper-base_timestamped` | About 80 MB on CPU, 210 MB on GPU |
| Best | `onnx-community/whisper-small_timestamped` | Several hundred MB |
| Sound tags | `Xenova/ast-finetuned-audioset-10-10-0.4593` | About 90 MB |

Models download from the Hugging Face Hub the first time and are cached by the browser. WebGPU is used when available (recent Chrome and Edge), otherwise WebAssembly, which is slower.

## Limitations and next steps

This is a prototype.

- **Mood and emphasis are heuristics**, not a trained emotion model. They work well on clear speech and can misread music beds, multiple speakers or heavily compressed audio. Every result can be edited.
- **Video export plays in real time** and needs the tab to stay visible. Chrome produces H.264 MP4. Some Chromium builds and Firefox produce WebM or VP9 instead, which some phone apps reject. For guaranteed MP4, export `.ass` and burn it in with ffmpeg.
- Swahili and Sheng accuracy depends on Whisper. Larger models do noticeably better.
- Ideas for later: a trained speech-emotion model, speaker colors, emoji reactions, saved projects, more looks, and server-side rendering for long videos.

## License

MIT
