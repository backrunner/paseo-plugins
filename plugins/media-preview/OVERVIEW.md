Media Preview plays audio and video inside Paseo workspace file tabs on desktop and web. Open a media file from the file explorer or a file link; choose Media preview from Open with if another viewer is selected.

Use the player's controls to play, pause, seek, adjust volume and, where available, enter fullscreen. Additional controls skip ten seconds, change speed from 0.5× to 2×, and loop playback. Files never autoplay. The interface follows Paseo's theme and language, with English and Simplified Chinese copy.

The plugin recognizes MP4, M4V, WebM, MOV, OGV, MP3, WAV, M4A, AAC, OGG, OGA, Opus, FLAC, AIF and AIFF. Actual decoding depends on the client's browser and operating system. No transcoding or external tools are used.

Requires Paseo 0.16.2 or later within 0.16.x, or 0.17.4 or later within 0.17.x. On mobile, the panel displays an availability message without downloading the file.

Files are read through Paseo's selected-host file handle, including remote-host files. Previews load the complete file and are limited to 1 GiB. File changes reload the preview and reset playback; deletion stops it. Closing the panel or hiding the app stops or pauses playback. The plugin has no server entry, opens no network listener, and sends no files to an external service.
