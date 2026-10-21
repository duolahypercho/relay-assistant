# Original media test fixtures

`three-colors.mp4` is an original generated six-second H.264/AAC test clip. Frames are red for two seconds, blue for two, and green for two. Its soundtrack is a 440 Hz sine tone for three seconds followed by 880 Hz for three. There is no recorded person, copyrighted reference media or spoken sentence. Controlled transcription tests deliberately supply a fixture transcript; they test transport, not speech accuracy.

Reproduce it with an installed FFmpeg:

```sh
ffmpeg -v error -y \
  -f lavfi -i 'color=c=0xd13c32:s=320x180:r=12:d=2' \
  -f lavfi -i 'color=c=0x2869c7:s=320x180:r=12:d=2' \
  -f lavfi -i 'color=c=0x34844a:s=320x180:r=12:d=2' \
  -f lavfi -i 'aevalsrc=0.15*sin(2*PI*if(lt(t\,3)\,440\,880)*t):s=16000:d=6' \
  -filter_complex '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]' \
  -map '[v]' -map 3:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 48k \
  -t 6 -movflags +faststart tests/fixtures/media/three-colors.mp4
```

`quiet-motion.mp4` is the earlier original silent 12-second playback fixture. These files are test data under the repository's MIT license. FFmpeg itself is separately installed and is not distributed in Relay's app bundle.

Original frame-scaling regression clips, generated with FFmpeg from single-color sources (one frame/second, one second, libx264/yuv420p): `portrait.mp4` is blue at 180×320; `large-landscape.mp4` is green at 3200×1800; `anamorphic.mp4` is red at 720×576 with `setsar=16/15`. Their expected square-pixel previews are 180×320, 1280×720, and 720×540. They contain no user or third-party footage.
