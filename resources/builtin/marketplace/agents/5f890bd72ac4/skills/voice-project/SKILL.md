---
name: voice-project
ownerAgent: 5f890bd72ac4
description_zh: 制作可继续修改的配音、转写和混音项目；用内置音频组件处理本地素材，分段记录配音请求并恢复进度。
description_en: Produce revisable narration, transcription and audio mixes with bundled media components, segment-level speech records and recovery.
---

# Voice Project

Choose only the route needed for the current audio deliverable:

- Text narration, multi-role scripts or a spoken-segment revision: read [narration.md](references/narration.md).
- Recording transcription, local cuts, mixing or export: read [local-audio.md](references/local-audio.md).
- Both routes use [project-format.md](references/project-format.md) when creating or changing project files.

Use the host-bound Skill execution reference for `scripts/audio.js`; invoke script basename `audio` with the operation and a workspace JSON request file as its two arguments. The host supplies Node, FFmpeg/FFprobe and Whisper/model paths. `preflight` needs no request file and reports availability only; it does not install anything. Missing binaries/models require an application repair/update. Never install packages, download models, or replace bundled components during a task.

Write required request JSON with workspace file tools before invoking the script. Use the host command template for one audio operation per command, with a quoted absolute request-file path. Prepare media separately; keep loops and computed paths out of the invocation command because unresolved targets require approval.

Keep one topic-named project directory in the current workspace. Copy supplied media into its `sources/` directory through existing scoped file/shell tools before referencing it. Preserve originals. Saved project paths are relative to this directory; no external paths or symlink escapes. All script request files contain an absolute `project` path to `voice-project.json`. Run project mutations sequentially.

Core capabilities use configured TTS and local codecs/transcription. Background music and effects are supplied files. Voice cloning/design, generated music, source separation, diarization and professional restoration are outside this package's declared capability. Do not silently approximate one of those requests as a supported operation.

Exports retain prior candidates and include a receipt of objective checks. Publish only requested user-facing outputs through the existing file-publication surface. Link audio for playback using the host's file/media result; do not describe generated speech or transcription as personally listened to when no listening evidence exists.
