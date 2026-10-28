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
