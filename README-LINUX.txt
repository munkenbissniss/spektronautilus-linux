SPEKTRONAUTILUS FOR LINUX
=========================
The whole website, running on your own computer.

Why use it instead of the website?
  * Converting, loops and filters use the real ffmpeg on your computer. That is much faster than in a browser,
    and there is no memory limit for big files.
  * It starts Chrome/Chromium with settings made for live visuals: windows in the background or behind the
    projector window are never slowed down, and videos can start without extra clicks.
  * The mixers and tools work without internet. (Finding online loops needs internet.)
  * Nothing is uploaded anywhere. The small server only answers to your own computer.

What you need
  * Python 3.8 or newer (almost every Linux has it)
  * ffmpeg (recommended):            sudo apt install ffmpeg
  * Google Chrome or Chromium (recommended; Firefox works for some things but the mixers are made for Chrome)

Install (no root needed)
  tar xzf spektronautilus-linux.tar.gz
  cd spektronautilus-linux
  ./install.sh
Then start "Spektronautilus" from your application menu, or type:  spektronautilus
Or without installing:  ./spektronautilus.py

Options
  spektronautilus --window          open in a normal browser window instead of an app window
  spektronautilus --no-browser      only start the server, then open http://127.0.0.1:8765/ in any browser
  spektronautilus --port 9000       another port (your settings belong to the port, so keep using the same one)
  spektronautilus --path live-dj/   open a page directly (live-dj/, vj-pad/, mixer/, tools/app/ ...)
  SPEKTRO_BROWSER=/usr/bin/chromium spektronautilus     choose the browser

Good to know
  * Your settings, remembered loops and MIDI mappings are kept in a separate browser profile in ~/.config/spektronautilus.
  * Close the window to stop the program. Finished files are kept in the page until you close it, so download them first.
  * Projector: open the output window from the mixer and drag it to the projector screen, then press F for full screen.
  * Uninstall:  ~/.local/share/spektronautilus/uninstall.sh

AI UPSCALING AND SLOW MOTION (optional)
  Install Video2X yourself (AppImage, AUR or your own build; needs a graphics card with Vulkan). Spektronautilus finds it in PATH,
  in ~/Applications, ~/Downloads or ~/.local/bin. Otherwise put its full path on one line in ~/.config/spektronautilus/video2x.txt,
  or start with SPEKTRO_VIDEO2X=/path/to/Video2X.AppImage. The tools "AI upscale" and "AI slow motion" then work.

LOOKING AFTER YOUR COMPUTER
  * Hot graphics card: with an NVIDIA card (nvidia-smi comes with the driver) the AI tools wait between clips while the card is
    at 80 degrees C or more, and show "Cooling down". Use "Rest between clips" under Advanced for a fixed pause as well.
  * Disk: finished and half-finished files live in /tmp/spektronautilus-... while a job runs. Uploads are refused when less than
    500 MB would be left, and folders left behind by a crash are removed next time you start.
  * Start with:  spektronautilus --no-browser  and open http://127.0.0.1:8765/tools/app/#upscale  in a browser of your own if you prefer.

FOR EXPERTS (experimental, off by default)
  * SPEKTRO_CHROME_FLAGS="--flag1 --flag2" spektronautilus     extra Chrome options. Hardware video decoding on NVIDIA needs the
    NVIDIA VA-API driver, LIBVA_DRIVER_NAME=nvidia and  --enable-features=AcceleratedVideoDecodeLinuxGL,VaapiOnNvidiaGPUs
    --ignore-gpu-blocklist  (reported to work on recent drivers, but not tested here; if the video turns black, remove it).
  * The start-up check tests whether ffmpeg can encode with the graphics card (h264_nvenc, h264_vaapi, h264_qsv). The result is
    shown in http://127.0.0.1:8765/api/native (needs the X-Spk header, so use curl -H "X-Spk: 1"). It is not used yet.

LAPTOPS (for example ThinkPad X1 Carbon, Intel graphics) AND POP!_OS
  * First run:  spektronautilus --check   shows what works: ffmpeg, graphics-card encoding, Vulkan, Video2X, browser, disk, battery.
  * Needed packages (Pop!_OS / Ubuntu):  sudo apt install ffmpeg vulkan-tools mesa-vulkan-drivers intel-media-va-driver vainfo
    The AI tools (Video2X, RIFE) use Vulkan, which Intel graphics supports through Mesa. "vulkaninfo --summary" should list your card.
  * Plug in the charger for long jobs. A thin laptop slows down when it gets hot; on battery it slows down even more.
  * The AI queue pauses ("Cooling down") when the processor reaches about 90 degrees C, and you can add "Rest between clips".
  * Browsers installed from the Pop!_OS Shop (Flatpak) or as snap are found. Settings for those live in their own folders
    (~/.var/app/<name>/config/spektronautilus or ~/snap/<name>/common/). If the window does not open, choose one yourself:
    SPEKTRO_BROWSER=/usr/bin/google-chrome-stable spektronautilus
