# Frozen speech fixture

`jfk.wav` is the 11-second JFK inaugural-address sample distributed in
https://github.com/ggml-org/whisper.cpp/blob/v1.7.6/samples/jfk.wav .
Source speech: John F. Kennedy's United States presidential inaugural address,
20 January 1961 (US federal government work). `jfk.txt` is the independently
transcribed expected wording, kept out of model workspaces.

SHA-256: `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`.

The file is checked in so tests never download audio or a speech model.
This one English public-address recording is a pipeline/accuracy regression,
not multilingual or general speech-recognition quality coverage.

## Mandarin processing fixture

`thchs30-D11_750.wav` is the human Mandarin utterance D11_750 from THCHS-30,
released by Dong Wang, Xuewei Zhang and Zhiyong Zhang, CSLT, Tsinghua University.
The original corpus declares Apache-2.0 at https://www.openslr.org/18/;
`THCHS30-LICENSE.txt` preserves the license. This single file was retrieved from
https://huggingface.co/datasets/FluidInference/THCHS-30-tests/resolve/main/audio/D11_750.wav
rather than downloading the full corpus. SHA-256:
`c454c3293383e569cee8ed4c8d040e087d91cd4408e3406e298c332b8fc737bf`.

These two frozen human recordings support reproducible processing fixtures.
Added rumble, noise, sibilant probes, gain changes and pauses are controlled test
perturbations, not naturally recorded defects. They do not establish coverage
of every speaker, language, room or perceptual quality. Tests are offline and
never fetch a recording or model. The corpus transcript is not supplied to
processing actors or used as an audio-processing oracle.
