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
